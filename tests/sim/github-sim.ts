// Simulated GitHub behind the real `gh` command line. src/ports/github.ts and
// src/ports/host.ts spawn `gh`; the harness puts this script first on PATH for
// the omp process only. Every git-visible fact (branch heads, PR heads, pull
// refs, merges, ancestry) is answered by a real bare repository acting as the
// GitHub remote; the JSON state holds only what git cannot answer (issues,
// PR records, CI statuses, required checks). Requests outside the modelled
// surface are logged as unhandled and answered with a 500 so they fail loudly.

import {appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync, writeSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z, type ZodLikeSchema} from '@oh-my-pi/omptype/zod';
import {evaluate, QueryError, type Args, type Node, type Value} from './graphql.ts';

const ciStateSchema = z.enum(['PENDING', 'SUCCESS', 'FAILURE']);
export type CiState = z.infer<typeof ciStateSchema>;
const repoSchema = z.object({owner: z.string(), name: z.string(), defaultBranch: z.string(), requiredChecks: z.array(z.string())});
export type SimRepo = z.infer<typeof repoSchema>;
const eventSchema = z.object({kind: z.enum(['closed', 'reopened']), id: z.string(), createdAt: z.string()});
type SimEvent = z.infer<typeof eventSchema>;
const commentSchema = z.object({id: z.number(), body: z.string(), author: z.string(), createdAt: z.string()});
const issueSchema = z.object({repo: z.string(), number: z.number(), title: z.string(), body: z.string(), state: z.enum(['OPEN', 'CLOSED']), author: z.string(), createdAt: z.string(), updatedAt: z.string(), events: z.array(eventSchema), children: z.array(z.number()), comments: z.array(commentSchema)});
type SimIssue = z.infer<typeof issueSchema>;
/** One item of the simulated Project; `history` lists every Status it was set to, in order. */
const projectItemSchema = z.object({id: z.string(), repo: z.string(), number: z.number(), status: z.string().nullable(), history: z.array(z.string())});
const prSchema = z.object({repo: z.string(), number: z.number(), headBranch: z.string(), base: z.string(), title: z.string(), body: z.string(), author: z.string(), state: z.enum(['OPEN', 'CLOSED', 'MERGED']), lastHead: z.string(), mergeCommit: z.string().nullable(), mergedAt: z.string().nullable(), updatedAt: z.string()});
type SimPr = z.infer<typeof prSchema>;
const stateSchema = z.object({
  viewer: z.string(),
  nextNumber: z.number(),
  nextEvent: z.number(),
  repos: z.record(z.string(), repoSchema),
  issues: z.array(issueSchema),
  prs: z.array(prSchema),
  /** CI status per commit set by the scenario driver; commits without an entry use ciDefault. */
  ci: z.record(z.string(), ciStateSchema),
  ciDefault: ciStateSchema,
  /** A commit whose tree contains this path fails CI unless ci[sha] says otherwise. */
  ciFailMarker: z.string().nullable(),
  /** PR heads GitHub has not finished computing mergeability for. */
  mergeableUnknown: z.array(z.string()),
  nextComment: z.number(),
  /** The single Project the simulation serves: `owner`/#`number`, single-select field `Status` with STATUS_OPTIONS. */
  project: z.object({owner: z.string(), number: z.number(), items: z.array(projectItemSchema)}),
  /**
   * Once `skip` comments exist, the next created comment is recorded and its request then blocks until `release`
   * exists, as if GitHub applied the write and the response was lost with the process that sent it.
   */
  commentHold: z.object({release: z.string(), skip: z.number()}).nullable(),
});
export type SimState = z.infer<typeof stateSchema>;
const payloadSchema = z.record(z.string(), z.unknown());

const SCRIPT = fileURLToPath(import.meta.url);
const remoteOf = (dir: string, repo: string) => join(dir, 'remotes', `${repo}.git`);
const now = () => new Date().toISOString();

export function git(cwd: string, args: string[], allowFailure = false): {code: number; stdout: string; stderr: string} {
  const run = Bun.spawnSync(['git', ...args], {cwd, env: {...process.env, GIT_AUTHOR_NAME: 'sim', GIT_AUTHOR_EMAIL: 'sim@local', GIT_COMMITTER_NAME: 'sim', GIT_COMMITTER_EMAIL: 'sim@local'}});
  const result = {code: run.exitCode ?? -1, stdout: run.stdout.toString().trim(), stderr: run.stderr.toString().trim()};
  if (result.code !== 0 && !allowFailure) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  return result;
}

