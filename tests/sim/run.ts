// State-flow simulation of omp-dispatch. Each scenario runs the real `omp`
// binary in RPC mode with the real extension (index.ts), the real controller,
// host, git worktrees, native sessions and forks. Only two things are
// simulated: the model (tests/sim/extension.ts plays Main and every seat) and
// GitHub (tests/sim/github-sim.ts behind a `gh` shim on PATH, backed by real
// bare repositories). Run: `bun run sim [scenario...]`.

import {closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {hostname} from 'node:os';
import {join, resolve} from 'node:path';
import {YAML, type Subprocess} from 'bun';
import {z} from '@oh-my-pi/omptype/zod';
import type {Agenda} from '../../src/domain/model.ts';
import {parseMarker} from '../../src/pm/markers.ts';
import {encodeWorkflow, parseWorkflow, parentSeatRoles, workflowAgents, type ParentState, type TicketState, type Workflow} from '../../src/domain/workflow.ts';
import {createAgendaFiles} from '../../src/ports/state.ts';
import {git, remotePath, seedGitHub, withState, type SimState} from './github-sim.ts';
import type {Expect, Scenario, TicketSpec} from './scenario.ts';
import {askCases} from './ask.ts';

const ROOT = resolve(import.meta.dir, '../..');
/** The PM configuration PM-on scenarios point the `pmConfigDir` plugin setting at; its Project is the simulated `sim` #1. */
const PM_CONFIG = join(ROOT, 'tests/sim/pm-config');
const REPO = {owner: 'sim', name: 'arena'};
const KEY = `${REPO.owner}/${REPO.name}`;
// Long enough for the abandon scenario's injected provider failure: omp retries it eleven times, about 30 seconds apart.
const DEADLINE_MS = 420_000;

/** Parse a file-shaped workflow fixture; a fixture the parser refuses is a broken simulation. */
function workflowOf(source: unknown): Workflow {
  const parsed = parseWorkflow(source);
  if (!parsed.ok) throw new Error(`Invalid sim workflow at ${parsed.error.path}: ${parsed.error.reason}`);
  return parsed.value;
}
/** Every seat of `workflow` played by one scripted agent. */
function playedBy(workflow: Workflow, agent: string): Workflow {
  const seat = <S extends TicketState | ParentState>(state: S): S =>
    state.kind === 'work' ? {...state, agent} : state.kind === 'judge' ? {...state, judges: state.judges.map(item => ({...item, agent}))} : state;
  return {ticket: {...workflow.ticket, states: Object.fromEntries(Object.entries(workflow.ticket.states).map(([key, state]) => [key, seat(state)]))},
    parent: {...workflow.parent, states: Object.fromEntries(Object.entries(workflow.parent.states).map(([key, state]) => [key, seat(state)]))}};
}
/** The built-in workflow with every seat played by the scripted `sim-seat` agent. */
const SIM_WORKFLOW = playedBy(workflowOf(YAML.parse(readFileSync(join(ROOT, 'src/default-workflow.yml'), 'utf8'))), 'sim-seat');
/** The subject each judge role of `workflow` judges. */
function judgeSubjects(workflow: Workflow): Map<string, 'pullRequest' | 'mergeCommit' | 'parent'> {
  const subjects = new Map<string, 'pullRequest' | 'mergeCommit' | 'parent'>();
  for (const state of Object.values(workflow.ticket.states)) if (state.kind === 'judge') for (const item of state.judges) subjects.set(item.role, state.subject);
  for (const role of parentSeatRoles(workflow)) subjects.set(role, 'parent');
  return subjects;
}
const workRoles = (workflow: Workflow) => [...new Set(Object.values(workflow.ticket.states).flatMap(state => state.kind === 'work' ? [state.role] : []))];

export type Run = {
  name: string; dir: string; github: string; bin: string; work: string; data: string; mainSessions: string;
  /** `pm` is the PM configuration directory the run's `pmConfigDir` plugin setting names, or null with PM integration off. */
  scenarioFile: string; scenario: Scenario; workflow: Workflow; rootIssue: number; pm: string | null; proc: Subprocess<'pipe', number, number> | null; starts: number;
};
export type Case = {
  name: string;
  /** The workflow the run's data directory supplies to convene; SIM_WORKFLOW when omitted. */
  workflow?: Workflow;
  /**
   * PM integration on, with PM_CONFIG. `holdComment` makes the simulated GitHub hold the comment request that finds
   * `skip` comments, `at` before or after recording it, touching `markers/comment-arrived` until `markers/release-comment`
   * or `markers/drop-comment` exists. `guardiansURL` replaces the configuration's intent guardians address in a copy made
   * for the run.
   */
  pm?: {holdComment: Pick<NonNullable<SimState['commentHold']>, 'skip' | 'at'> | null; guardiansURL?: string};
  files: Record<string, string>;
  /** Issue titles in creation order; issue N is the Nth entry. The first may list children. */
  issues: {title: string; children?: number[]}[];
  requiredChecks: string[];
  ci: {default: SimState['ciDefault']; failMarker: string | null};
  scenario: (markers: string) => Omit<Scenario, 'log' | 'repo' | 'name' | 'parentRoles' | 'workRoles'>;
  rootIssue: number;
  drive?: (run: Run) => Promise<void>;
  check: (run: Run) => Promise<string[]>;
};

/* ------------------------------------------------------------ process */

function setup(spec: Case): Run {
  const dir = mkdtempSync(`/tmp/dispatch-sim-${spec.name.replaceAll('/', '-')}-`);
  const github = join(dir, 'github'), work = join(dir, 'work'), markers = join(dir, 'markers'), data = join(dir, 'data');
  for (const path of [github, join(work, '.omp', 'agents'), markers, data, join(dir, 'main-sessions')]) mkdirSync(path, {recursive: true});
  const bin = seedGitHub(github, {viewer: 'sim', ciDefault: spec.ci.default, ciFailMarker: spec.ci.failMarker,
    repos: [{...REPO, defaultBranch: 'main', requiredChecks: spec.requiredChecks, files: spec.files}],
    issues: spec.issues.map(issue => ({repo: KEY, title: issue.title, body: `Simulated ${issue.title}.`, ...(issue.children ? {children: issue.children} : {})})),
    commentHold: spec.pm?.holdComment ? {...spec.pm.holdComment, arrived: join(markers, 'comment-arrived'), release: join(markers, 'release-comment'), drop: join(markers, 'drop-comment')} : null});
  const workflow = spec.workflow ?? SIM_WORKFLOW;
  // Every agent the workflow names is a scripted seat; the data directory's workflow.yml is the override convene reads (JSON is YAML).
  for (const agent of workflowAgents(workflow))
    writeFileSync(join(work, '.omp', 'agents', `${agent}.md`), `---\nname: ${agent}\ndescription: Scripted dispatch seat for the state-flow simulation\nmodel: sim/seat\n---\n\nFollow the dispatch brief.\n`);
  writeFileSync(join(data, 'workflow.yml'), JSON.stringify(encodeWorkflow(workflow), null, 1));
  const scenario: Scenario = {name: spec.name, repo: REPO, log: join(dir, 'model.jsonl'), parentRoles: parentSeatRoles(workflow), workRoles: workRoles(workflow), ...spec.scenario(markers)};
  const scenarioFile = join(dir, 'scenario.json');
  writeFileSync(scenarioFile, JSON.stringify(scenario, null, 1));
  writeFileSync(scenario.log, '');
  let pm: string | null = spec.pm ? PM_CONFIG : null;
  if (spec.pm?.guardiansURL) {
    pm = join(dir, 'pm-config');
    cpSync(PM_CONFIG, pm, {recursive: true});
    const delivery = join(pm, 'dispatch', 'delivery.yaml');
    writeFileSync(delivery, readFileSync(delivery, 'utf8').replace(/^guardiansURL: .*$/m, `guardiansURL: ${spec.pm.guardiansURL}`));
  }
  // The coordinator's own settings come only from the work directory's project plugin overrides, the store
  // `/settings` and `omp plugin config` write; `start` keeps their environment variables out of omp.
  writeFileSync(join(work, '.omp', 'plugin-overrides.json'), JSON.stringify({settings: {'omp-dispatch': {dataDir: data, recomputeIntervalSeconds: '1', pmConfigDir: pm ?? ''}}}, null, 1));
  return {name: spec.name, dir, github, bin, work, data, mainSessions: join(dir, 'main-sessions'), scenarioFile, scenario, workflow, rootIssue: spec.rootIssue, pm, proc: null, starts: 0};
}

function start(run: Run): void {
  run.starts++;
  const stdout = openSync(join(run.dir, `omp-${run.starts}.stdout.jsonl`), 'a'), stderr = openSync(join(run.dir, `omp-${run.starts}.stderr.log`), 'a');
  // The injected provider failure must surface at once: omp's automatic retry would otherwise wait out its budget.
  const config = join(run.dir, 'omp-config.yml');
  writeFileSync(config, 'retry:\n  enabled: false\n');
  // The operator's environment would take precedence over the run's plugin settings, so none of it reaches omp.
  const {OMP_DISPATCH_DIR: _dir, OMP_DISPATCH_RECOMPUTE_SECONDS: _interval, OMP_DISPATCH_PM_CONFIG: _pm, ...inherited} = process.env;
  run.proc = Bun.spawn(['omp', '--mode', 'rpc', '--no-ui', '--no-extensions', '-e', join(ROOT, 'index.ts'), '-e', join(ROOT, 'tests/sim/extension.ts'),
    '--model', 'sim/main', '--session-dir', run.mainSessions, '--dispatch', `${KEY}#${run.rootIssue}`, '--config', config], {
    cwd: run.work, stdin: 'pipe', stdout, stderr,
    env: {...inherited, PATH: `${run.bin}:${process.env.PATH}`, SIM_SCENARIO: run.scenarioFile},
  });
  closeSync(stdout); closeSync(stderr);
}

/** Closes stdin, which is RPC mode's clean shutdown: session_shutdown runs and the process exits. */
async function stop(run: Run): Promise<void> {
  const proc = run.proc;
  if (!proc) return;
  proc.stdin.end();
  const exited = await Promise.race([proc.exited, Bun.sleep(30_000).then(() => null)]);
  if (exited === null) proc.kill('SIGKILL');
  await proc.exited;
  run.proc = null;
}

async function kill(run: Run): Promise<void> {
  run.proc?.kill('SIGKILL');
  await run.proc?.exited;
  run.proc = null;
}

/* ------------------------------------------------------------ observations */

async function agenda(run: Run): Promise<Agenda | null> {
  const list = await createAgendaFiles(run.data).list();
  if (!list.ok) throw new Error(`Cannot read agendas: ${list.error.message}`);
  return list.value[0] ?? null;
}

const ticketOf = (state: Agenda | null, id: string) => state?.tickets.find(ticket => ticket.id === id);

async function waitUntil(run: Run, label: string, ready: (state: Agenda | null) => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    const state = await agenda(run);
    if (await ready(state)) return;
    if (run.proc && run.proc.exitCode !== null) throw new Error(`omp exited (${run.proc.exitCode}) while waiting for ${label}`);
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}; agenda: ${JSON.stringify(state?.tickets.map(ticket => ({id: ticket.id, state: ticket.state, revision: ticket.revision, notes: ticket.notes.map(note => note.text)})))}`);
    await Bun.sleep(300);
  }
}

const completed = (state: Agenda | null) => state?.lifecycle === 'completed';

const logSchema = z.object({at: z.number(), session: z.string().nullable(), kind: z.enum(['main', 'seat']), role: z.string().optional(), ticket: z.string().optional(), note: z.string(),
  step: z.object({name: z.string().optional(), args: z.record(z.string(), z.unknown()).optional(), text: z.string().optional()})});
export type LogEntry = z.infer<typeof logSchema>;
const inputSchema = z.object({input: z.object({op: z.string(), ticketId: z.string().optional(), role: z.string().optional(), ok: z.boolean().optional(), note: z.string().optional(), revision: z.number().optional()}).passthrough()}).passthrough();

function modelLog(run: Run): LogEntry[] {
  return readFileSync(run.scenario.log, 'utf8').split('\n').filter(Boolean).map(line => logSchema.parse(JSON.parse(line)));
}

/** The dispatch input of a logged tool call, or null for text and other tools. */
function dispatchInput(entry: LogEntry): z.infer<typeof inputSchema>['input'] | null {
  if (entry.step.name !== 'dispatch') return null;
  const parsed = inputSchema.safeParse(entry.step.args);
  return parsed.success ? parsed.data.input : null;
}

const sessionLineSchema = z.object({type: z.string()}).passthrough();
export type SeatSession = {file: string; id: string; parent: string | null; role: string; ticket: string; lines: z.infer<typeof sessionLineSchema>[]};

function seatSessions(run: Run, agendaId: string): SeatSession[] {
  const dir = join(run.data, 'sessions', agendaId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort().map(name => {
    const raw = readFileSync(join(dir, name), 'utf8');
    const lines = raw.split('\n').filter(Boolean).map(line => sessionLineSchema.parse(JSON.parse(line)));
    const header = lines.find(line => line.type === 'session');
    const seat = /You are the ([\w-]+) seat for dispatch ticket (\S+?)\. /.exec(raw);
    return {file: join(dir, name), id: typeof header?.id === 'string' ? header.id : '', parent: typeof header?.parentSession === 'string' ? header.parentSession : null,
      role: seat?.[1] ?? '?', ticket: seat?.[2] ?? '?', lines};
  });
}

const callSchema = z.object({type: z.literal('toolCall'), id: z.string(), name: z.string(), arguments: z.object({input: z.object({op: z.string(), note: z.string().optional()}).passthrough()}).passthrough()}).passthrough();
const messageLineSchema = z.object({message: z.object({role: z.string(), content: z.unknown(), toolCallId: z.string().optional()}).passthrough()}).passthrough();

/** Verdicts a gate seat actually submitted and the dispatch tool accepted, read from the seat transcripts. */
function acceptedVerdicts(sessions: SeatSession[]): {ticket: string; role: string; note: string}[] {
  const out: {ticket: string; role: string; note: string}[] = [];
  for (const session of sessions) {
    const messages = session.lines.flatMap(line => { const parsed = messageLineSchema.safeParse(line); return parsed.success ? [parsed.data.message] : []; });
    for (const message of messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        const call = callSchema.safeParse(block);
        if (!call.success || call.data.name !== 'dispatch' || call.data.arguments.input.op !== 'verdict') continue;
        const result = messages.find(item => item.role === 'toolResult' && item.toolCallId === call.data.id);
        if (result && JSON.stringify(result.content).includes('\\"ok\\":true')) out.push({ticket: session.ticket, role: session.role, note: call.data.arguments.input.note ?? ''});
      }
    }
  }
  return out;
}

const resultTextSchema = z.array(z.object({type: z.literal('text'), text: z.string()}));
const dispatchReplySchema = z.object({ok: z.boolean(), error: z.object({error: z.object({kind: z.string(), message: z.string()}).optional()}).passthrough().optional()}).passthrough();
type MainCall = {input: z.infer<typeof callSchema>['arguments']['input']; reply: z.infer<typeof dispatchReplySchema> | null};

/** Main's dispatch calls across its sessions in order, each with the reply the dispatch tool returned. */
function mainCalls(run: Run): MainCall[] {
  const replyOf = (content: unknown): MainCall['reply'] => {
    const text = resultTextSchema.safeParse(content);
    if (!text.success) return null;
    try { const reply = dispatchReplySchema.safeParse(JSON.parse(text.data.map(item => item.text).join(''))); return reply.success ? reply.data : null; } catch { return null; }
  };
  return readdirSync(run.mainSessions).filter(name => name.endsWith('.jsonl')).sort().flatMap(name => {
    const messages = readFileSync(join(run.mainSessions, name), 'utf8').split('\n').filter(Boolean)
      .flatMap(line => { const parsed = messageLineSchema.safeParse(JSON.parse(line)); return parsed.success ? [parsed.data.message] : []; });
    return messages.flatMap(message => message.role !== 'assistant' || !Array.isArray(message.content) ? [] : message.content.flatMap(block => {
      const call = callSchema.safeParse(block);
      if (!call.success || call.data.name !== 'dispatch') return [];
      return [{input: call.data.arguments.input, reply: replyOf(messages.find(item => item.role === 'toolResult' && item.toolCallId === call.data.id)?.content)}];
    }));
  });
}

const simState = (run: Run): SimState => withState(run.github, state => structuredClone(state));
const gitIn = (run: Run, args: string[]) => git(remotePath(run.github, KEY), args, true);

/* ------------------------------------------------------------ shared checks */

/** `expected` names the judge roles whose accepted verdict each ticket must show; by default every ticket judge. */
async function commonChecks(run: Run, expectOnMain: Expect, expected?: Record<string, string[]>): Promise<string[]> {
  const failures: string[] = [];
  const state = await agenda(run);
  if (!completed(state)) failures.push(`agenda is ${state?.lifecycle ?? 'missing'}, not completed`);
  const unhandled = readFileSync(join(run.github, 'requests.jsonl'), 'utf8').split('\n').filter(line => line.includes('"unhandled":true'));
  if (unhandled.length) failures.push(`simulated GitHub got ${unhandled.length} unmodelled requests, first: ${unhandled[0]!.slice(0, 400)}`);
  const log = modelLog(run);
  // Main launches every ticket exactly once and never names a later stage.
  const launches = log.filter(entry => entry.kind === 'main').map(dispatchInput).filter(input => input?.op === 'launch');
  for (const ticket of run.scenario.tickets) {
    const count = launches.filter(input => input?.ticketId === ticket.id).length;
    if (count !== 1) failures.push(`Main launched ${ticket.id} ${count} times`);
  }
  if (launches.some(input => input?.role !== undefined)) failures.push('Main named a role in launch');
  // Main is woken only for decisions it has not already taken.
  const launched = new Set<string>(), resolved = new Set<string>();
  const groups = new Map<string, LogEntry[]>();
  for (const entry of log.filter(item => item.kind === 'main')) groups.set(`${entry.session}:${entry.note}`, [...(groups.get(`${entry.session}:${entry.note}`) ?? []), entry]);
  for (const [, entries] of groups) {
    const keys = entries[0]!.note.slice(entries[0]!.note.indexOf(':') + 1);
    if (keys !== 'start') for (const key of keys.split(', ')) {
      if (key.startsWith('launch:') && launched.has(key.slice(7))) failures.push(`Main was woken for ${key} after launching it`);
      if (key.startsWith('escalated:') && resolved.has(key.slice(10))) failures.push(`Main was woken for ${key} after resolving it`);
    }
    for (const input of entries.map(dispatchInput)) {
      if (input?.op === 'launch' && input.ticketId) launched.add(input.ticketId);
      if (input?.op === 'resolve' && input.ticketId) resolved.add(`${input.ticketId}:${input.revision}`);
    }
  }
  // Judges judged the exact commit their subject names: pullRequest a PR commit, mergeCommit the merge commit, parent main.
  const sim = simState(run);
  const verdicts = acceptedVerdicts(seatSessions(run, state?.id ?? ''));
  const subjects = judgeSubjects(run.workflow);
  const ticketJudges = [...subjects].filter(([, subject]) => subject !== 'parent').map(([role]) => role);
  for (const ticket of run.scenario.tickets.filter(item => Object.keys(item.gate).length > 0))
    for (const role of expected?.[ticket.id] ?? ticketJudges) if (!verdicts.some(verdict => verdict.ticket === ticket.id && verdict.role === role)) failures.push(`${ticket.id} has no accepted ${role} verdict in its transcripts`);
  if (run.scenario.parent !== null) for (const role of parentSeatRoles(run.workflow)) if (!verdicts.some(verdict => verdict.role === role)) failures.push(`no accepted ${role} closure verdict in the transcripts`);
  for (const verdict of verdicts) {
    const head = /HEAD ([0-9a-f]{40})/.exec(verdict.note)?.[1];
    if (!head) { failures.push(`${verdict.ticket} ${verdict.role} verdict has no observed HEAD`); continue; }
    if (subjects.get(verdict.role) === 'parent') {
      if (gitIn(run, ['merge-base', '--is-ancestor', head, 'main']).code !== 0) failures.push(`${verdict.role} sat on ${head}, which is not on main`);
      continue;
    }
    const spec = run.scenario.tickets.find(ticket => ticket.id === verdict.ticket);
    const pr = sim.prs.find(item => item.state === 'MERGED' && spec && item.body.includes(`#${spec.issue}`));
    if (!pr?.mergeCommit) { failures.push(`${verdict.ticket} has no merged PR`); continue; }
    if (subjects.get(verdict.role) === 'mergeCommit') {
      if (head !== pr.mergeCommit) failures.push(`${verdict.ticket} ${verdict.role} sat on ${head}, not merge ${pr.mergeCommit}`);
    } else if (gitIn(run, ['merge-base', '--is-ancestor', head, pr.lastHead]).code !== 0 || gitIn(run, ['merge-base', '--is-ancestor', head, `${pr.mergeCommit}^1`]).code === 0) {
      failures.push(`${verdict.ticket} ${verdict.role} sat on ${head}, which is not a commit of its PR`);
    }
  }
  for (const issue of sim.issues) if (issue.state !== 'CLOSED') failures.push(`issue #${issue.number} is still open`);
  // Without PM integration, Dispatch leaves no PM record on GitHub.
  if (!run.pm) {
    const marked = sim.issues.flatMap(issue => issue.comments.filter(comment => comment.body.includes('<!-- pm:')).map(() => issue.number));
    if (marked.length) failures.push(`PM is off, but issues ${marked.join(', ')} carry pm: comments`);
    if (sim.project.items.length) failures.push(`PM is off, but the Project holds items ${JSON.stringify(sim.project.items)}`);
  }
  for (const [path, content] of Object.entries(expectOnMain)) {
    const actual = gitIn(run, ['show', `main:${path}`]);
    if (actual.code !== 0 || `${actual.stdout}\n` !== content && actual.stdout !== content.trimEnd()) failures.push(`main:${path} is ${JSON.stringify(actual.stdout)}, expected ${JSON.stringify(content)}`);
  }
  return failures;
}

