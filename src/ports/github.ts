import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z, type ZodLikeSchema } from '@oh-my-pi/omptype/zod';
import * as m from '../domain/model.ts';
import { logger } from '@oh-my-pi/pi-coding-agent';
import { parseMarker } from '../pm/markers.ts';
import type { GitHubPort, PmProjectSource, PrWrite } from './contracts.ts';

// Source schemas deliberately differ from domain schemas. Null/incomplete source data
// must be rejected before it can become an apparently complete Facts read.
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// Match the source ISO grammar before Date.parse can normalize invalid dates.
const isoDateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
const isoDateTime = new RegExp(`^${isoDateSource}T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$`);
const date = z.string().regex(isoDateTime, 'Invalid ISO datetime').transform(value => Date.parse(value));
const nameWithOwner = z.string().regex(/^[^/]+\/[^/]+$/);
const repositoryName = z.object({ nameWithOwner });
const permission = z.enum(['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ', 'NONE']);
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
function connection<Element>(node: ZodLikeSchema<Element>) {
  return z.object({ nodes: z.array(node), pageInfo });
}
const sourceRefFields = { number: positive, repository: repositoryName };
const sourceRef = z.object(sourceRefFields);
const sourceHeadPrRef = z.object({ ...sourceRefFields, headRepository: repositoryName.nullable() });
const checkIdentity = z.object({ context: z.string().min(1), app: z.object({ databaseId: positive }).nullable() });
const rule = z.object({
  type: z.string().min(1), repositoryRuleset: z.object({ name: z.string(), enforcement: z.string() }),
  parameters: z.object({
    __typename: z.string(), strictRequiredStatusChecksPolicy: z.boolean().optional(),
    requiredStatusChecks: z.array(z.object({ context: z.string().min(1), integrationId: positive.nullable() })).optional(),
  }).nullable(),
});
const sourceBranch = z.object({ name: z.string().min(1), target: z.object({ oid: m.shaSchema }),
  branchProtectionRule: z.object({ requiresStatusChecks: z.boolean(), requiresStrictStatusChecks: z.boolean(), requiredStatusChecks: z.array(checkIdentity).nullable() }).nullable(),
  rules: connection(rule),
});
const sourceRepo = z.object({ nameWithOwner, viewerPermission: permission,
  defaultBranchRef: sourceBranch,
});
const sourceContext = z.union([
  z.object({ __typename: z.literal('CheckRun'), databaseId: positive, name: z.string().min(1), status: z.string(), conclusion: z.string().nullable(), detailsUrl: z.string().nullable(), isRequired: z.boolean(),
    checkSuite: z.object({ databaseId: positive, commit: z.object({ oid: m.shaSchema }), app: z.object({ databaseId: positive, slug: z.string() }).nullable(),
      workflowRun: z.object({ databaseId: positive, runAttempt: positive }).nullable(),
    }),
  }),
  z.object({ __typename: z.literal('StatusContext'), context: z.string().min(1), state: z.string(), isRequired: z.boolean(), targetUrl: z.string().nullable() }),
]);
const sourcePr = z.object({ number: positive, repository: sourceRepo, title: z.string().min(1), body: z.string(), updatedAt: date,
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']), headRefOid: m.shaSchema, headRefName: z.string().min(1), baseRefName: z.string().min(1),
  headRepository: z.object({ nameWithOwner, viewerPermission: permission }),
  headRef: z.object({ target: z.object({ oid: m.shaSchema }) }).nullable(), baseRef: sourceBranch.nullable(), baseRepository: sourceRepo,
  author: z.object({ login: z.string().min(1) }), maintainerCanModify: z.boolean(), mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']), mergeStateStatus: z.string(),
  mergedAt: date.nullable(), mergeCommit: z.object({ oid: m.shaSchema }).nullable(), closingIssuesReferences: connection(sourceRef),
  statusCheckRollup: z.object({ contexts: connection(sourceContext) }).nullable(),
});
type SourcePr = z.infer<typeof sourcePr>;
const lifecycle = z.object({ id: z.string().min(1), createdAt: date });
const issueRead = z.object({ number: positive, repository: repositoryName, body: z.string(), updatedAt: date, state: z.enum(['OPEN', 'CLOSED']),
  subIssues: connection(sourceRef), lastClose: z.object({ nodes: z.array(lifecycle).max(1) }), lastReopen: z.object({ nodes: z.array(lifecycle).max(1) }),
  closedByPullRequestsReferences: connection(sourceRef),
});
// Read only when PM is on: every comment (markers are found by their last line) and the issue's Project items.
const sourceComment = z.object({ databaseId: positive, body: z.string() });
const sourceProjectItem = z.object({ id: z.string().min(1), project: z.object({ number: positive, owner: z.object({ login: z.string().min(1) }) }),
  fieldValueByName: z.object({ __typename: z.literal('ProjectV2ItemFieldSingleSelectValue'), name: z.string().min(1) }).nullable() });