/** Runs `work` while holding the simulation lock; every reader and writer of state.json goes through it. */
export function withState<T>(dir: string, work: (state: SimState) => T): T {
  const lock = join(dir, 'lock');
  for (let attempt = 0; ; attempt++) {
    try { mkdirSync(lock); break; } catch {
      if (attempt > 2000) throw new Error('Simulated GitHub lock timed out');
      Bun.sleepSync(5);
    }
  }
  try {
    const file = join(dir, 'state.json');
    const state = stateSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    const result = work(state);
    writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
    renameSync(`${file}.tmp`, file);
    return result;
  } finally { rmdirSync(lock); }
}

/** Creates the remote repositories, issue tree and the `gh` shim; returns the directory to put first on PATH. */
export function seedGitHub(dir: string, seed: {viewer: string; repos: (SimRepo & {files: Record<string, string>})[]; issues: {repo: string; title: string; body: string; children?: number[]}[]; ciDefault: CiState; ciFailMarker: string | null; commentHold: SimState['commentHold']}): string {
  mkdirSync(join(dir, 'bin'), {recursive: true});
  const repos: Record<string, SimRepo> = {};
  for (const repo of seed.repos) {
    const key = `${repo.owner}/${repo.name}`;
    const remote = remoteOf(dir, key);
    mkdirSync(remote, {recursive: true});
    git(remote, ['init', '--bare', '--quiet', `--initial-branch=${repo.defaultBranch}`]);
    const work = join(dir, 'seed', key);
    mkdirSync(work, {recursive: true});
    git(work, ['init', '--quiet', `--initial-branch=${repo.defaultBranch}`]);
    for (const [path, content] of Object.entries(repo.files)) writeFileSync(join(work, path), content);
    git(work, ['add', '-A']);
    git(work, ['commit', '--quiet', '-m', 'baseline']);
    git(work, ['push', '--quiet', remote, `HEAD:refs/heads/${repo.defaultBranch}`]);
    repos[key] = {owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch, requiredChecks: repo.requiredChecks};
  }
  const created = now();
  const state: SimState = {viewer: seed.viewer, nextNumber: 1, nextEvent: 1, repos, issues: [], prs: [], ci: {}, ciDefault: seed.ciDefault, ciFailMarker: seed.ciFailMarker, mergeableUnknown: [],
    nextComment: 4_000_000_001, project: {owner: seed.viewer, number: 1, items: []}, commentHold: seed.commentHold};
  for (const issue of seed.issues) state.issues.push({repo: issue.repo, number: state.nextNumber++, title: issue.title, body: issue.body, state: 'OPEN', author: seed.viewer, createdAt: created, updatedAt: created, events: [], children: issue.children ?? [], comments: []});
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 1));
  writeFileSync(join(dir, 'requests.jsonl'), '');
  const shim = join(dir, 'bin', 'gh');
  writeFileSync(shim, `#!/bin/sh\nSIM_GITHUB_DIR='${dir}' exec '${process.execPath}' '${SCRIPT}' "$@"\n`);
  chmodSync(shim, 0o755);
  return join(dir, 'bin');
}

export const remotePath = remoteOf;

/* ------------------------------------------------------------ git facts */

function branchHead(dir: string, repo: string, branch: string): string | null {
  const result = git(remoteOf(dir, repo), ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], true);
  return result.code === 0 ? result.stdout : null;
}

function isAncestor(dir: string, repo: string, ancestor: string, descendant: string): boolean | null {
  const remote = remoteOf(dir, repo);
  if (git(remote, ['cat-file', '-e', `${ancestor}^{commit}`], true).code !== 0 || git(remote, ['cat-file', '-e', `${descendant}^{commit}`], true).code !== 0) return null;
  return git(remote, ['merge-base', '--is-ancestor', ancestor, descendant], true).code === 0;
}

function ciOf(dir: string, state: SimState, repo: string, sha: string): CiState {
  const explicit = state.ci[sha];
  if (explicit) return explicit;
  if (state.ciFailMarker && git(remoteOf(dir, repo), ['cat-file', '-e', `${sha}:${state.ciFailMarker}`], true).code === 0) return 'FAILURE';
  return state.ciDefault;
}