function owners(sessions: SeatSession[], ticket: string, role = 'owner'): SeatSession[] {
  return sessions.filter(session => session.role === role && session.ticket === ticket);
}

/**
 * PM records of a completed PM-on run: every work seat session has exactly one `impl` marker on its ticket's issue,
 * naming that session, its file, this host and the agenda, and every ticket's Project Status went In Progress, then Done.
 */
async function pmChecks(run: Run): Promise<string[]> {
  const failures: string[] = [];
  const state = await agenda(run), sim = simState(run);
  if (!state) return ['no agenda'];
  const sessions = seatSessions(run, state.id);
  for (const spec of run.scenario.tickets) {
    const issue = sim.issues.find(item => item.number === spec.issue);
    const impls = (issue?.comments ?? []).flatMap(comment => { const read = parseMarker(comment.id, comment.body); return read.kind === 'marker' && read.fact.kind === 'impl' ? [read.fact.json] : []; });
    const workers = sessions.filter(session => session.ticket === spec.id && run.scenario.workRoles.includes(session.role));
    if (!workers.length) failures.push(`${spec.id} has no work seat session`);
    if (impls.length !== workers.length) failures.push(`${spec.id} has ${impls.length} impl markers for ${workers.length} work sessions`);
    for (const worker of workers) {
      const own = impls.filter(impl => impl.session === worker.id);
      if (own.length !== 1) failures.push(`${spec.id} session ${worker.id} has ${own.length} impl markers`);
      for (const impl of own) if (impl.file !== worker.file || impl.host !== hostname() || impl.agenda !== state.id) failures.push(`${spec.id} impl marker ${JSON.stringify(impl)} does not name ${worker.file} on ${hostname()} in agenda ${state.id}`);
    }
    const item = sim.project.items.find(entry => entry.number === spec.issue);
    if (JSON.stringify(item?.history) !== JSON.stringify(['In Progress', 'Done'])) failures.push(`${spec.id} Project Status went ${JSON.stringify(item?.history)}, not In Progress then Done`);
  }
  if (run.scenario.parent !== null && sim.project.items.some(item => item.number === run.scenario.parent)) failures.push('the parent issue was given a Project Status');
  const unconfirmed = state.effects.filter(effect => (effect.action.kind === 'comment' || effect.action.kind === 'setProjectField') && effect.state.kind !== 'confirmed');
  if (unconfirmed.length) failures.push(`PM effects not source-confirmed: ${JSON.stringify(unconfirmed.map(effect => ({id: effect.id, kind: effect.action.kind, state: effect.state.kind})))}`);
  return failures;
}