const graphEnvelope = z.object({ data: z.record(z.string(), z.unknown()).optional(), errors: z.array(z.object({ message: z.string(), type: z.string().optional() })).optional() });
type HttpResponse = { status: number; headers: ReadonlyMap<string, string>; body: unknown };
class SourceFailure extends Error {
  constructor(readonly detail: m.PortError) { super(detail.message); }
}
const fail = (kind: Exclude<m.PortError['kind'], 'rateLimited'>, message: string): never => { throw new SourceFailure({ kind, message: sanitize(message) }); };
function sanitize(message: string): string {
  return message.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[redacted]')
    .replace(/(authorization|token|password|secret)(["'\s:=]+)([^\s,}\n]+)/gi, '$1$2[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 4000);
}
function decode<T>(schema: ZodLikeSchema<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return fail('invalidResponse', `${label}: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return parsed.data;
}
function repo(value: { nameWithOwner: string }): m.Repo {
  const [owner, name] = value.nameWithOwner.split('/');
  return decode(m.repoSchema, { owner, name }, 'repository identity');
}
const repoKey = (value: m.Repo) => `${value.owner}/${value.name}`.toLowerCase();
const refKey = (value: m.IssueRef) => `${repoKey(value.repo)}#${value.number}`;
const ref = (value: z.infer<typeof sourceRef>): m.IssueRef => ({ repo: repo(value.repository), number: value.number });
function sameBranchState(left:m.BranchSnapshot['state'],right:m.BranchSnapshot['state']):boolean {
  switch(left.kind){
    case 'missing':return right.kind==='missing';
    case 'present':return right.kind==='present'&&left.head===right.head;
  }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => JSON.stringify(value);
const pathRepo = (value: m.Repo) => `repos/${encodeURIComponent(value.owner)}/${encodeURIComponent(value.name)}`;
const PAGE = 10;
const afterClause = (cursor: string | null) => (cursor === null ? '' : `,after:${quote(cursor)}`);
const ruleNodeFields = `type repositoryRuleset { name enforcement } parameters { __typename ... on RequiredStatusChecksParameters { strictRequiredStatusChecksPolicy requiredStatusChecks { context integrationId } } }`;
// One page of each drilled connection; a follow-up page repeats every argument verbatim.
const rulesPage = (cursor: string | null) => `rules(first:${PAGE}${afterClause(cursor)}) { pageInfo { hasNextPage endCursor } nodes { ${ruleNodeFields} } }`;
const referenceFields = 'number repository { nameWithOwner }';
const subIssuesPage = (cursor: string | null) => `subIssues(first:${PAGE}${afterClause(cursor)}) { pageInfo { hasNextPage endCursor } nodes { ${referenceFields} } }`;
const closedByPage = (cursor: string | null) => `closedByPullRequestsReferences(first:${PAGE},includeClosedPrs:true${afterClause(cursor)}) { pageInfo { hasNextPage endCursor } nodes { ${referenceFields} } }`;
const closingRefsPage = (cursor: string | null) => `closingIssuesReferences(first:${PAGE}${afterClause(cursor)}) { pageInfo { hasNextPage endCursor } nodes { ${referenceFields} } }`;
const contextsPage = (number: number, cursor: string | null) => {
  const required = `isRequired(pullRequestNumber:${number})`;
  return `contexts(first:${PAGE}${afterClause(cursor)}) { pageInfo { hasNextPage endCursor } nodes { __typename ... on CheckRun { databaseId name status conclusion detailsUrl ${required} checkSuite { databaseId commit { oid } app { databaseId slug } workflowRun { databaseId runAttempt } } } ... on StatusContext { context state targetUrl ${required} } } }`;
};
const branchFields = `name target { oid } branchProtectionRule { requiresStatusChecks requiresStrictStatusChecks requiredStatusChecks { context app { databaseId } } } ${rulesPage(null)}`;
const repoFields = `nameWithOwner viewerPermission defaultBranchRef { ${branchFields} }`;
function prFields(number: number): string {
  return `number repository { ${repoFields} } title body updatedAt state headRefOid headRefName baseRefName
    headRepository { nameWithOwner viewerPermission } headRef { target { oid } } baseRef { ${branchFields} } baseRepository { ${repoFields} }
    author { login } maintainerCanModify mergeable mergeStateStatus mergedAt mergeCommit { oid }
    ${closingRefsPage(null)}
    statusCheckRollup { ${contextsPage(number, null)} }`;
}
// Linked PRs need a second, explicitly numbered query, not a fabricated isRequired.
const issueFields = `${referenceFields} body updatedAt state ${subIssuesPage(null)}
 lastClose:timelineItems(last:1,itemTypes:[CLOSED_EVENT]) { nodes { ... on ClosedEvent { id createdAt } } }
 lastReopen:timelineItems(last:1,itemTypes:[REOPENED_EVENT]) { nodes { ... on ReopenedEvent { id createdAt } } }
 ${closedByPage(null)}`;
const commentsPage = (cursor: string | null) => `comments(first:50${afterClause(cursor)}) { pageInfo { hasNextPage endCursor } nodes { databaseId body } }`;
const projectItemsPage = (status: string, cursor: string | null) => `projectItems(first:20${afterClause(cursor)}) { pageInfo { hasNextPage endCursor } nodes { id project { number owner { __typename ... on Organization { login } ... on User { login } } } fieldValueByName(name:${quote(status)}) { __typename ... on ProjectV2ItemFieldSingleSelectValue { name } } } }`;
function issueSnapshot(source: z.infer<typeof issueRead>, pm: m.IssuePm | null): m.IssueSnapshot {
  const closed = source.lastClose.nodes[0], reopened = source.lastReopen.nodes[0];
  return { ref: ref(source), body: source.body, bodyHash: digest(source.body), updatedAt: source.updatedAt,
    state: source.state === 'OPEN' ? 'open' : 'closed',
    lastClose: closed ? { id: closed.id, at: closed.createdAt } : null,
    lastReopen: reopened ? { id: reopened.id, at: reopened.createdAt } : null,
    children: source.subIssues.nodes.map(ref), pm };
}
function requirements(value: z.infer<typeof sourceBranch>): m.MergeRequirements {
  const required: m.RequiredCheckIdentity[] = [];
  let strict = false;
  const add = (name: string, id: number | null) => {
    const identity: m.RequiredCheckIdentity = { name, source: id === null ? { kind: 'any' } : { kind: 'app', id } };
    if (!required.some(item => JSON.stringify(item) === JSON.stringify(identity))) required.push(identity);
  };
  const classic = value.branchProtectionRule;
  if (classic?.requiresStatusChecks) {
    const statusChecks = classic.requiredStatusChecks;
    if (statusChecks === null) return fail('invalidResponse', 'Required classic check identities unavailable');
    for (const check of statusChecks) add(check.context, check.app?.databaseId ?? null);
    strict = classic.requiresStrictStatusChecks;
  }
  const constraints: string[] = [];
  for (const item of value.rules.nodes) {
    constraints.push(`${item.type}:${item.repositoryRuleset.enforcement}:${item.repositoryRuleset.name}:${JSON.stringify(item.parameters)}`);
    if (item.type === 'REQUIRED_STATUS_CHECKS') {
      const parameters = item.parameters;
      if (parameters === null || parameters.__typename !== 'RequiredStatusChecksParameters')
        return fail('invalidResponse', 'Required-status-check rule parameters missing');
      const statusChecks = parameters.requiredStatusChecks;
      const strictPolicy = parameters.strictRequiredStatusChecksPolicy;
      if (statusChecks === undefined || strictPolicy === undefined)
        return fail('invalidResponse', 'Required-status-check rule parameters missing');
      for (const check of statusChecks) add(check.context, check.integrationId);
      strict ||= strictPolicy;
    }
  }
  return { required, strict, constraints: constraints.sort() };
}
function checks(value: SourcePr, rules: m.MergeRequirements): m.ChecksSnapshot {
  const rollup = value.statusCheckRollup;
  if (!rules.required.length) return { kind: 'passing', required: [] };
  const failures: m.CheckFailure[] = [];
  const pending: { identity: m.RequiredCheckIdentity; head: string }[] = [];
  for (const identity of rules.required) {
    const matching = (rollup?.contexts.nodes ?? []).filter(item => item.__typename === 'CheckRun'
      ? item.name === identity.name && item.checkSuite.commit.oid === value.headRefOid && (identity.source.kind === 'any' || item.checkSuite.app?.databaseId === identity.source.id)
      : item.context === identity.name && identity.source.kind === 'any');
    if (matching.length > 1) return { kind: 'unknown', reason: `Ambiguous required check ${identity.name}; multiple matching source observations` };
    const item = matching[0];
    if (!item && identity.source.kind === 'app' && rollup?.contexts.nodes.some(context => context.__typename === 'StatusContext' && context.context === identity.name))
      return { kind: 'unknown', reason: `Required status ${identity.name} has no source-verifiable app identity` };
    if (!item) { pending.push({ identity, head: value.headRefOid }); continue; }
    if (item.__typename === 'StatusContext') {
      if (item.state === 'SUCCESS') continue;
      if (item.state === 'PENDING' || item.state === 'EXPECTED') pending.push({ identity, head: value.headRefOid });
      else failures.push({ kind: 'status', identity, context: item.context, sha: value.headRefOid });
      continue;
    }
    if (item.status !== 'COMPLETED') { pending.push({ identity, head: value.headRefOid }); continue; }
    if (item.conclusion === 'SUCCESS' || item.conclusion === 'NEUTRAL' || item.conclusion === 'SKIPPED') continue;
    const run = item.checkSuite.workflowRun;
    if (!run || item.checkSuite.app?.slug !== 'github-actions') {
      failures.push({ kind: 'status', identity, context: item.name, sha: value.headRefOid }); continue;
    }
    // A check run ID is NOT a job ID. The exact job comes from the Actions URL;
    // the workflow linkage must agree with the structured source workflowRun.
    const job = item.detailsUrl?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)(?:\?.*)?$/);
    if (!job || Number(job[3]) !== run.databaseId || `${job[1]}/${job[2]}`.toLowerCase() !== repoKey(repo(value.repository)))
      return { kind: 'unknown', reason: `Required Actions check ${item.name} has no corroborated workflow/job URL` };
    failures.push({ kind: 'actions', identity, checkRunId: item.databaseId, workflowRunId: run.databaseId, jobId: Number(job[4]), runAttempt: run.runAttempt, head: value.headRefOid });
  }
  if (failures.length) return decode(m.checksSchema, { kind: 'failing', required: failures }, 'checks');
  if (pending.length) return decode(m.checksSchema, { kind: 'pending', required: pending }, 'checks');
  return { kind: 'passing', required: rules.required };
}

/** Matches `gh api --include` output: one header line, a header block, then the body. */
const GH_RESPONSE_PREFIX = /^HTTP\/[^\s]+ (\d+)[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n/;
/** Upper bound on `ancestry` containment entries: a miss costs at most one compare request. */
const ANCESTRY_LIMIT = 500;
/** `pm` names the Project and Status field PM integration reads and writes; null keeps every read and write PM-free. */
export function createGitHubPort(options: { actor?: string; pm: PmProjectSource | null } = { pm: null }): GitHubPort {
  let blockedUntil = 0;
  const ancestry = new Map<string, 'contains' | 'notContained'>();
  const rememberAncestry = (key: string, value: 'contains' | 'notContained'): void => {
    // Refresh recency so eviction drops the least recently used entry.
    if (ancestry.has(key)) ancestry.delete(key);
    ancestry.set(key, value);
    if (ancestry.size > ANCESTRY_LIMIT) {
      const oldest = ancestry.keys().next();
      if (!oldest.done) ancestry.delete(oldest.value);
    }
  };
  const pm = options.pm;
  const issueSelection = pm ? `${issueFields} ${commentsPage(null)} ${projectItemsPage(pm.statusField, null)}` : issueFields;
  async function result<T>(action: () => Promise<T>): Promise<m.Result<T, m.PortError>> {
    try { return { ok: true, value: await action() }; }
    catch (error) { return { ok: false, error: error instanceof SourceFailure ? error.detail : { kind: 'invalidResponse', message: sanitize(error instanceof Error ? error.message : String(error)) } }; }
  }
  async function command(args: string[], input: string | undefined, write: boolean): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string; code: number; timedOut: boolean }>();
    const child = spawn('gh', args, { env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_DEBUG: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: string[] = [], stderr: string[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 60_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout.push(chunk); }); child.stderr.on('data', (chunk: string) => { stderr.push(chunk); });
    child.on('error', error => { clearTimeout(timeout); reject(new SourceFailure({ kind: write ? 'uncertainOutcome' : 'unavailable', message: sanitize(error.message) })); });
    child.on('close', code => { clearTimeout(timeout); resolve({ stdout: stdout.join(''), stderr: stderr.join(''), code: code ?? -1, timedOut }); });
    child.stdin.end(input);
    return promise;
  }
  function sourceError(response: HttpResponse, write: boolean, detail: string): never {
    const message = sanitize(`${response.status}: ${detail}`);
    const lower = message.toLowerCase();
    const retryAfter = response.headers.get('retry-after');
    const primary = response.headers.get('x-ratelimit-remaining') === '0';
    const reset = response.headers.get('x-ratelimit-reset');
    if (response.status === 429 || (response.status === 403 && /rate limit|secondary|abuse/.test(lower))) {
      const retryDate = retryAfter === undefined ? NaN : /^\d+$/.test(retryAfter) ? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter);
      const resetAt = Number.isFinite(retryDate) ? retryDate : primary && reset && /^\d+$/.test(reset) ? Number(reset) * 1000 : NaN;
      if (Number.isFinite(resetAt)) { blockedUntil = resetAt; throw new SourceFailure({ kind: 'rateLimited', message, resetAt }); }
      return fail('unavailable', message);
    }
    if (response.status === 401 || response.status === 403) return fail('permission', message);
    if (response.status === 409 || response.status === 412 || response.status === 422 || response.status === 405) return fail('precondition', message);
    if (response.status >= 500 || response.status === 408 || response.status === 0) return fail(write ? 'uncertainOutcome' : 'unavailable', message);
    return fail(response.status === 404 ? 'unavailable' : 'precondition', message);
  }
  async function api(endpoint: string, method: string, payload: unknown, cause: string, allowNotFound = false, write = method !== 'GET' && endpoint !== 'graphql'): Promise<HttpResponse> {
    if (Date.now() < blockedUntil) throw new SourceFailure({ kind: 'rateLimited', message: 'Source rate limit reset has not been reached', resetAt: blockedUntil });
    const args = ['api', '--include', '--method', method, endpoint, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
    if (payload !== undefined) args.push('--input', '-');
    const output = await command(args, payload === undefined ? undefined : JSON.stringify(payload), write);
    // Prefix-only match: the body is everything after the header separator, never a
    // captured copy. `match` carries the status and header block; `raw` aliases the
    // response tail without copying it.
    const match = GH_RESPONSE_PREFIX.exec(output.stdout);
    const headers = new Map<string, string>();
    for (const line of (match?.[2] ?? '').split(/\r?\n/)) { const colon = line.indexOf(':'); if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()); }
    let body: unknown = null;
    const raw = match ? output.stdout.slice(match[0].length) : output.stdout;
    const trimmed = raw.trim();
    try { if (trimmed) body = JSON.parse(trimmed); } catch { /* Classified below using the actual status and source response. */ }
    const response: HttpResponse = { status: match ? Number(match[1]) : 0, headers, body };
    if (output.timedOut) fail(write ? 'uncertainOutcome' : 'unavailable', `${method} ${endpoint}: request timed out`);
    if (allowNotFound && response.status === 404) return response;
    if (output.code !== 0 || response.status < 200 || response.status >= 300) {
      const detail = z.object({ message: z.string() }).safeParse(body);
      sourceError(response, write, `${cause}: ${detail.success ? detail.data.message : output.stderr || raw}`);
    }
    if (trimmed && body === null) fail(write ? 'uncertainOutcome' : 'invalidResponse', `${method} ${endpoint}: malformed JSON response`);
    return response;
  }
  /** `write` marks a mutation: a lost response is an uncertain outcome, not an unavailable read. */
  async function graph(query: string, cause: string, write = false): Promise<Record<string, unknown>> {
    const response = await api('graphql', 'POST', { query }, cause, false, write);
    const envelope = decode(graphEnvelope, response.body, 'GraphQL envelope');
    if (envelope.errors?.length) {
      const errors = envelope.errors.map(item => `${item.type ?? 'GraphQL'}: ${item.message}`).join('; ');
      if (envelope.errors.some(item => item.type === 'FORBIDDEN')) fail('permission', errors);
      if (envelope.errors.some(item => item.type === 'RATE_LIMITED')) sourceError({ ...response, status: 403 }, false, `rate limit: ${errors}`);
      fail('invalidResponse', errors);
    }
    const data = envelope.data;
    if (data === undefined) return fail('invalidResponse', 'GraphQL response missing data');
    return data;
  }
  const selection = (value: m.Repo, fields: string) => `repository(owner:${quote(value.owner)},name:${quote(value.name)}) { ${fields} }`;
  type SourcePage<Element> = { nodes: Element[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  // Drain one source connection to its final page. Each follow-up restates the
  // parent identity and the same anchor the first page was bound to, so a later
  // page can never be appended to a different issue, PR, branch or commit.
  async function drain<Element>(options: {
    label: string; cause: string; first: SourcePage<Element>; anchor: string;
    next: (after: string) => string;
    read: (data: Record<string, unknown>) => { anchor: string; connection: SourcePage<Element> };
  }): Promise<Element[]> {
    const nodes = [...options.first.nodes];
    const cursors = new Set<string>();
    let connection: SourcePage<Element> = options.first;
    while (connection.pageInfo.hasNextPage) {
      const cursor = connection.pageInfo.endCursor;
      if (cursor === null || cursors.has(cursor)) return fail('invalidResponse', `${options.label}: pagination cursor did not advance`);
      cursors.add(cursor);
      const page = options.read(await graph(`query { ${options.next(cursor)} }`, options.cause));
      if (page.anchor !== options.anchor) fail('invalidResponse', `${options.label}: source identity changed during pagination`);
      nodes.push(...page.connection.nodes);
      connection = page.connection;
    }
    return nodes;
  }
  async function completeIssueConnections(source: z.infer<typeof issueRead>, cause: string): Promise<void> {
    const repository = repo(source.repository);
    const anchor = `${repoKey(repository)}#${source.number}`;
    if (source.subIssues.pageInfo.hasNextPage) {
      const nodes = await drain({
        label: `${anchor} subissues`, cause, first: source.subIssues, anchor,
        next: after => selection(repository, `issue(number:${source.number}) { number repository { nameWithOwner } ${subIssuesPage(after)} }`),
        read: data => {
          const issue = decode(z.object({ repository: z.object({ issue: z.object({ ...sourceRefFields, subIssues: connection(sourceRef) }) }) }), data, 'subissues page').repository.issue;
          return { anchor: `${repoKey(repo(issue.repository))}#${issue.number}`, connection: issue.subIssues };
        },
      });
      source.subIssues = { ...source.subIssues, nodes };
    }
    if (source.closedByPullRequestsReferences.pageInfo.hasNextPage) {
      const nodes = await drain({
        label: `${anchor} closing PR links`, cause, first: source.closedByPullRequestsReferences, anchor,
        next: after => selection(repository, `issue(number:${source.number}) { number repository { nameWithOwner } ${closedByPage(after)} }`),
        read: data => {
          const issue = decode(z.object({ repository: z.object({ issue: z.object({ ...sourceRefFields, closedByPullRequestsReferences: connection(sourceRef) }) }) }), data, 'closing PR links page').repository.issue;
          return { anchor: `${repoKey(repo(issue.repository))}#${issue.number}`, connection: issue.closedByPullRequestsReferences };
        },
      });
      source.closedByPullRequestsReferences = { ...source.closedByPullRequestsReferences, nodes };
    }
  }
  /** The issue's item in the configured Project, every page of its items drained. */
  async function projectItem(raw: unknown, project: PmProjectSource, cause: string): Promise<m.IssuePm['item']> {
    const source = decode(z.object({ ...sourceRefFields, projectItems: connection(sourceProjectItem) }), raw, 'issue project items');
    const repository = repo(source.repository), anchor = `${repoKey(repository)}#${source.number}`;
    const items = await drain({
      label: `${anchor} project items`, cause, first: source.projectItems, anchor,
      next: after => selection(repository, `issue(number:${source.number}) { number repository { nameWithOwner } ${projectItemsPage(project.statusField, after)} }`),
      read: data => {
        const issue = decode(z.object({ repository: z.object({ issue: z.object({ ...sourceRefFields, projectItems: connection(sourceProjectItem) }) }) }), data, 'project items page').repository.issue;
        return { anchor: `${repoKey(repo(issue.repository))}#${issue.number}`, connection: issue.projectItems };
      },
    });
    const item = items.find(node => node.project.number === project.number && node.project.owner.login.toLowerCase() === project.owner.toLowerCase());
    return item ? { id: item.id, status: item.fieldValueByName?.name ?? null } : null;
  }
  /** The issue's marker comments, every page drained, and its Project item; invalid markers are logged and ignored. */
  async function issuePm(raw: unknown, project: PmProjectSource, cause: string): Promise<m.IssuePm> {
    const source = decode(z.object({ ...sourceRefFields, comments: connection(sourceComment) }), raw, 'issue comments');
    const repository = repo(source.repository), anchor = `${repoKey(repository)}#${source.number}`;
    const comments = await drain({
      label: `${anchor} comments`, cause, first: source.comments, anchor,
      next: after => selection(repository, `issue(number:${source.number}) { number repository { nameWithOwner } ${commentsPage(after)} }`),
      read: data => {
        const issue = decode(z.object({ repository: z.object({ issue: z.object({ ...sourceRefFields, comments: connection(sourceComment) }) }) }), data, 'comments page').repository.issue;
        return { anchor: `${repoKey(repo(issue.repository))}#${issue.number}`, connection: issue.comments };
      },
    });
    const markers: m.IssuePm['markers'] = [];
    for (const comment of comments) {
      const read = parseMarker(comment.databaseId, comment.body);
      if (read.kind === 'marker') markers.push(read.fact);
      else if (read.kind === 'invalid') logger.warn('Dispatch ignored an invalid PM marker', { issue: anchor, reason: read.reason });
    }
    return { markers, item: await projectItem(raw, project, cause) };
  }
  async function completePrConnections(source: SourcePr, cause: string): Promise<void> {
    const repository = repo(source.repository);
    const anchor = `${repoKey(repository)}#${source.number}`;
    if (source.closingIssuesReferences.pageInfo.hasNextPage) {
      const nodes = await drain({
        label: `${anchor} closing issues`, cause, first: source.closingIssuesReferences, anchor,
        next: after => selection(repository, `pullRequest(number:${source.number}) { number ${closingRefsPage(after)} }`),
        read: data => {
          const pull = decode(z.object({ repository: z.object({ pullRequest: z.object({ number: positive, closingIssuesReferences: connection(sourceRef) }) }) }), data, 'closing issues page').repository.pullRequest;
          return { anchor: `${repoKey(repository)}#${pull.number}`, connection: pull.closingIssuesReferences };
        },
      });
      source.closingIssuesReferences = { ...source.closingIssuesReferences, nodes };
    }
    const rollup = source.statusCheckRollup;
    // Checks are pinned to the first page's head: a page observed at a different
    // headRefOid is refused instead of concatenated into one checks list.
    if (rollup?.contexts.pageInfo.hasNextPage) {
      const nodes = await drain({
        label: `${anchor} checks`, cause, first: rollup.contexts, anchor: `${anchor}@${source.headRefOid}`,
        next: after => selection(repository, `pullRequest(number:${source.number}) { number headRefOid ${contextsPage(source.number, after)} }`),
        read: data => {
          const pull = decode(z.object({ repository: z.object({ pullRequest: z.object({ number: positive, headRefOid: m.shaSchema, statusCheckRollup: z.object({ contexts: connection(sourceContext) }).nullable() }) }) }), data, 'PR checks page').repository.pullRequest;
          const contexts = pull.statusCheckRollup?.contexts;
          if (!contexts) return fail('invalidResponse', `${anchor} checks: status check rollup disappeared during pagination`);
          return { anchor: `${repoKey(repository)}#${pull.number}@${pull.headRefOid}`, connection: contexts };
        },
      });
      source.statusCheckRollup = { ...rollup, contexts: { ...rollup.contexts, nodes } };
    }
  }
  async function completeBranchRules(repository: m.Repo, branch: z.infer<typeof sourceBranch>, cause: string): Promise<void> {
    if (!branch.rules.pageInfo.hasNextPage) return;
    const label = `branch rules ${repoKey(repository)} ${branch.name}`;
    const nodes = await drain({
      label, cause, first: branch.rules, anchor: `${branch.name}@${branch.target.oid}`,
      // A branch's rules are properties of the branch, so the follow-up pins the
      // exact ref name and head commit instead of re-resolving a moving default.
      next: after => selection(repository, `ref(qualifiedName:${quote(`refs/heads/${branch.name}`)}) { name target { oid } ${rulesPage(after)} }`),
      read: data => {
        const source = decode(z.object({ repository: z.object({ ref: z.object({ name: z.string().min(1), target: z.object({ oid: m.shaSchema }), rules: connection(rule) }).nullable() }) }), data, 'branch rules page').repository.ref;
        if (source === null) return fail('invalidResponse', `${label}: branch no longer exists during pagination`);
        return { anchor: `${source.name}@${source.target.oid}`, connection: source.rules };
      },
    });
    branch.rules = { ...branch.rules, nodes };
  }
  async function collect(scope: m.SourceScope, cause: string): Promise<m.Facts> {
    const issues: m.IssueSnapshot[] = [], prs: m.PrSnapshot[] = [], links: m.Facts['links'] = [], repos: m.RepoSnapshot[] = [], branches: m.BranchSnapshot[] = [], maintenance: m.MaintenanceObservation[] = [];
    const sources: SourcePr[] = [];
    const wantedPrs = new Map(scope.prs.map(item => [refKey(item), item]));
    const repositoryReads = new Map<string, { repo: m.Repo; bases: Set<string> }>();
    for (const item of scope.repos) {
      const key = repoKey(item.repo);
      const read = repositoryReads.get(key) ?? { repo: item.repo, bases: new Set<string>() };
      for (const base of item.bases) read.bases.add(base);
      repositoryReads.set(key, read);
    }
    for (const repository of [...scope.issues.map(item => item.repo), ...scope.prs.map(item => item.repo), ...scope.branches.map(item => item.repo)]) {
      const key = repoKey(repository);
      if (!repositoryReads.has(key)) repositoryReads.set(key, { repo: repository, bases: new Set<string>() });
    }
    const tasks: { query: string; consume: (value: unknown) => void | Promise<void> }[] = [];
    function addBranch(repository: m.Repo, name: string, source: z.infer<typeof sourceBranch> | null, isDefault: boolean): void {
      if (source !== null && source.name !== name) fail('invalidResponse', `Branch identity mismatch: requested ${name}, received ${source.name}`);
      const existing = branches.find(item => repoKey(item.repo) === repoKey(repository) && item.name === name);
      const observation: m.BranchSnapshot = { repo: repository, name, state: source === null ? { kind: 'missing' } : { kind: 'present', head: source.target.oid } };
      if (existing && !sameBranchState(existing.state, observation.state)) fail('invalidResponse', `Branch changed within facts read: ${repoKey(repository)} ${name}`);
      if (!existing) branches.push(observation);
      const targetRepo = repos.find(item => repoKey(item.repo) === repoKey(repository));
      if (!targetRepo) return fail('invalidResponse', 'Branch repository was not read');
      const base: m.BaseSnapshot = { name, state: source === null ? { kind: 'missing' } : { kind: 'present', head: source.target.oid, isDefault, rules: requirements(source) } };
      const prior = targetRepo.bases.find(item => item.name === name);
      if (prior && JSON.stringify(prior) !== JSON.stringify(base)) fail('invalidResponse', `Base changed within facts read: ${name}`);
      if (!prior) targetRepo.bases.push(base);
    }
    function addRepo(source: z.infer<typeof sourceRepo>): void {
      const identity = repo(source);
      const previous = repos.find(item => repoKey(item.repo) === repoKey(identity));
      if (previous && (previous.defaultBranch !== source.defaultBranchRef.name || previous.defaultHead !== source.defaultBranchRef.target.oid)) fail('invalidResponse', 'Default branch changed within source read');
      if (!previous) repos.push({ repo: identity, defaultBranch: source.defaultBranchRef.name, defaultHead: source.defaultBranchRef.target.oid, bases: [] });
      addBranch(identity, source.defaultBranchRef.name, source.defaultBranchRef, true);
    }
    for (const read of [...repositoryReads.values()].sort((left, right) => repoKey(left.repo).localeCompare(repoKey(right.repo)))) {
      const bases = [...read.bases].sort();
      const fields = `${repoFields} ${bases.map((name, index) => `b${index}:ref(qualifiedName:${quote(`refs/heads/${name}`)}) { ${branchFields} }`).join('\n')}`;
      tasks.push({ query: selection(read.repo, fields), consume: async value => {
        const source = decode(sourceRepo.passthrough(), value, 'repository');
        const identity = repo(source);
        if (repoKey(identity) !== repoKey(read.repo)) fail('invalidResponse', 'Repository identity mismatch');
        await completeBranchRules(identity, source.defaultBranchRef, cause);
        const requested = bases.map((name, index) => ({ name, branch: decode(sourceBranch.nullable(), source[`b${index}`], `requested base ${name}`) }));
        for (const item of requested) if (item.branch) await completeBranchRules(identity, item.branch, cause);
        addRepo(source);
        for (const item of requested) addBranch(identity, item.name, item.branch, item.name === source.defaultBranchRef.name);
      } });
    }
    for (const wanted of scope.issues) tasks.push({ query: selection(wanted.repo, `issue(number:${wanted.number}) { ${issueSelection} }`), consume: async value => {
      const raw = decode(z.object({ issue: z.unknown() }), value, 'issue').issue;
      const item = decode(issueRead, raw, 'issue');
      if (refKey(ref(item)) !== refKey(wanted)) fail('invalidResponse', 'Issue identity mismatch');
      await completeIssueConnections(item, cause);
      issues.push(issueSnapshot(item, pm ? await issuePm(raw, pm, cause) : null));
      for (const linked of item.closedByPullRequestsReferences.nodes) { const pr = ref(linked); wantedPrs.set(refKey(pr), pr); links.push({ issue: ref(item), pr }); }
    } });
    for (const wanted of scope.branches) tasks.push({ query: selection(wanted.repo, `ref(qualifiedName:${quote(`refs/heads/${wanted.name}`)}) { ${branchFields} }`), consume: async value => {
      const source = decode(z.object({ ref: sourceBranch.nullable() }), value, 'branch').ref;
      if (source !== null) await completeBranchRules(wanted.repo, source, cause);
      const defaultBranch = repos.find(item => repoKey(item.repo) === repoKey(wanted.repo))?.defaultBranch;
      addBranch(wanted.repo, wanted.name, source, defaultBranch === wanted.name);
    } });
    const queried = new Set<string>();
    const prTask = (wanted: m.PrRef) => ({ query: selection(wanted.repo, `pullRequest(number:${wanted.number}) { ${prFields(wanted.number)} }`), consume: async (value: unknown) => {
      const source = decode(z.object({ pullRequest: sourcePr }), value, 'pull request').pullRequest;
      if (refKey(ref(source)) !== refKey(wanted)) fail('invalidResponse', 'PR identity mismatch');
      await completePrConnections(source, cause);
      await completeBranchRules(repo(source.repository), source.repository.defaultBranchRef, cause);
      await completeBranchRules(repo(source.baseRepository), source.baseRepository.defaultBranchRef, cause);
      if (source.baseRef) await completeBranchRules(repo(source.baseRepository), source.baseRef, cause);
      sources.push(source); queried.add(refKey(wanted));
    } });
    tasks.push(...scope.prs.map(prTask));
    async function batch(items: typeof tasks): Promise<void> {
      if (!items.length) return;
      const data = await graph(`query { viewer { login } ${items.map((item, index) => `a${index}:${item.query}`).join('\n')} }`, cause);
      const viewer = decode(z.object({ login: z.string().min(1) }), data.viewer, 'viewer');
      if (options.actor && options.actor.toLowerCase() !== viewer.login.toLowerCase()) fail('permission', 'Configured actor differs from authenticated source viewer');
      actor = viewer.login;
      for (const [index, item] of items.entries()) await item.consume(data[`a${index}`]);
    }
    let actor = '';
    await batch(tasks);
    await batch([...wantedPrs.values()].filter(item => !queried.has(refKey(item))).map(prTask));
    for (const source of sources) {
      addRepo(source.repository); addRepo(source.baseRepository);
      const targetRepo = repo(source.baseRepository), headRepo = repo(source.headRepository);
      addBranch(targetRepo, source.baseRefName, source.baseRef, source.baseRefName === source.baseRepository.defaultBranchRef.name);
      const priorHead = branches.find(item => repoKey(item.repo) === repoKey(headRepo) && item.name === source.headRefName);
      const headState: m.BranchSnapshot = { repo: headRepo, name: source.headRefName, state: source.headRef ? { kind: 'present', head: source.headRef.target.oid } : { kind: 'missing' } };
      if (priorHead && !sameBranchState(priorHead.state, headState.state)) fail('invalidResponse', 'PR head branch changed within facts read');
      if (!priorHead) branches.push(headState);
      const rules = source.baseRef ? requirements(source.baseRef) : null;
      const prRef = ref(source);
      const snapshot: m.PrSnapshot = { ref: prRef, headRepo, headBranch: source.headRefName, head: source.headRefOid, target: { repo: targetRepo, base: source.baseRefName }, title: source.title, body: source.body, bodyHash: digest(source.body), updatedAt: source.updatedAt,
        state: source.state === 'MERGED' ? decode(m.prStateSchema, { kind: 'merged', sha: source.mergeCommit?.oid, at: source.mergedAt }, 'merged PR') : { kind: source.state === 'OPEN' ? 'open' : 'closed' },
        closes: source.closingIssuesReferences.nodes.map(ref),
        mergeable: source.mergeable === 'CONFLICTING' ? 'no' : source.mergeStateStatus === 'DRAFT' ? 'draft' : source.mergeStateStatus === 'BEHIND' ? 'behind' : source.mergeable === 'MERGEABLE' ? 'yes' : 'unknown',
        checks: rules ? checks(source, rules) : { kind: 'unknown', reason: 'Target base missing' },
      };
      if (snapshot.checks.kind === 'failing') {
        for (const failure of snapshot.checks.required) if (failure.kind === 'actions') await verifyActionsFailure(prRef.repo, failure, cause);
      }
      prs.push(snapshot);
      for (const issue of snapshot.closes) if (!links.some(link => refKey(link.issue) === refKey(issue) && refKey(link.pr) === refKey(prRef))) links.push({ issue, pr: prRef });
      const basis: m.MaintenanceBasis = { headRepo, headBranch: source.headRefName, viewerPermission: source.headRepository.viewerPermission, author: source.author.login, maintainerCanModify: source.maintainerCanModify, authorization: actor.toLowerCase() === source.author.login.toLowerCase() ? { kind: 'actorIsAuthor', actor } : { kind: 'none' } };
      let authorizationProblem: string | null = null;
      const intents = (scope.maintenanceIntents ?? []).filter(intent => refKey(intent.pr) === refKey(prRef));
      if (intents.length > 1) authorizationProblem = 'Multiple current maintenance intents for the same PR';
      else if (basis.authorization.kind === 'none') {
        const intent = intents[0];
        if (intent?.kind === 'systemCreated') basis.authorization = { kind: 'systemCreated', effectId: intent.effectId };
        else if (intent?.kind === 'authorAuthorized') {
          const response = await api(`${pathRepo(prRef.repo)}/issues/comments/${intent.commentId}`, 'GET', undefined, cause, true);
          if (response.status === 404) authorizationProblem = 'Author authorization comment no longer exists';
          else {
            const comment = decode(z.object({ id: positive, body: z.string(), user: z.object({ login: z.string().min(1) }), issue_url: z.string().url() }), response.body, 'author authorization');
            const expectedIssue = `https://api.github.com/${pathRepo(prRef.repo)}/issues/${prRef.number}`;
            if (comment.id !== intent.commentId || comment.issue_url.toLowerCase() !== expectedIssue.toLowerCase() ||
              comment.user.login.toLowerCase() !== intent.author.toLowerCase() || intent.author.toLowerCase() !== source.author.login.toLowerCase() || digest(comment.body) !== intent.bodyHash)
              authorizationProblem = 'Author authorization source changed or does not belong to this PR author';
            else basis.authorization = { kind: 'authorAuthorized', evidence: `https://github.com/${prRef.repo.owner}/${prRef.repo.name}/pull/${prRef.number}#issuecomment-${comment.id} sha256:${intent.bodyHash}` };
          }
        }
      }
      const writable = ['ADMIN', 'MAINTAIN', 'WRITE'].includes(basis.viewerPermission) ||
        (source.maintainerCanModify && ['ADMIN', 'MAINTAIN', 'WRITE'].includes(source.baseRepository.viewerPermission));
      maintenance.push({ pr: prRef, result: authorizationProblem ? { kind: 'unknown', reason: authorizationProblem } :
        !source.headRef ? { kind: 'unknown', reason: 'PR head branch no longer exists' } :
          { kind: writable && basis.authorization.kind !== 'none' ? 'maintainable' : 'foreign', basis } });
    }
    const commits: m.Facts['commits'] = [];
    for (const item of scope.commits) commits.push({ ...item, result: await containment(item.repo, item.ancestor, item.descendant, cause) });
    const checkAttempts: m.CheckAttempt[] = [];
    for (const item of scope.checkRuns) checkAttempts.push(await attempt(item.repo, item.runId, cause));
    const createdIssues: m.CreatedIssueObservation[] = [];
    for (const item of scope.creations) {
      const observations = await createdSince(item.repo, item.since, cause);
      for (const candidate of observations) if (candidate.title === item.title && candidate.body === item.body && candidate.actor.toLowerCase() === item.actor.toLowerCase() && !createdIssues.some(existing => refKey(existing.issue) === refKey(candidate.issue))) createdIssues.push(candidate);
    }
    repos.sort((left, right) => repoKey(left.repo).localeCompare(repoKey(right.repo)));
    for (const repository of repos) repository.bases.sort((left, right) => left.name.localeCompare(right.name));
    return decode(m.factsSchema, { viewer: actor, issues, prs, links, repos, branches, maintenance, commits, checkAttempts, createdIssues }, 'facts');
  }
  async function containment(repository: m.Repo, ancestor: string, descendant: string, cause: string): Promise<'contains' | 'notContained' | 'missing'> {
    const key = `${repoKey(repository)}:${ancestor}:${descendant}`;
    const cached = ancestry.get(key);
    if (cached) { rememberAncestry(key, cached); return cached; }
    const response = await api(`${pathRepo(repository)}/compare/${encodeURIComponent(ancestor)}...${encodeURIComponent(descendant)}`, 'GET', undefined, cause, true);
    if (response.status === 404) {
      // A masked/inaccessible repository must not become a missing-commit fact.
      await api(pathRepo(repository), 'GET', undefined, cause);
      return 'missing';
    }
    const comparison = decode(z.object({ status: z.enum(['ahead', 'behind', 'diverged', 'identical']), base_commit: z.object({ sha: m.shaSchema }), commits: z.array(z.object({ sha: m.shaSchema })) }), response.body, 'commit comparison');
    if (comparison.base_commit.sha !== ancestor) fail('invalidResponse', 'Comparison source ancestor mismatch');
    const answer = comparison.status === 'ahead' || comparison.status === 'identical' ? 'contains' : 'notContained';
    rememberAncestry(key, answer); return answer;
  }
  async function attempt(repository: m.Repo, runId: number, cause: string): Promise<m.CheckAttempt> {
    const response = await api(`${pathRepo(repository)}/actions/runs/${runId}`, 'GET', undefined, cause);
    const source = decode(z.object({ id: positive, head_sha: m.shaSchema, check_suite_id: positive, run_attempt: positive }), response.body, 'workflow run');
    if (source.id !== runId) fail('invalidResponse', 'Workflow run identity mismatch');
    return { repo: repository, workflowRunId: runId, attempt: source.run_attempt, head: source.head_sha };
  }
  async function verifyActionsFailure(repository: m.Repo, failure: Extract<m.CheckFailure, { kind: 'actions' }>, cause: string): Promise<void> {
    // checks() already pins the check's app, suite commit and structured workflow.
    // Corroborate its exact job through the attempt's complete source jobs list.
    let page = 1, total: number | null = null;
    const jobs = new Map<number, { id: number; run_id: number; run_attempt: number; head_sha: string; check_run_url: string }>();
    for (;;) {
      const response = await api(`${pathRepo(repository)}/actions/runs/${failure.workflowRunId}/attempts/${failure.runAttempt}/jobs?per_page=100&page=${page}`, 'GET', undefined, cause);
      const source = decode(z.object({ total_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), jobs: z.array(z.object({ id: positive, run_id: positive, run_attempt: positive, head_sha: m.shaSchema, check_run_url: z.string().url() })) }), response.body, 'Actions jobs');
      if (total !== null && total !== source.total_count) fail('invalidResponse', 'Actions jobs changed during pagination');
      total = source.total_count;
      for (const job of source.jobs) {
        if (jobs.has(job.id)) fail('invalidResponse', 'Duplicate Actions job across pages');
        jobs.set(job.id, job);
      }
      if (jobs.size === total) {
        if (response.headers.get('link')?.includes('rel=\"next\"')) fail('invalidResponse', 'Actions job pagination contradicts source count');
        break;
      }
      if (jobs.size > total || source.jobs.length === 0 || !response.headers.get('link')?.includes('rel=\"next\"')) fail('invalidResponse', 'Actions job pagination incomplete');
      page += 1;
    }
    const job = jobs.get(failure.jobId);
    const expectedCheck = `https://api.github.com/${pathRepo(repository)}/check-runs/${failure.checkRunId}`;
    if (!job || job.run_id !== failure.workflowRunId || job.run_attempt !== failure.runAttempt || job.head_sha !== failure.head || job.check_run_url.toLowerCase() !== expectedCheck.toLowerCase())
      fail('invalidResponse', 'Actions job does not corroborate exact check/workflow/attempt/head');
  }
  async function createdSince(repository: m.Repo, since: number, cause: string): Promise<m.CreatedIssueObservation[]> {
    const observations: m.CreatedIssueObservation[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const data = await graph(`query { ${selection(repository, `issues(first:50,orderBy:{field:CREATED_AT,direction:DESC}${cursor ? `,after:${quote(cursor)}` : ''}) { pageInfo { hasNextPage endCursor } nodes { ${referenceFields} title body createdAt author { login } } }`)} }`, cause);
      const source = decode(z.object({ repository: z.object({ issues: connection(z.object({ number: positive, repository: repositoryName, title: z.string().min(1), body: z.string(), createdAt: date, author: z.object({ login: z.string().min(1) }) })) }) }), data, 'created issues').repository.issues;
      for (const item of source.nodes) if (item.createdAt >= since) observations.push({ issue: ref(item), title: item.title, body: item.body, actor: item.author.login, createdAt: item.createdAt });
      if (!source.pageInfo.hasNextPage || source.nodes.some(item => item.createdAt < since)) break;
      const nextCursor = source.pageInfo.endCursor;
      if (!nextCursor || seen.has(nextCursor)) return fail('invalidResponse', 'Issue candidate pagination did not advance');
      cursor = nextCursor;
      seen.add(nextCursor);
    } while (cursor);
    return observations;
  }
  async function singlePr(reference: m.PrRef, cause: string): Promise<m.PrSnapshot> {
    const facts = await collect({ issues: [], prs: [reference], repos: [], branches: [], commits: [], checkRuns: [], creations: [] }, cause);
    const value = facts.prs.find(item => refKey(item.ref) === refKey(reference));
    if (!value) return fail('invalidResponse', 'Requested PR missing from complete facts');
    return value;
  }
  async function singleIssue(reference: m.IssueRef, cause: string): Promise<m.IssueSnapshot> {
    const data = await graph(`query { ${selection(reference.repo, `issue(number:${reference.number}) { ${issueSelection} }`)} }`, cause);
    const raw = decode(z.object({ repository: z.object({ issue: z.unknown() }) }), data, 'issue').repository.issue;
    const source = decode(issueRead, raw, 'issue');
    if (refKey(ref(source)) !== refKey(reference)) fail('invalidResponse', 'Issue identity mismatch');
    await completeIssueConnections(source, cause);
    return issueSnapshot(source, pm ? await issuePm(raw, pm, cause) : null);
  }
  async function preflightPr(input: PrWrite): Promise<void> {
    const value = await branch(input.headRepo, input.branch, 'publishPreflight');
    if (value.kind !== 'present' || value.head !== input.head) fail('precondition', 'Remote branch no longer matches accepted head');
    if ((await branch(input.target.repo, input.target.base, 'publishPreflight')).kind !== 'present') fail('precondition', 'Target base does not exist');
  }
  async function branch(repository: m.Repo, name: string, cause: string): Promise<m.BranchSnapshot['state']> {
    const data = await graph(`query { ${selection(repository, `ref(qualifiedName:${quote(`refs/heads/${name}`)}) { target { oid } }`)} }`, cause);
    const source = decode(z.object({ repository: z.object({ ref: z.object({ target: z.object({ oid: m.shaSchema }) }).nullable() }) }), data, 'branch head').repository.ref;
    return source ? { kind: 'present', head: source.target.oid } : { kind: 'missing' };
  }
  // Project, field and option node ids are looked up by their configured names once per process.
  let statusIds: { projectId: string; fieldId: string; options: ReadonlyMap<string, string> } | null = null;
  async function statusField(project: PmProjectSource, cause: string): Promise<NonNullable<typeof statusIds>> {
    if (statusIds) return statusIds;
    const fields = `projectV2(number:${project.number}) { id field(name:${quote(project.statusField)}) { __typename ... on ProjectV2SingleSelectField { id options { id name } } } }`;
    const data = await graph(`query { repositoryOwner(login:${quote(project.owner)}) { __typename ... on Organization { ${fields} } ... on User { ${fields} } } }`, cause);
    const owner = decode(z.object({ repositoryOwner: z.object({ projectV2: z.object({ id: z.string().min(1),
      field: z.object({ __typename: z.literal('ProjectV2SingleSelectField'), id: z.string().min(1), options: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })) }).nullable() }) }).nullable() }), data, 'PM project').repositoryOwner;
    if (!owner) return fail('precondition', `Project owner ${project.owner} does not exist`);
    const field = owner.projectV2.field;
    if (!field) return fail('precondition', `Project ${project.owner}#${project.number} has no field ${project.statusField}`);
    statusIds = { projectId: owner.projectV2.id, fieldId: field.id, options: new Map(field.options.map(option => [option.name, option.id])) };
    return statusIds;
  }
  /** Adds the issue to the configured Project when it has no item there, then selects `option` on its Status field. */
  async function setStatus(issue: m.IssueRef, option: string): Promise<null> {
    if (!pm) return fail('precondition', 'PM integration is off; no Project is configured');
    const ids = await statusField(pm, 'setProjectField');
    const optionId = ids.options.get(option);
    if (!optionId) return fail('precondition', `Project field ${pm.statusField} has no option ${option}`);
    const data = await graph(`query { ${selection(issue.repo, `issue(number:${issue.number}) { id ${referenceFields} ${projectItemsPage(pm.statusField, null)} }`)} }`, 'setProjectField');
    const raw = decode(z.object({ repository: z.object({ issue: z.unknown() }) }), data, 'issue').repository.issue;
    const content = decode(z.object({ id: z.string().min(1), ...sourceRefFields }), raw, 'issue');
    if (refKey(ref(content)) !== refKey(issue)) fail('invalidResponse', 'Issue identity mismatch');
    let itemId = (await projectItem(raw, pm, 'setProjectField'))?.id;
    if (!itemId) {
      const added = await graph(`mutation { addProjectV2ItemById(input:{projectId:${quote(ids.projectId)},contentId:${quote(content.id)}}) { item { id } } }`, 'setProjectField', true);
      itemId = decode(z.object({ addProjectV2ItemById: z.object({ item: z.object({ id: z.string().min(1) }) }) }), added, 'added project item').addProjectV2ItemById.item.id;
    }
    await graph(`mutation { updateProjectV2ItemFieldValue(input:{projectId:${quote(ids.projectId)},itemId:${quote(itemId)},fieldId:${quote(ids.fieldId)},value:{singleSelectOptionId:${quote(optionId)}}}) { projectV2Item { id } } }`, 'setProjectField', true);
    return null;
  }
  return {
    facts: (scope, cause) => result(() => collect(scope, cause)),
    contains: (repository, ancestor, descendant) => result(() => containment(repository, ancestor, descendant, 'contains')),
    branchHead: (repository, name) => result(() => branch(repository, name, 'branchHead')),
    issue: reference => result(() => singleIssue(reference, 'issue')),
    pr: reference => result(() => singlePr(reference, 'pr')),
    checkAttempt: (repository, runId) => result(() => attempt(repository, runId, 'checkAttempt')),
    issuesCreatedSince: (repository, since) => result(() => createdSince(repository, since, 'creationRecovery')),
    openPrsByHead: (headRepository, name, target) => result(async () => {
      const references: m.PrRef[] = [];
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const data = await graph(`query { ${selection(target.repo, `pullRequests(first:50,states:[OPEN],headRefName:${quote(name)},baseRefName:${quote(target.base)}${cursor ? `,after:${quote(cursor)}` : ''}) { pageInfo { hasNextPage endCursor } nodes { ${referenceFields} headRepository { nameWithOwner } } }`)} }`, 'openPrsByHead');
        const source = decode(z.object({ repository: z.object({ pullRequests: connection(sourceHeadPrRef) }) }), data, 'head PR candidates').repository.pullRequests;
        for (const item of source.nodes) if (item.headRepository && repoKey(repo(item.headRepository)) === repoKey(headRepository)) references.push(ref(item));
        if (!source.pageInfo.hasNextPage) break;
        const nextCursor = source.pageInfo.endCursor;
        if (!nextCursor || seen.has(nextCursor)) return fail('invalidResponse', 'PR candidate pagination did not advance');
        cursor = nextCursor;
        seen.add(nextCursor);
      } while (cursor);
      if (!references.length) return [];
      return (await collect({ issues: [], prs: references, repos: [{ repo: target.repo, bases: [target.base] }], branches: [], commits: [], checkRuns: [], creations: [] }, 'openPrsByHead')).prs;
    }),
    createIssue: input => result(async () => {
      const response = await api(`${pathRepo(input.repo)}/issues`, 'POST', { title: input.title, body: input.body }, 'createIssue');
      const created = z.object({ number: positive }).safeParse(response.body);
      if (!created.success) return fail('uncertainOutcome', 'Create issue returned success without a valid source identity');
      return { repo: input.repo, number: created.data.number };
    }),
    addSubIssue: (parent, child) => result(async () => {
      const source = await api(`${pathRepo(child.repo)}/issues/${child.number}`, 'GET', undefined, 'attachChild');
      const identity = decode(z.object({ id: positive, number: positive }), source.body, 'child issue');
      if (identity.number !== child.number) fail('invalidResponse', 'Child issue identity mismatch');
      await api(`${pathRepo(parent.repo)}/issues/${parent.number}/sub_issues`, 'POST', { sub_issue_id: identity.id }, 'attachChild');
      return null;
    }),
    editIssueBody: (reference, expectedHash, body) => result(async () => {
      const current = await singleIssue(reference, 'replaceBodyPreflight');
      if (current.bodyHash === digest(body)) return null;
      if (current.bodyHash !== expectedHash) fail('precondition', `Issue body changed; current hash ${current.bodyHash}`);
      await api(`${pathRepo(reference.repo)}/issues/${reference.number}`, 'PATCH', { body }, 'replaceBody');
      return null;
    }),
    setIssueOpen: (reference, open) => result(async () => {
      await api(`${pathRepo(reference.repo)}/issues/${reference.number}`, 'PATCH', { state: open ? 'open' : 'closed' }, 'setIssueState');
      return null;
    }),
    createPr: input => result(async () => {
      await preflightPr(input);
      const head = repoKey(input.headRepo) === repoKey(input.target.repo) ? input.branch : `${input.headRepo.owner}:${input.branch}`;
      const response = await api(`${pathRepo(input.target.repo)}/pulls`, 'POST', { head, head_repo: input.headRepo.name, base: input.target.base, title: input.title, body: input.body }, 'publishPr');
      const created = z.object({ number: positive }).safeParse(response.body);
      if (!created.success) return fail('uncertainOutcome', 'Create PR returned success without a valid source identity');
      return { repo: input.target.repo, number: created.data.number };
    }),
    editPr: (reference, input) => result(async () => {
      await preflightPr(input);
      const current = await singlePr(reference, 'publishPreflight');
      if (repoKey(current.headRepo) !== repoKey(input.headRepo) || current.headBranch !== input.branch || current.head !== input.head || repoKey(current.target.repo) !== repoKey(input.target.repo) || current.target.base !== input.target.base || current.state.kind !== 'open') fail('precondition', 'PR no longer matches accepted head/target');
      await api(`${pathRepo(reference.repo)}/pulls/${reference.number}`, 'PATCH', { title: input.title, body: input.body }, 'publishPr');
      return null;
    }),
    mergePr: (reference, head) => result(async () => {
      if (Date.now() < blockedUntil) throw new SourceFailure({ kind: 'rateLimited', message: 'Source rate limit reset has not been reached', resetAt: blockedUntil });
      const output = await command(['pr', 'merge', String(reference.number), '--repo', `${reference.repo.owner}/${reference.repo.name}`, '--merge', '--match-head-commit', head], undefined, true);
      if (output.timedOut) fail('uncertainOutcome', 'Merge request timed out; source confirmation required');
      if (output.code !== 0) {
        // The CLI can perform multiple requests before failing. Without source
        // confirmation its exit status alone cannot prove that no merge happened.
        fail('uncertainOutcome', sanitize(output.stderr || 'gh merge failed; source confirmation required'));
      }
      return null;
    }),
    rerunCheck: (repository, workflowRunId) => result(async () => {
      await attempt(repository, workflowRunId, 'rerunPreflight');
      await api(`${pathRepo(repository)}/actions/runs/${workflowRunId}/rerun-failed-jobs`, 'POST', undefined, 'rerunChecks');
      return null;
    }),
    comment: (issue, body) => result(async () => {
      const response = await api(`${pathRepo(issue.repo)}/issues/${issue.number}/comments`, 'POST', { body }, 'comment');
      const created = z.object({ id: positive }).safeParse(response.body);
      if (!created.success) return fail('uncertainOutcome', 'Create comment returned success without a valid source identity');
      return created.data.id;
    }),
    setProjectField: (issue, _field, option) => result(() => setStatus(issue, option)),
  };
}