/** GitHub keeps refs/pull/N/head at the PR branch head; the gate seats fetch it. */
function syncPullRefs(dir: string, state: SimState): void {
  for (const pr of state.prs) {
    if (pr.state !== 'OPEN') continue;
    const head = branchHead(dir, pr.repo, pr.headBranch);
    if (head && head !== pr.lastHead) { pr.lastHead = head; pr.updatedAt = now(); }
    git(remoteOf(dir, pr.repo), ['update-ref', `refs/pull/${pr.number}/head`, pr.lastHead]);
  }
}

/** Issue numbers a PR body closes in its own repository, as GitHub links them. */
function closedIssues(pr: SimPr): number[] {
  const numbers: number[] = [];
  for (const match of pr.body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)|(?:([\w.-]+\/[\w.-]+))?#(\d+))/gi)) {
    const repo = match[1] ?? match[3] ?? pr.repo;
    const number = Number(match[2] ?? match[4]);
    if (repo.toLowerCase() === pr.repo.toLowerCase() && !numbers.includes(number)) numbers.push(number);
  }
  return numbers;
}

/* ------------------------------------------------------------ graph model */

function node(typename: string, fields: Record<string, Value | ((args: Args) => Value)>, allowedArgs: Record<string, string[]> = {}): Node {
  const resolved: Node['fields'] = {};
  for (const [name, field] of Object.entries(fields)) {
    resolved[name] = args => {
      const unknown = Object.keys(args).filter(key => !(allowedArgs[name] ?? []).includes(key));
      if (unknown.length) throw new QueryError(`${typename}.${name} does not take ${unknown.join(', ')}`);
      return typeof field === 'function' ? field(args) : field;
    };
  }
  return {typename, fields: resolved};
}

const PAGE_ARGS = ['first', 'after'];
const connection = (nodes: Value[]): Node => node('Connection', {pageInfo: node('PageInfo', {hasNextPage: false, endCursor: null}), nodes});
const login = (name: string) => node('Actor', {login: name});
const nameNode = (repo: string) => node('Repository', {nameWithOwner: repo});
const reference = (repo: string, number: number) => node('Reference', {number, repository: nameNode(repo)});
const PROJECT_ID = 'PVT_sim', STATUS_FIELD = 'Status', STATUS_FIELD_ID = 'PVTSSF_sim_status';
const STATUS_OPTIONS = ['Todo', 'In Progress', 'Done', 'Superseded'];
const optionId = (name: string) => `opt_${name.replaceAll(' ', '_')}`;
const issueNodeId = (repo: string, number: number) => `I_${repo}#${number}`;