/* ------------------------------------------------------------ scenarios */

const commit = (write: Record<string, string>) => ({kind: 'commit' as const, write});
const ticket = (id: string, issue: number, owner: TicketSpec['owner'], gate: Expect, extra: Partial<TicketSpec> = {}): TicketSpec => ({id, issue, dependsOn: [], owner, gate, ...extra});

const TREE_FILES = {'a1.txt': '0\n', 'a2.txt': '0\n', 'shared.txt': 'L1=0\nL2=0\n', 'c.txt': '0\n', 'd.txt': '0\n', 'e.txt': '1\n'};
const TREE_DONE = {'a1.txt': '1\n', 'a2.txt': '1\n', 'shared.txt': 'L1=1\nL2=1\n', 'c.txt': '1\n', 'c.verify': '1\n', 'd.txt': '1\n', 'e.txt': '1\n'};

// restart-pm: the gates reject round one, and the simulated GitHub holds the rework Owner's impl comment, the second
// comment request; the driver kills the coordinator once the hold is reached, so the order of the write and the kill is fixed.
const RESTART_PM = {files: {'m.txt': '0\n'}, issues: [{title: 'M'}], requiredChecks: [], ci: {default: 'SUCCESS' as const, failMarker: null}, rootIssue: 1};
const RESTART_PM_TICKET = ticket('M', 1, [commit({'m.txt': '1\n'}), commit({'m.verify': '1\n'})], {'m.txt': '1\n', 'm.verify': '1\n'});
/** The held comment's effect: the rework Owner's impl comment, the second comment effect. */
const heldComment = (state: Agenda | null) => state?.effects.filter(effect => effect.action.kind === 'comment')[1];
const commentCount = (run: Run) => simState(run).issues.reduce((count, issue) => count + issue.comments.length, 0);
/** The body the held comment's effect writes. */
const heldBody = (state: Agenda | null) => { const held = heldComment(state); return held?.action.kind === 'comment' ? held.action.body : null; };