function buildRoot(dir: string, state: SimState): Node {
  const repoNode = (key: string): Node => {
    const repo = state.repos[key]!;
    return node('Repository', {
      nameWithOwner: key,
      viewerPermission: 'ADMIN',
      defaultBranchRef: () => refNode(key, repo.defaultBranch),
      ref: args => refNode(key, String(args.qualifiedName).replace(/^refs\/heads\//, '')),
      issue: args => issueNode(key, Number(args.number)),
      pullRequest: args => prNode(key, Number(args.number)),
      pullRequests: args => connection(state.prs.filter(pr => pr.repo === key && pr.state === 'OPEN' && pr.headBranch === args.headRefName && pr.base === args.baseRefName)
        .map(pr => node('PullRequest', {number: pr.number, repository: nameNode(key), headRepository: nameNode(key)}))),
    }, {ref: ['qualifiedName'], issue: ['number'], pullRequest: ['number'], pullRequests: ['first', 'states', 'headRefName', 'baseRefName', 'after']});
  };
  const ruleNodes = (key: string): Value[] => {
    const required = state.repos[key]!.requiredChecks;
    if (!required.length) return [];
    return [node('RepositoryRule', {
      type: 'REQUIRED_STATUS_CHECKS',
      repositoryRuleset: node('RepositoryRuleset', {name: 'sim-required-checks', enforcement: 'ACTIVE'}),
      parameters: node('RequiredStatusChecksParameters', {strictRequiredStatusChecksPolicy: false,
        requiredStatusChecks: required.map(context => node('StatusCheckConfiguration', {context, integrationId: null}))}),
    })];
  };
  const refNode = (key: string, branch: string): Node | null => {
    const head = branchHead(dir, key, branch);
    return head === null ? null : node('Ref', {name: branch, target: node('Commit', {oid: head}), branchProtectionRule: null,
      rules: () => connection(ruleNodes(key))}, {rules: PAGE_ARGS});
  };
  const issueNode = (key: string, number: number): Node | null => {
    const issue = state.issues.find(item => item.repo === key && item.number === number);
    if (!issue) return null;
    const lastOf = (kind: SimEvent['kind']) => issue.events.filter(event => event.kind === kind).slice(-1)
      .map(event => node(kind === 'closed' ? 'ClosedEvent' : 'ReopenedEvent', {id: event.id, createdAt: event.createdAt}));
    return node('Issue', {
      id: issueNodeId(key, number), number, repository: nameNode(key), title: issue.title, body: issue.body, updatedAt: issue.updatedAt, createdAt: issue.createdAt, state: issue.state, author: login(issue.author),
      subIssues: () => connection(issue.children.map(child => reference(key, child))),
      timelineItems: args => {
        const types = z.array(z.object({enum: z.string()})).parse(args.itemTypes).map(item => item.enum);
        if (args.last !== 1 || types.length !== 1 || !['CLOSED_EVENT', 'REOPENED_EVENT'].includes(types[0]!)) throw new QueryError(`Unsupported timelineItems ${JSON.stringify(args)}`);
        return connection(lastOf(types[0] === 'CLOSED_EVENT' ? 'closed' : 'reopened'));
      },
      closedByPullRequestsReferences: () => connection(state.prs.filter(pr => pr.repo === key && closedIssues(pr).includes(number)).map(pr => reference(key, pr.number))),
      comments: () => connection(issue.comments.map(comment => node('IssueComment', {databaseId: comment.id, body: comment.body}))),
      projectItems: () => connection(state.project.items.filter(item => item.repo === key && item.number === number).map(item => node('ProjectV2Item', {
        id: item.id, project: projectNode(),
        fieldValueByName: args => args.name === STATUS_FIELD && item.status !== null ? node('ProjectV2ItemFieldSingleSelectValue', {name: item.status}) : null,
      }, {fieldValueByName: ['name']}))),
    }, {subIssues: PAGE_ARGS, timelineItems: ['last', 'itemTypes'], closedByPullRequestsReferences: ['first', 'includeClosedPrs', 'after'], comments: PAGE_ARGS, projectItems: PAGE_ARGS});
  };
  const projectNode = (): Node => node('ProjectV2', {
    id: PROJECT_ID, number: state.project.number, owner: node('Organization', {login: state.project.owner}),
    field: args => args.name === STATUS_FIELD ? node('ProjectV2SingleSelectField', {id: STATUS_FIELD_ID, options: STATUS_OPTIONS.map(name => node('ProjectV2SingleSelectFieldOption', {id: optionId(name), name}))}) : null,
  }, {field: ['name']});
  const prNode = (key: string, number: number): Node | null => {
    const pr = state.prs.find(item => item.repo === key && item.number === number);
    if (!pr) return null;
    const repo = state.repos[key]!;
    const base = branchHead(dir, key, pr.base);
    const branch = branchHead(dir, key, pr.headBranch);
    let mergeable = 'MERGEABLE', mergeState = 'CLEAN';
    if (pr.state !== 'OPEN') mergeState = 'UNKNOWN';
    else if (state.mergeableUnknown.includes(pr.lastHead)) { mergeable = 'UNKNOWN'; mergeState = 'UNKNOWN'; }
    else if (base && git(remoteOf(dir, key), ['merge-tree', '--write-tree', base, pr.lastHead], true).code === 1) { mergeable = 'CONFLICTING'; mergeState = 'DIRTY'; }
    return node('PullRequest', {
      number, repository: repoNode(key), title: pr.title, body: pr.body, updatedAt: pr.updatedAt, state: pr.state,
      headRefOid: pr.lastHead, headRefName: pr.headBranch, baseRefName: pr.base,
      headRepository: repoNode(key), headRef: branch === null ? null : node('Ref', {target: node('Commit', {oid: branch})}),
      baseRef: () => refNode(key, pr.base), baseRepository: repoNode(key), author: login(pr.author), maintainerCanModify: false,
      mergeable, mergeStateStatus: mergeState, mergedAt: pr.mergedAt, mergeCommit: pr.mergeCommit ? node('Commit', {oid: pr.mergeCommit}) : null,
      closingIssuesReferences: () => connection(closedIssues(pr).map(issue => reference(key, issue))),
      statusCheckRollup: repo.requiredChecks.length ? node('StatusCheckRollup', {contexts: () => connection(repo.requiredChecks.map(context =>
        node('StatusContext', {context, state: ciOf(dir, state, key, pr.lastHead), targetUrl: null, isRequired: true}, {isRequired: ['pullRequestNumber']})))}, {contexts: PAGE_ARGS}) : null,
    }, {closingIssuesReferences: PAGE_ARGS});
  };
  return node('Query', {
    viewer: login(state.viewer),
    repository: args => state.repos[`${args.owner}/${args.name}`] ? repoNode(`${args.owner}/${args.name}`) : null,
    repositoryOwner: args => args.login === state.project.owner ? node('Organization', {login: state.project.owner, projectV2: args => args.number === state.project.number ? projectNode() : null}, {projectV2: ['number']}) : null,
  }, {repository: ['owner', 'name'], repositoryOwner: ['login']});
}

/** Project writes; each input is checked against the one simulated Project so a drifting port query fails loudly. */
function buildMutation(state: SimState): Node {
  const input = <T>(schema: ZodLikeSchema<T>, args: Args): T => {
    const parsed = z.object({input: schema}).strict().safeParse(args);
    if (!parsed.success) throw new QueryError(`Unsupported mutation input ${JSON.stringify(args)}: ${parsed.error.message}`);
    return parsed.data.input;
  };
  return node('Mutation', {
    addProjectV2ItemById: args => {
      const {contentId} = input(z.object({projectId: z.literal(PROJECT_ID), contentId: z.string()}).strict(), args);
      const issue = state.issues.find(item => issueNodeId(item.repo, item.number) === contentId);
      if (!issue) throw new QueryError(`Unknown project content ${contentId}`);
      let item = state.project.items.find(entry => entry.repo === issue.repo && entry.number === issue.number);
      if (!item) { item = {id: `PVTI_${issue.number}`, repo: issue.repo, number: issue.number, status: null, history: []}; state.project.items.push(item); }
      return node('AddProjectV2ItemByIdPayload', {item: node('ProjectV2Item', {id: item.id})});
    },
    updateProjectV2ItemFieldValue: args => {
      const fields = input(z.object({projectId: z.literal(PROJECT_ID), itemId: z.string(), fieldId: z.literal(STATUS_FIELD_ID), value: z.object({singleSelectOptionId: z.string()}).strict()}).strict(), args);
      const item = state.project.items.find(entry => entry.id === fields.itemId);
      const status = STATUS_OPTIONS.find(name => optionId(name) === fields.value.singleSelectOptionId);
      if (!item || !status) throw new QueryError(`Unknown project item ${fields.itemId} or option ${fields.value.singleSelectOptionId}`);
      item.status = status; item.history.push(status);
      return node('UpdateProjectV2ItemFieldValuePayload', {projectV2Item: node('ProjectV2Item', {id: item.id})});
    },
  }, {addProjectV2ItemById: ['input'], updateProjectV2ItemFieldValue: ['input']});
}

/* ------------------------------------------------------------ REST surface */

type Reply = {status: number; body: unknown};
const reply = (status: number, body: unknown): Reply => ({status, body});

function setIssueState(state: SimState, issue: SimIssue, open: boolean): void {
  const target = open ? 'OPEN' : 'CLOSED';
  if (issue.state === target) return;
  const at = now();
  issue.state = target; issue.updatedAt = at;
  issue.events.push({kind: open ? 'reopened' : 'closed', id: `${open ? 'RE' : 'CE'}_${state.nextEvent++}`, createdAt: at});
}

function rest(dir: string, state: SimState, method: string, endpoint: string, payload: Record<string, unknown>): Reply | null {
  const path = /^repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(endpoint);
  if (!path) return null;
  const key = `${decodeURIComponent(path[1]!)}/${decodeURIComponent(path[2]!)}`;
  const repo = state.repos[key];
  if (!repo) return reply(404, {message: 'Not Found'});
  const rest = path[3] ?? '';
  if (method === 'GET' && rest === '') return reply(200, {full_name: key});
  const compare = /^compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(rest);
  if (method === 'GET' && compare) {
    const [ancestor, descendant] = [compare[1]!, compare[2]!];
    const forward = isAncestor(dir, key, ancestor, descendant);
    if (forward === null) return reply(404, {message: 'Not Found'});
    const status = ancestor === descendant ? 'identical' : forward ? 'ahead' : isAncestor(dir, key, descendant, ancestor) ? 'behind' : 'diverged';
    return reply(200, {status, base_commit: {sha: ancestor}, commits: []});
  }
  const issuePath = /^issues\/(\d+)(\/sub_issues|\/comments)?$/.exec(rest);
  if (issuePath) {
    const issue = state.issues.find(item => item.repo === key && item.number === Number(issuePath[1]));
    if (!issue) return reply(404, {message: 'Not Found'});
    if (method === 'GET' && !issuePath[2]) return reply(200, {id: 100_000 + issue.number, number: issue.number});
    if (method === 'PATCH' && !issuePath[2]) {
      if (typeof payload.state === 'string') setIssueState(state, issue, payload.state === 'open');
      if (typeof payload.body === 'string') { issue.body = payload.body; issue.updatedAt = now(); }
      return reply(200, {number: issue.number});
    }
    if (method === 'POST' && issuePath[2] === '/sub_issues') {
      const child = state.issues.find(item => 100_000 + item.number === payload.sub_issue_id);
      if (!child) return reply(422, {message: 'Unknown sub-issue'});
      if (!issue.children.includes(child.number)) issue.children.push(child.number);
      return reply(201, {number: issue.number});
    }
    if (method === 'POST' && issuePath[2] === '/comments' && typeof payload.body === 'string') {
      const comment = {id: state.nextComment++, body: payload.body, author: state.viewer, createdAt: now()};
      issue.comments.push(comment);
      return reply(201, {id: comment.id, body: comment.body});
    }
  }
  if (method === 'POST' && rest === 'pulls') {
    const head = String(payload.head), base = String(payload.base);
    const headOid = branchHead(dir, key, head);
    if (!headOid || !branchHead(dir, key, base)) return reply(422, {message: 'Head or base branch does not exist'});
    if (state.prs.some(pr => pr.repo === key && pr.headBranch === head && pr.state === 'OPEN')) return reply(422, {message: 'A pull request already exists for this head'});
    const pr: SimPr = {repo: key, number: state.nextNumber++, headBranch: head, base, title: String(payload.title), body: String(payload.body), author: state.viewer, state: 'OPEN', lastHead: headOid, mergeCommit: null, mergedAt: null, updatedAt: now()};
    state.prs.push(pr);
    git(remoteOf(dir, key), ['update-ref', `refs/pull/${pr.number}/head`, headOid]);
    return reply(201, {number: pr.number});
  }
  const pull = /^pulls\/(\d+)$/.exec(rest);
  if (method === 'PATCH' && pull) {
    const pr = state.prs.find(item => item.repo === key && item.number === Number(pull[1]));
    if (!pr) return reply(404, {message: 'Not Found'});
    if (typeof payload.title === 'string') pr.title = payload.title;
    if (typeof payload.body === 'string') pr.body = payload.body;
    pr.updatedAt = now();
    return reply(200, {number: pr.number});
  }
  return null;
}

function merge(dir: string, state: SimState, key: string, number: number, expectedHead: string): string | null {
  const pr = state.prs.find(item => item.repo === key && item.number === number);
  if (!pr || pr.state !== 'OPEN') return 'Pull request is not open';
  if (pr.lastHead !== expectedHead) return 'Head branch was modified';
  const remote = remoteOf(dir, key);
  const base = branchHead(dir, key, pr.base);
  if (!base) return 'Base branch missing';
  const tree = git(remote, ['merge-tree', '--write-tree', base, pr.lastHead], true);
  if (tree.code !== 0) return 'Merge conflict';
  const commit = git(remote, ['commit-tree', tree.stdout.split('\n')[0]!, '-p', base, '-p', pr.lastHead, '-m', `Merge pull request #${number} from ${key.split('/')[0]}/${pr.headBranch}`]).stdout;
  git(remote, ['update-ref', `refs/heads/${pr.base}`, commit, base]);
  const at = now();
  Object.assign(pr, {state: 'MERGED', mergeCommit: commit, mergedAt: at, updatedAt: at});
  if (pr.base === state.repos[key]!.defaultBranch) for (const issueNumber of closedIssues(pr)) {
    const issue = state.issues.find(item => item.repo === key && item.number === issueNumber);
    if (issue) setIssueState(state, issue, false);
  }
  return null;
}

/* ------------------------------------------------------------ gh entry */

function envelope(status: number, body: unknown): string {
  return `HTTP/2.0 ${status} ${status < 300 ? 'OK' : 'Error'}\r\ncontent-type: application/json\r\nx-ratelimit-remaining: 4999\r\n\r\n${JSON.stringify(body)}`;
}

async function main(): Promise<number> {
  const dir = process.env.SIM_GITHUB_DIR;
  if (!dir) throw new Error('SIM_GITHUB_DIR is required');
  const argv = process.argv.slice(2);
  const log = (entry: Record<string, unknown>) => appendFileSync(join(dir, 'requests.jsonl'), `${JSON.stringify({at: now(), argv, ...entry})}\n`);
  if (argv[0] === 'repo' && argv[1] === 'clone') {
    const [repo, target] = [argv[2]!, argv[3]!];
    if (!existsSync(remoteOf(dir, repo))) { log({unhandled: true}); process.stderr.write(`Simulated GitHub has no repository ${repo}\n`); return 1; }
    git(process.cwd(), ['clone', '--bare', '--quiet', remoteOf(dir, repo), target]);
    log({status: 0});
    return 0;
  }
  if (argv[0] === 'pr' && argv[1] === 'merge') {
    const repo = argv[argv.indexOf('--repo') + 1]!, head = argv[argv.indexOf('--match-head-commit') + 1]!;
    const problem = withState(dir, state => { syncPullRefs(dir, state); return merge(dir, state, repo, Number(argv[2]), head); });
    log({status: problem ? 1 : 0, problem});
    if (problem) { process.stderr.write(`${problem}\n`); return 1; }
    return 0;
  }
  if (argv[0] === 'api') {
    const method = argv[argv.indexOf('--method') + 1]!;
    const endpoint = argv.find((arg, index) => index > 0 && !arg.startsWith('-') && argv[index - 1] !== '--method' && argv[index - 1] !== '-H')!;
    const raw = argv.includes('--input') ? await Bun.stdin.text() : '';
    const payload = raw.trim() ? payloadSchema.parse(JSON.parse(raw)) : {};
    const {answer, hold} = withState(dir, state => {
      syncPullRefs(dir, state);
      const existing = state.issues.reduce((count, issue) => count + issue.comments.length, 0);
      const evaluated = (): Reply => {
        if (endpoint === 'graphql') {
          try { return reply(200, {data: evaluate(String(payload.query), {query: buildRoot(dir, state), mutation: buildMutation(state)})}); }
          catch (error) { if (error instanceof QueryError) return reply(500, {message: `Simulated GitHub cannot answer: ${error.message}`, unhandled: true}); throw error; }
        }
        return rest(dir, state, method, endpoint, payload) ?? reply(500, {message: `Simulated GitHub has no route for ${method} ${endpoint}`, unhandled: true});
      };
      return {answer: evaluated(), hold: state.commentHold?.skip === existing ? state.commentHold : null};
    });
    const unhandled = typeof answer.body === 'object' && answer.body !== null && 'unhandled' in answer.body;
    log({method, endpoint, status: answer.status, ...(unhandled ? {unhandled: true, detail: answer.body} : {}), ...(endpoint === 'graphql' ? {query: payload.query} : {payload})});
    // The comment is already recorded; its response waits for the driver's release, outside the state lock.
    if (hold && method === 'POST' && /\/issues\/\d+\/comments$/.test(endpoint) && answer.status === 201)
      while (!existsSync(hold.release)) await Bun.sleep(100);
    writeSync(1, envelope(answer.status, answer.body));
    return 0;
  }
  log({unhandled: true});
  process.stderr.write(`Simulated GitHub does not implement gh ${argv.join(' ')}\n`);
  return 1;
}

if (import.meta.main) process.exit(await main());