/** The attention keys of every Main notification, in order. */
const mainNotifications = (run: Run) => modelLog(run).filter(entry => entry.kind === 'main').map(entry => entry.note.slice(entry.note.indexOf(':') + 1).split(', '));

/**
 * Every restart-pm branch: the delivery and PM records hold, the held comment's effect is source-confirmed after
 * `attempts` sends, M never escalated, and GitHub recorded one comment request per Owner session.
 */
async function restartPmChecks(run: Run, attempts: number): Promise<string[]> {
  const failures = [...await commonChecks(run, {'m.txt': '1\n', 'm.verify': '1\n'}), ...await pmChecks(run)];
  const state = await agenda(run);
  const held = heldComment(state);
  const m = ticketOf(state, 'M');
  if (m?.notes.some(note => note.kind === 'escalation')) failures.push(`the interrupted comment escalated M: ${JSON.stringify(m.notes)}`);
  if (held?.state.kind !== 'confirmed') failures.push(`the interrupted comment effect is ${held?.state.kind}, not source-confirmed`);
  if (held?.attempt !== attempts) failures.push(`the interrupted comment effect was sent ${held?.attempt} times, not ${attempts}`);
  const sessions = owners(seatSessions(run, state!.id), 'M');
  const posts = readFileSync(join(run.github, 'requests.jsonl'), 'utf8').split('\n')
    .filter(line => line.includes('"method":"POST"') && /\/issues\/\d+\/comments"/.test(line) && !line.includes('"dropped":true'));
  if (sessions.length !== 3 || posts.length !== sessions.length) failures.push(`${posts.length} recorded comment POSTs for ${sessions.length} Owner sessions; expected one each for the first, the interrupted and the resumed Owner`);
  return failures;
}

/**
 * The kill lands while the held comment request has not reached GitHub. After resume the effect fails; the driver
 * then ends the held request with `outcome` and waits for its result, and lets Main retry once M is delivered.
 */
async function killBeforeWrite(run: Run, outcome: 'release' | 'drop'): Promise<void> {
  const markers = join(run.dir, 'markers');
  await waitUntil(run, 'the held impl comment request', () => existsSync(join(markers, 'comment-arrived')));
  if (commentCount(run) !== 1) throw new Error(`the held comment reached the simulated GitHub before the kill: ${commentCount(run)} comments`);
  await kill(run);
  start(run);
  await waitUntil(run, 'the interrupted comment failed', state => heldComment(state)?.state.kind === 'failed');
  const body = heldBody(await agenda(run));
  writeFileSync(join(markers, `${outcome}-comment`), '');
  if (outcome === 'release') await waitUntil(run, 'the late comment on the simulated GitHub', () => simState(run).issues.some(issue => issue.comments.some(comment => comment.body === body)));
  else await waitUntil(run, 'the held request dropped', () => readFileSync(join(run.github, 'requests.jsonl'), 'utf8').includes('"dropped":true'));
  await waitUntil(run, 'M delivered with the comment still failed', state => ticketOf(state, 'M')?.state === 'Done' && heldComment(state)?.state.kind === 'failed');
  writeFileSync(join(markers, 'retry-failed'), '');
  await waitUntil(run, 'completion after the retry', completed);
}

/** A branch Main settled by retry: the failed: notification, a refused finish, then the accepted retry, and one comment with the held body. */
async function retriedChecks(run: Run, attempts: number): Promise<string[]> {
  const failures = await restartPmChecks(run, attempts);
  const state = await agenda(run);
  const held = heldComment(state)!;
  const key = `failed:M:${held.id}`;
  if (!mainNotifications(run).some(keys => keys.includes(key))) failures.push(`Main was not woken for ${key}`);
  const calls = mainCalls(run);
  const resolved = calls.findIndex(call => call.input.op === 'resolve' && call.reply?.ok === true);
  const finishes = calls.slice(0, resolved < 0 ? calls.length : resolved).filter(call => call.input.op === 'finish');
  if (!finishes.some(call => call.reply?.ok === false && call.reply.error?.error?.kind === 'invalidTransition'))
    failures.push(`finish was not refused before the retry: ${JSON.stringify(finishes.map(call => call.reply))}`);
  if (resolved < 0 || JSON.stringify(calls[resolved]!.input.effects) !== JSON.stringify([{effectId: held.id, disposition: 'retry'}]))
    failures.push(`Main did not settle ${held.id} with an accepted retry: ${JSON.stringify(calls.filter(call => call.input.op === 'resolve'))}`);
  if (ticketOf(state, 'M')?.rulings.length !== 1) failures.push(`M took ${ticketOf(state, 'M')?.rulings.length} rulings, not the one retry`);
  const body = heldBody(state);
  const copies = simState(run).issues.flatMap(issue => issue.comments.filter(comment => comment.body === body)).length;
  if (copies !== 1) failures.push(`the simulated GitHub holds ${copies} comments with the held body, not one`);
  return failures;
}

const cases: Case[] = [
  {
    name: 'tree',
    files: TREE_FILES,
    issues: [{title: 'Parent', children: [2, 3, 4, 5, 6, 7, 8]}, {title: 'A1'}, {title: 'A2'}, {title: 'B1'}, {title: 'B2'}, {title: 'C'}, {title: 'D'}, {title: 'E'}],
    requiredChecks: [], ci: {default: 'SUCCESS', failMarker: null}, rootIssue: 1,
    scenario: () => ({parent: 1, closure: TREE_DONE, tickets: [
      ticket('A1', 2, [commit({'a1.txt': '1\n'})], {'a1.txt': '1\n'}),
      ticket('A2', 3, [commit({'a2.txt': '1\n'})], {'a2.txt': '1\n'}),
      ticket('B1', 4, [commit({'shared.txt': 'L1=1\nL2=0\n'})], {'shared.txt': 'L1=1\nL2=0\n'}),
      ticket('B2', 5, [commit({'shared.txt': 'L1=1\nL2=1\n'})], {'shared.txt': 'L1=1\nL2=1\n'}, {dependsOn: ['B1']}),
      // The first round omits c.verify, so both gates reject it and a forked Owner adds it.
      ticket('C', 6, [commit({'c.txt': '1\n'}), commit({'c.verify': '1\n'})], {'c.txt': '1\n', 'c.verify': '1\n'}),
      ticket('D', 7, [{kind: 'escalate', escalation: 'blocked', reason: 'Clauses demand d.txt=1 and d.txt=2.'}, commit({'d.txt': '1\n'})], {'d.txt': '1\n'},
        {rulings: [{to: 'Coding', ruling: 'Clause 1 governs: d.txt must be 1.'}]}),
      ticket('E', 8, [{kind: 'escalate', escalation: 'noCode', reason: 'e.txt is already 1.'}], {},
        {rulings: [{to: 'Closing', ruling: 'e.txt already satisfies the contract.', noCode: 'e.txt is already 1 on main.'}]}),
    ]}),
    async check(run) {
      const failures = await commonChecks(run, TREE_DONE);
      const state = await agenda(run);
      const sessions = seatSessions(run, state!.id);
      for (const id of ['C', 'D']) {
        const [first, second] = owners(sessions, id);
        if (!first || !second || second.parent !== first.id) failures.push(`${id} rework Owner is not a fork of its first Owner (${owners(sessions, id).map(item => `${item.id}<-${item.parent}`).join(', ')})`);
        if (!first || !second) continue;
        const header = (session: SeatSession) => session.lines.find(line => line.type === 'session');
        const firstKey = header(first)?.providerPromptCacheKey ?? first.id;
        if (header(second)?.providerPromptCacheKey !== firstKey) failures.push(`${id} rework Owner prompt cache key is ${String(header(second)?.providerPromptCacheKey)}, not ${String(firstKey)}`);
        // The fork starts with an empty todo list instead of its predecessor's; the first Owner never writes one.
        const reset = (session: SeatSession) => session.lines.some(line => line.type === 'custom' && line.customType === 'user_todo_edit' && JSON.stringify(line.data) === '{"phases":[]}');
        if (reset(first) || !reset(second)) failures.push(`${id} rework Owner did not reset its inherited todo list`);
      }
      for (const gate of sessions.filter(session => session.role !== 'owner')) if (gate.parent) failures.push(`${gate.ticket} ${gate.role} session inherited history`);
      // Every seat is a full native session: it may delegate and holds its bound dispatch tool.
      for (const session of sessions) {
        const init = session.lines.find(line => line.type === 'session_init');
        const tools = Array.isArray(init?.tools) ? init.tools : [];
        for (const name of ['task', 'dispatch']) if (!tools.includes(name)) failures.push(`${session.ticket} ${session.role} seat lacks ${name}: ${JSON.stringify(tools)}`);
        if (init?.spawns !== '*') failures.push(`${session.ticket} ${session.role} seat spawns ${JSON.stringify(init?.spawns)}, not "*"`);
      }
      if (ticketOf(state, 'E')?.terminal?.kind !== 'noCode') failures.push('E did not finish as noCode');
      if (state?.closure?.state !== 'Done') failures.push('closure is not Done');
      return failures;
    },
  },
  {
    name: 'ci',
    files: {'p.txt': '0\n', 'f.txt': '0\n'},
    issues: [{title: 'P'}, {title: 'F'}],
    requiredChecks: ['ci/sim'], ci: {default: 'PENDING', failMarker: 'BROKEN'}, rootIssue: 1,
    scenario: () => ({parent: null, closure: {}, tickets: [
      ticket('P', 1, [commit({'p.txt': '1\n'})], {'p.txt': '1\n'}),
      // The first round ships a file CI rejects; the forked Owner removes it.
      ticket('F', 2, [commit({'f.txt': '1\n', BROKEN: 'x\n'}), {kind: 'commit', write: {'f.txt': '1\n'}, remove: ['BROKEN']}], {'f.txt': '1\n'}),
    ]}),
    async drive(run) {
      // CI stays pending for three seconds after a PR head first appears, then passes, unless the commit is broken.
      const seen = new Map<string, number>(), flips: {sha: string; at: number}[] = [];
      await waitUntil(run, 'completion with CI', async state => {
        withState(run.github, sim => {
          for (const pr of sim.prs.filter(item => item.state === 'OPEN')) {
            if (sim.ci[pr.lastHead] || gitIn(run, ['cat-file', '-e', `${pr.lastHead}:BROKEN`]).code === 0) continue;
            const first = seen.get(pr.lastHead) ?? Date.now();
            seen.set(pr.lastHead, first);
            if (Date.now() - first >= 3000) { sim.ci[pr.lastHead] = 'SUCCESS'; flips.push({sha: pr.lastHead, at: Date.now()}); }
          }
        });
        return completed(state);
      });
      writeFileSync(join(run.dir, 'ci-flips.json'), JSON.stringify(flips));
    },
    async check(run) {
      const failures = await commonChecks(run, {'p.txt': '1\n', 'f.txt': '1\n'});
      const flips = z.array(z.object({sha: z.string(), at: z.number()})).parse(JSON.parse(readFileSync(join(run.dir, 'ci-flips.json'), 'utf8')));
      for (const entry of modelLog(run).filter(item => item.kind === 'seat' && item.role !== undefined && judgeSubjects(run.workflow).get(item.role) === 'pullRequest' && item.note === 'inspect')) {
        const flipped = flips.filter(flip => flip.at <= entry.at);
        if (!flipped.length) failures.push(`${entry.ticket} ${entry.role} started before any required check passed`);
      }
      const state = await agenda(run);
      if (!ticketOf(state, 'F')?.notes.some(note => note.kind === 'checks')) failures.push('F was never returned to Coding by failing CI');
      const [first, second] = owners(seatSessions(run, state!.id), 'F');
      if (!first || second?.parent !== first.id) failures.push('F rework Owner is not a fork');
      return failures;
    },
  },
  {
    name: 'head',
    files: {'h.txt': '0\n'},
    issues: [{title: 'H'}],
    requiredChecks: [], ci: {default: 'SUCCESS', failMarker: null}, rootIssue: 1,
    scenario: markers => ({parent: null, closure: {}, tickets: [
      // After submitting h.txt=1 the Owner pushes h.txt=2 to the same PR while both gates are seated on the first head.
      ticket('H', 1, [{kind: 'commit', write: {'h.txt': '1\n'}, after: {kind: 'push', waitFor: join(markers, 'move-head'), write: {'h.txt': '2\n'}}}], {'h.txt': '2\n'},
        {hold: {roles: ['review', 'accept'], marker: join(markers, 'release-gates')}}),
    ]}),
    async drive(run) {
      const markers = join(run.dir, 'markers');
      await waitUntil(run, 'both gates seated on the first head', () => {
        const inspecting = modelLog(run).filter(entry => entry.ticket === 'H' && entry.note === 'inspect').map(entry => entry.role);
        return inspecting.includes('review') && inspecting.includes('accept');
      });
      writeFileSync(join(markers, 'move-head'), '');
      await waitUntil(run, 'the new head to restart the gates', state => ticketOf(state, 'H')?.notes.some(note => note.text.startsWith('Open PR changed to head')) ?? false);
      writeFileSync(join(markers, 'release-gates'), '');
      await waitUntil(run, 'completion', completed);
    },
    async check(run) {
      const failures = await commonChecks(run, {'h.txt': '2\n'});
      const state = await agenda(run);
      const notes = ticketOf(state, 'H')?.notes ?? [];
      if (notes.some(note => note.kind === 'escalation' || note.text.includes('changed after approval'))) failures.push(`H escalated on a legitimate PR update: ${JSON.stringify(notes)}`);
      const sessions = seatSessions(run, state!.id);
      // The superseded gates are aborted at their next tool boundary, so no verdict on the first head may be accepted.
      if (acceptedVerdicts(sessions).some(verdict => verdict.ticket === 'H' && verdict.note.includes('h.txt="1\\n"'))) failures.push('a gate on the superseded head had its verdict accepted');
      const reviews = sessions.filter(session => session.ticket === 'H' && session.role === 'review');
      if (reviews.length < 2) failures.push(`expected a fresh review seat for the new head, found ${reviews.length}`);
      return failures;
    },
  },
  {
    name: 'abandon',
    files: {'q.txt': '0\n'},
    issues: [{title: 'Q'}],
    requiredChecks: [], ci: {default: 'SUCCESS', failMarker: null}, rootIssue: 1,
    scenario: () => ({parent: null, closure: {}, tickets: [
      // The first review judge's model request fails; Main resolves it back to Coding, and the next judge passes.
      ticket('Q', 1, [{kind: 'quit'}, commit({'q.txt': '1\n'})], {'q.txt': '1\n'}, {
        judgeFailure: {role: 'review', message: 'sim rate limit'},
        rulings: [{to: 'Coding', ruling: 'Try again.'}, {to: 'Coding', ruling: 'Try the review again.'}]}),
    ]}),
    async check(run) {
      const failures = await commonChecks(run, {'q.txt': '1\n'});
      const state = await agenda(run);
      const notes = ticketOf(state, 'Q')?.notes ?? [];
      if (!notes.some(note => note.text.endsWith('the session ended without submit, verdict, or escalate'))) failures.push(`the abandoned Owner's escalation note is wrong: ${JSON.stringify(notes)}`);
      if (!notes.some(note => note.kind === 'escalation' && note.text.endsWith('the model request failed: sim rate limit'))) failures.push(`the failed review seat's escalation lost the provider error: ${JSON.stringify(notes)}`);
      if (!modelLog(run).some(entry => entry.kind === 'main' && entry.note.includes('escalated:Q:'))) failures.push('Main was not woken for the abandoned seat');
      const seats = owners(seatSessions(run, state!.id), 'Q');
      // The abandoned seat and the round-1 seat are fresh; the rework after the failed review is a fork of round 1.
      const [abandoned, round1, rework] = seats;
      if (seats.length !== 3 || abandoned?.parent || round1?.parent || rework?.parent !== round1?.id) failures.push(`expected fresh Owner sessions then a fork of round 1, found ${seats.map(seat => `${seat.id}<-${seat.parent}`).join(', ')}`);
      return failures;
    },
  },
  {
    name: 'restart',
    files: {'k.txt': '0\n'},
    issues: [{title: 'K'}],
    requiredChecks: [], ci: {default: 'SUCCESS', failMarker: null}, rootIssue: 1,
    scenario: markers => ({parent: null, closure: {}, tickets: [
      // The Owner stays busy after its handoff; the gates reject, and the process dies while the Owner is mid-tool.
      ticket('K', 1, [{kind: 'commit', write: {'k.txt': '1\n'}, after: {kind: 'block', marker: join(markers, 'never')}}, commit({'k.verify': '1\n'})], {'k.txt': '1\n', 'k.verify': '1\n'}),
    ]}),
    async drive(run) {
      await waitUntil(run, 'K back in Coding with its Owner mid-tool', state => {
        const ticket = ticketOf(state, 'K');
        return ticket?.state === 'Coding' && ticket.revision >= 2 && modelLog(run).some(entry => entry.ticket === 'K' && entry.role === 'owner' && entry.note.startsWith('round 0 step 2'));
      });
      await kill(run);
      // The resumed agenda keeps the workflow it was convened with; a different file only shapes the next convene.
      const reviewing = SIM_WORKFLOW.ticket.states.Reviewing!;
      const audited: Workflow = {...SIM_WORKFLOW, ticket: {...SIM_WORKFLOW.ticket, states: {...SIM_WORKFLOW.ticket.states, Reviewing: {...reviewing, kind: 'judge', judges: [{role: 'audit', agent: 'sim-seat', brief: 'Audit the PR.'}]} as TicketState}}};
      writeFileSync(join(run.data, 'workflow.yml'), JSON.stringify(encodeWorkflow(audited)));
      start(run);
      await waitUntil(run, 'completion after resume', completed);
    },
    async check(run) {
      const failures = await commonChecks(run, {'k.txt': '1\n', 'k.verify': '1\n'});
      if (!modelLog(run).some(entry => entry.kind === 'main' && dispatchInput(entry)?.op === 'resume')) failures.push('Main did not resume the saved agenda');
      const state = await agenda(run);
      const sessions = seatSessions(run, state!.id);
      if (sessions.some(session => session.role === 'audit')) failures.push('the resumed agenda seated a role from the rewritten workflow file');
      if (!Bun.deepEquals(state?.workflow, SIM_WORKFLOW, true)) failures.push(`the agenda workflow changed after resume: ${JSON.stringify(state?.workflow)}`);
      const [source, fork] = owners(sessions, 'K');
      if (!source || !fork || fork.parent !== source.id) return [...failures, 'K rework Owner is not a fork of the interrupted Owner'];
      const message = (line: SeatSession['lines'][number]) => z.object({message: z.object({role: z.string(), content: z.unknown(), toolCallId: z.string().optional(), usage: z.object({cost: z.object({total: z.number()})}).optional()}).passthrough()}).safeParse(line);
      const sourceMessages = source.lines.filter(line => line.type === 'message').map(message).flatMap(item => item.success ? [item.data.message] : []);
      const forkMessages = fork.lines.filter(line => line.type === 'message').map(message).flatMap(item => item.success ? [item.data.message] : []);
      const callIds = (messages: typeof sourceMessages) => messages.flatMap(item => item.role === 'assistant' && Array.isArray(item.content) ? item.content.flatMap(block => typeof block === 'object' && block !== null && 'type' in block && block.type === 'toolCall' && 'id' in block && typeof block.id === 'string' ? [block.id] : []) : []);
      const answered = (messages: typeof sourceMessages) => new Set(messages.flatMap(item => item.role === 'toolResult' && item.toolCallId ? [item.toolCallId] : []));
      const dangling = callIds(sourceMessages).filter(id => !answered(sourceMessages).has(id));
      if (!dangling.length) failures.push('the killed Owner session has no interrupted tool call, so tail repair was not exercised');
      for (const id of dangling) if (!answered(forkMessages).has(id)) failures.push(`fork left tool call ${id} unanswered`);
      const continueAt = forkMessages.findIndex(item => item.role === 'user' && JSON.stringify(item.content).includes('Continue ticket K'));
      const inherited = forkMessages.slice(0, continueAt).filter(item => item.role === 'assistant');
      if (!inherited.length || inherited.some(item => item.usage?.cost.total !== 0)) failures.push(`inherited assistant cost not reset: ${inherited.map(item => item.usage?.cost.total).join(',')}`);
      if (!sourceMessages.some(item => item.role === 'assistant' && (item.usage?.cost.total ?? 0) > 0)) failures.push('source Owner had no cost to reset');
      return failures;
    },
  },
  {
    // The comment is recorded before the kill and only its response is lost: after resume the next GitHub read
    // confirms it, Main is never asked about it, and M takes no ruling.
    name: 'restart-pm/arrived',
    pm: {holdComment: {skip: 1, at: 'afterWrite'}},
    ...RESTART_PM,
    scenario: () => ({parent: null, closure: {}, tickets: [RESTART_PM_TICKET]}),
    async drive(run) {
      await waitUntil(run, 'the held impl comment recorded', () => existsSync(join(run.dir, 'markers', 'comment-arrived')));
      if (commentCount(run) !== 2) throw new Error(`the held comment is not on the simulated GitHub before the kill: ${commentCount(run)} comments`);
      await kill(run);
      writeFileSync(join(run.dir, 'markers', 'release-comment'), '');
      start(run);
      await waitUntil(run, 'completion after resume', completed);
    },
    async check(run) {
      const failures = await restartPmChecks(run, 1);
      const m = ticketOf(await agenda(run), 'M');
      if (m?.rulings.length) failures.push(`M took rulings: ${JSON.stringify(m.rulings)}`);
      const failed = mainNotifications(run).flat().filter(key => key.startsWith('failed:'));
      if (failed.length) failures.push(`Main was woken for ${failed.join(', ')}`);
      return failures;
    },
  },
  {
    // The kill lands before the comment is recorded. Resume finds no comment, so the effect fails, Main is woken with
    // failed:M:<effect> and finish is refused. The killed process's request reaches GitHub late, and Main's
    // resolve with retry adopts that source copy as confirmed without sending it again.
    name: 'restart-pm/lost',
    pm: {holdComment: {skip: 1, at: 'beforeWrite'}},
    ...RESTART_PM,
    scenario: markers => ({parent: null, closure: {}, retryFailed: join(markers, 'retry-failed'), tickets: [RESTART_PM_TICKET]}),
    drive: run => killBeforeWrite(run, 'release'),
    check: run => retriedChecks(run, 1),
  },
  {
    // As lost, but the killed process's request never reaches GitHub: Main's resolve with retry sends the comment
    // again, and the next GitHub read confirms it.
    name: 'restart-pm/dropped',
    pm: {holdComment: {skip: 1, at: 'beforeWrite'}},
    ...RESTART_PM,
    scenario: markers => ({parent: null, closure: {}, retryFailed: join(markers, 'retry-failed'), tickets: [RESTART_PM_TICKET]}),
    drive: run => killBeforeWrite(run, 'drop'),
    check: run => retriedChecks(run, 2),
  },
  {
    name: 'flow',
    // A workflow unlike the built-in one: renamed and added states, a security judge skipped on rework by an entry guard,
    // a security rejection routed to Main instead of rework, a post-merge judge only on a conditional branch, and its own parent machine.
    workflow: workflowOf({
      ticket: {initial: 'Build', adopted: {pullRequest: 'WaitCi', mergeCommit: 'Close'}, states: {
        Build: {kind: 'work', role: 'builder', agent: 'sim-builder', brief: 'BUILD-DUTY deliver the ticket.', on: {submitted: 'Open', escalated: 'escalate'}},
        Open: {kind: 'action', action: 'publishPr', on: {done: 'WaitCi'}},
        WaitCi: {kind: 'decision', branches: [{when: {all: [{checks: 'passing'}, {mergeable: 'yes'}]}, to: 'Security'}],
          observe: {checksFailed: 'Build', conflict: 'Build', behind: 'Build', drift: 'WaitCi'}},
        Security: {kind: 'judge', subject: 'pullRequest', when: {not: {visits: {state: 'Build', atLeast: 2}}}, otherwise: 'Quality',
          judges: [{role: 'security', agent: 'sim-security', brief: 'SECURITY-DUTY judge the PR.'}],
          observe: {checksFailed: 'Build', conflict: 'Build', behind: 'Build', drift: 'WaitCi'}, on: {passed: 'Quality', rejected: 'escalate', escalated: 'escalate'}},
        Quality: {kind: 'judge', subject: 'pullRequest', judges: [{role: 'quality', agent: 'sim-quality', brief: 'QUALITY-DUTY judge the PR.'}],
          observe: {checksFailed: 'Build', conflict: 'Build', behind: 'Build', drift: 'WaitCi'}, on: {passed: 'Ship', rejected: 'Build', escalated: 'escalate'}},
        Ship: {kind: 'action', action: 'merge', requires: ['Quality'], observe: {checksFailed: 'Build', conflict: 'Build', behind: 'Build'},
          on: {done: [{when: {visits: {state: 'Build', atLeast: 2}}, to: 'Deploy'}, {to: 'Close'}]}},
        Deploy: {kind: 'judge', subject: 'mergeCommit', judges: [{role: 'deploy', agent: 'sim-deploy', brief: 'DEPLOY-DUTY verify the merge.'}], on: {passed: 'Close', rejected: 'escalate', escalated: 'escalate'}},
        Close: {kind: 'action', action: 'closeIssue', on: {done: 'Delivered'}},
        Delivered: {kind: 'final'},
      }},
      parent: {initial: 'Release', states: {
        Release: {kind: 'judge', judges: [{role: 'release', agent: 'sim-release', brief: 'RELEASE-DUTY judge the parent.'}, {role: 'compliance', agent: 'sim-compliance', brief: 'COMPLIANCE-DUTY judge the parent.'}],
          on: {passed: 'CloseParent', rejected: 'escalate', escalated: 'escalate'}},
        CloseParent: {kind: 'action', action: 'closeParent', requires: ['Release'], on: {done: 'Finished'}},
        Finished: {kind: 'final'},
      }},
    }),
    files: {'f1.txt': '0\n', 'f2.txt': '0\n', 'f3.txt': '0\n'},
    issues: [{title: 'Parent', children: [2, 3, 4]}, {title: 'F1'}, {title: 'F2'}, {title: 'F3'}],
    requiredChecks: [], ci: {default: 'SUCCESS', failMarker: null}, rootIssue: 1,
    scenario: () => ({parent: 1, closure: {'f1.txt': '1\n', 'f2.txt': '1\n', 'f2.verify': '1\n', 'f3.txt': '1\n'}, tickets: [
      // Passes first time: Security, Quality, then straight to Close.
      ticket('F1', 2, [commit({'f1.txt': '1\n'})], {'f1.txt': '1\n'}),
      // Security accepts round one; Quality demands f2.verify, so the builder reworks and Security is skipped the second time.
      ticket('F2', 3, [commit({'f2.txt': '1\n'}), commit({'f2.verify': '1\n'})], {'f2.txt': '1\n', 'f2.verify': '1\n'}, {judgeExpect: {security: {'f2.txt': '1\n'}}}),
      // Security rejects round one, which this workflow routes to Main rather than back to Build.
      ticket('F3', 4, [commit({'f3.txt': 'bad\n'}), commit({'f3.txt': '1\n'})], {'f3.txt': '1\n'}, {rulings: [{to: 'Build', ruling: 'The security finding stands: f3.txt must be 1.'}]}),
    ]}),
    async check(run) {
      const failures = await commonChecks(run, {'f1.txt': '1\n', 'f2.txt': '1\n', 'f2.verify': '1\n', 'f3.txt': '1\n'},
        {F1: ['security', 'quality'], F2: ['security', 'quality', 'deploy'], F3: ['security', 'quality', 'deploy']});
      const state = await agenda(run);
      const sessions = seatSessions(run, state!.id);
      const visits = (id: string) => ticketOf(state, id)?.visits ?? {};
      const seats = (id: string, role: string) => sessions.filter(session => session.ticket === id && session.role === role).length;
      for (const id of ['F1', 'F2', 'F3']) if (ticketOf(state, id)?.state !== 'Delivered') failures.push(`${id} ended in ${ticketOf(state, id)?.state}, not Delivered`);
      // Entry guard: Security is entered once per ticket; the rework passes straight to Quality.
      for (const id of ['F2', 'F3']) if (visits(id).Security !== 1 || seats(id, 'security') !== 1) failures.push(`${id} entered Security ${visits(id).Security} times with ${seats(id, 'security')} seats, not once`);
      if (visits('F2').Quality !== 2 || seats('F2', 'quality') !== 2) failures.push(`F2 entered Quality ${visits('F2').Quality} times, not twice`);
      // Rerouted failure: F3's security rejection went to Main, and only Main's ruling returned it to Build.
      const f3 = ticketOf(state, 'F3');
      const finding = f3?.notes.findIndex(item => item.kind === 'finding' && item.author.kind === 'seat' && item.author.role === 'security') ?? -1;
      if (finding < 0 || f3?.notes[finding + 1]?.text !== 'The workflow routed this ticket to Main.' || f3.notes[finding + 2]?.kind !== 'ruling') failures.push(`F3 security rejection did not go straight to Main: ${JSON.stringify(f3?.notes)}`);
      if (!modelLog(run).some(entry => entry.kind === 'main' && entry.note.includes('escalated:F3:'))) failures.push('Main was not woken for F3');
      // Conditional branch after merge: only reworked tickets pass through Deploy.
      if (visits('F1').Deploy !== undefined || seats('F1', 'deploy') !== 0) failures.push('F1 passed Deploy although it was never reworked');
      for (const id of ['F2', 'F3']) if (visits(id).Deploy !== 1) failures.push(`${id} did not pass Deploy after its rework`);
      // Each seat ran its own agent and carried only its own duty.
      const duties: Record<string, {agent: string; duty: string}> = {builder: {agent: 'sim-builder', duty: 'BUILD-DUTY'}, security: {agent: 'sim-security', duty: 'SECURITY-DUTY'}, quality: {agent: 'sim-quality', duty: 'QUALITY-DUTY'},
        deploy: {agent: 'sim-deploy', duty: 'DEPLOY-DUTY'}, release: {agent: 'sim-release', duty: 'RELEASE-DUTY'}, compliance: {agent: 'sim-compliance', duty: 'COMPLIANCE-DUTY'}};
      for (const session of sessions) {
        const seat = duties[session.role];
        if (!seat) { failures.push(`${session.ticket} seated unconfigured role ${session.role}`); continue; }
        const init = session.lines.find(line => line.type === 'session_init');
        if (init?.agent !== seat.agent) failures.push(`${session.ticket} ${session.role} ran agent ${JSON.stringify(init?.agent)}, not ${seat.agent}`);
        const raw = JSON.stringify(session.lines);
        for (const [role, other] of Object.entries(duties)) if (raw.includes(other.duty) !== (role === session.role)) failures.push(`${session.ticket} ${session.role} brief ${role === session.role ? 'lacks its' : 'carries the'} ${other.duty}`);
      }
      const closure = state?.closure;
      if (closure?.state !== 'Finished' || closure.gates.Release?.verdicts.map(item => `${item.role}:${item.status}`).join(',') !== 'release:passed,compliance:passed') failures.push(`the parent machine did not finish through both Release judges: ${JSON.stringify(closure)}`);
      return failures;
    },
  },
];
// PM-on variant of tree: the same delivery, plus the PM records it must leave.
const tree = cases.find(item => item.name === 'tree')!;
cases.push({...tree, name: 'tree-pm', pm: {holdComment: null}, check: async run => [...await tree.check(run), ...await pmChecks(run)]});
cases.push(...askCases({agenda, waitUntil, start, kill, modelLog, seatSessions, simState, commonChecks}));

/* ------------------------------------------------------------ main */

// A name selects that scenario and its branches, `name/<branch>`.
const selected = process.argv.slice(2);
let failed = false;
for (const spec of cases.filter(item => !selected.length || selected.some(name => item.name === name || item.name.startsWith(`${name}/`)))) {
  const run = setup(spec);
  const began = Date.now();
  let failures: string[];
  try {
    start(run);
    await (spec.drive ?? (async () => waitUntil(run, 'completion', completed)))(run);
    await stop(run);
    failures = await spec.check(run);
  } catch (error) {
    await kill(run);
    failures = [error instanceof Error ? error.message : String(error)];
  }
  failed ||= failures.length > 0;
  console.log(`${failures.length ? 'FAIL' : 'PASS'} ${spec.name} (${((Date.now() - began) / 1000).toFixed(1)}s) ${run.dir}`);
  for (const failure of failures) console.log(`  - ${failure}`);
}
process.exit(failed ? 1 : 0);
