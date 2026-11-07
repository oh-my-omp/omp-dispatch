// PM ask scenarios: an Owner's question goes to the intent guardians instead of Main. The guardians are a fake
// HTTP endpoint inside this driver process that records every POST /v1/asks and answers 202 for a comment it has
// not seen and 200 for a repeat, as the real guardians do.

import {readFileSync} from 'node:fs';
import {z} from '@oh-my-pi/omptype/zod';
import type {Agenda} from '../../src/domain/model.ts';
import {parseMarker} from '../../src/pm/markers.ts';
import type {SimState} from './github-sim.ts';
import type {Case, LogEntry, Run, SeatSession} from './run.ts';

/** The run.ts helpers these scenarios drive and observe through. */
export type SimApi = {
  agenda: (run: Run) => Promise<Agenda | null>;
  waitUntil: (run: Run, label: string, ready: (state: Agenda | null) => boolean | Promise<boolean>) => Promise<void>;
  start: (run: Run) => void;
  kill: (run: Run) => Promise<void>;
  modelLog: (run: Run) => LogEntry[];
  seatSessions: (run: Run, agendaId: string) => SeatSession[];
  simState: (run: Run) => SimState;
};

const askSchema = z.object({issue: z.string(), comment: z.number(), question: z.string(), tier: z.enum(['simple', 'complex'])}).strict();
type Received = {request: z.infer<typeof askSchema>; status: 200 | 202};

/** The fake guardians. `holdFirst` keeps the first response back until `release()`, as if its caller died waiting. */
const guardians = (() => {
  let received: Received[] = [];
  let held: {promise: Promise<void>; resolve: () => void} | null = null;
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/v1/asks') return new Response('not found', {status: 404});
    const parsed = askSchema.safeParse(await request.json());
    if (!parsed.success) return new Response(parsed.error.message, {status: 400});
    const status = received.some(item => item.request.comment === parsed.data.comment) ? 200 : 202;
    received.push({request: parsed.data, status});
    if (held && received.length === 1) await held.promise;
    return Response.json({ask: parsed.data.comment}, {status});
  }});
  server.unref();
  return {
    url: `http://127.0.0.1:${server.port}`,
    reset(holdFirst: boolean): void { received = []; held = holdFirst ? Promise.withResolvers<void>() : null; },
    release(): void { held?.resolve(); },
    received: (): Received[] => received,
  };
})();

/** A port no process listens on: a server bound to it is stopped before any scenario runs. */
const unreachable = await (async () => {
  const probe = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response('')});
  const url = `http://127.0.0.1:${probe.port}`;
  await probe.stop(true);
  return url;
})();

const QUESTION = 'Should the cache key include the tenant id, or is one cache per process enough?';
const ISSUE = 'sim/arena#1';

const messageSchema = z.object({type: z.literal('message'), message: z.object({role: z.string(), content: z.unknown(), stopReason: z.string().optional(), errorMessage: z.string().optional()}).passthrough()}).passthrough();
const blockSchema = z.object({type: z.string(), name: z.string().optional(), arguments: z.object({input: z.object({op: z.string()}).passthrough()}).passthrough().optional()}).passthrough();

/**
 * Why the Owner's transcript does not end right after its question: it must hold the accepted escalate, then at most
 * the aborted turn Dispatch's stop leaves, with no content and the guardians as its reason. Null when it does.
 */
function abortProblem(session: SeatSession): string | null {
  const messages = session.lines.flatMap(line => { const parsed = messageSchema.safeParse(line); return parsed.success ? [parsed.data.message] : []; });
  const asked = messages.findIndex(message => message.role === 'assistant' && Array.isArray(message.content)
    && message.content.some(block => { const parsed = blockSchema.safeParse(block); return parsed.success && parsed.data.name === 'dispatch' && parsed.data.arguments?.input.op === 'escalate'; }));
  if (asked < 0) return 'the Owner transcript has no escalate call';
  const answered = messages.findIndex((message, index) => index > asked && message.role === 'toolResult');
  if (answered < 0 || !JSON.stringify(messages[answered]!.content).includes('\\"ok\\":true')) return 'the Owner escalate was not accepted';
  const after = messages.slice(answered + 1);
  const stray = after.find(message => message.role !== 'assistant' || message.stopReason !== 'aborted' || (Array.isArray(message.content) && message.content.length > 0));
  if (stray) return `the Owner transcript continues after its question: ${JSON.stringify(stray).slice(0, 300)}`;
  if (!after.some(message => message.errorMessage?.includes('intent guardians'))) return `the Owner transcript has no abort for the guardians after its question: ${JSON.stringify(after)}`;
  return null;
}

export function askCases(sim: SimApi): Case[] {
  const askState = (state: Agenda | null) => state?.effects.find(effect => effect.action.kind === 'requestAnswer')?.state.kind;
  const owners = async (run: Run): Promise<SeatSession[]> => { const state = await sim.agenda(run); return state ? sim.seatSessions(run, state.id).filter(session => session.role === 'owner') : []; };
  /** The Owner's session has stopped: its transcript ends at its question with Dispatch's abort. */
  const stopped = async (run: Run): Promise<boolean> => { const [owner] = await owners(run); return owner !== undefined && abortProblem(owner) === null; };

  /** What every ask scenario must leave: one Owner, aborted at its question; one ask comment; the ticket Asking. */
  async function asked(run: Run, tier: 'simple' | 'complex'): Promise<string[]> {
    const failures: string[] = [];
    const state = await sim.agenda(run), github = sim.simState(run);
    const unhandled = readFileSync(`${run.github}/requests.jsonl`, 'utf8').split('\n').filter(line => line.includes('"unhandled":true'));
    if (unhandled.length) failures.push(`simulated GitHub got ${unhandled.length} unmodelled requests, first: ${unhandled[0]!.slice(0, 400)}`);
    const sessions = await owners(run);
    if (sessions.length !== 1) failures.push(`expected exactly one Owner session, found ${sessions.length}`);
    const [owner] = sessions;
    // The stop reaches the agent loop through its event stream, after the loop may already have opened the next model
    // request; that request is cut before any content, so the transcript, not the provider log, is the evidence.
    if (owner) { const problem = abortProblem(owner); if (problem) failures.push(problem); }
    const comments = github.issues.find(issue => issue.number === 1)?.comments ?? [];
    const markers = comments.flatMap(comment => { const read = parseMarker(comment.id, comment.body); return read.kind === 'marker' ? [{comment, fact: read.fact}] : []; });
    const asks = markers.filter(item => item.fact.kind === 'ask');
    if (asks.length !== 1) failures.push(`expected one ask comment, found ${asks.length}`);
    const ask = asks[0];
    if (ask) {
      if (ask.fact.kind === 'ask' && (ask.fact.json.tier !== tier || ask.fact.json.session !== owner?.id)) failures.push(`ask marker ${JSON.stringify(ask.fact.json)} does not carry tier ${tier} and session ${owner?.id}`);
      if (ask.comment.body.slice(0, ask.comment.body.lastIndexOf('\n\n')) !== QUESTION) failures.push(`ask comment body is not the question verbatim: ${JSON.stringify(ask.comment.body)}`);
      const order = markers.map(item => item.fact.kind).join(',');
      if (order !== 'impl,ask') failures.push(`issue markers are ${order}, not impl then ask`);
    }
    const ticket = state?.tickets[0];
    if (ticket?.state !== 'Asking') failures.push(`ticket is ${ticket?.state}, not Asking`);
    if (ticket?.ask?.question !== QUESTION || ticket.ask.tier !== tier || ticket.ask.session !== owner?.id || ticket.ask.file !== owner?.file || ticket.ask.comment !== (ask?.comment.id ?? null))
      failures.push(`ticket ask ${JSON.stringify(ticket?.ask)} does not name the question, tier, Owner session and ask comment`);
    return failures;
  }
  const mainWoken = (run: Run) => sim.modelLog(run).filter(entry => entry.kind === 'main' && !entry.note.endsWith(':start')).map(entry => entry.note);
  const base = {
    files: {'a.txt': '0\n'}, issues: [{title: 'A'}], requiredChecks: [], ci: {default: 'SUCCESS' as const, failMarker: null}, rootIssue: 1,
    scenario: (tier: 'simple' | 'complex' | undefined) => () => ({parent: null, closure: {}, tickets: [
      {id: 'A', issue: 1, dependsOn: [], gate: {}, owner: [{kind: 'escalate' as const, escalation: 'question' as const, reason: QUESTION, ...(tier ? {tier} : {})}]},
    ]}),
  };

  return [
    {
      ...base, name: 'ask', pm: {holdComment: null, guardiansURL: guardians.url}, scenario: base.scenario('complex'),
      async drive(run) {
        guardians.reset(false);
        await sim.waitUntil(run, 'the guardians request confirmed and the Owner stopped', async state => askState(state) === 'confirmed' && await stopped(run));
      },
      async check(run) {
        const failures = await asked(run, 'complex');
        const state = await sim.agenda(run);
        const received = guardians.received(), comment = state?.tickets[0]?.ask?.comment;
        if (received.length !== 1 || JSON.stringify(received[0]) !== JSON.stringify({request: {issue: ISSUE, comment, question: QUESTION, tier: 'complex'}, status: 202}))
          failures.push(`the guardians received ${JSON.stringify(received)}, not one request for comment ${comment} answered 202`);
        const woken = mainWoken(run);
        if (woken.length) failures.push(`Main was woken: ${woken.join('; ')}`);
        return failures;
      },
    },
    {
      // The coordinator dies while the guardians hold their answer; after resume the request is sent again and answered 200.
      ...base, name: 'ask-restart', pm: {holdComment: null, guardiansURL: guardians.url}, scenario: base.scenario('complex'),
      async drive(run) {
        guardians.reset(true);
        await sim.waitUntil(run, 'the guardians request executing', state => askState(state) === 'executing' && guardians.received().length === 1);
        await sim.kill(run);
        guardians.release();
        sim.start(run);
        await sim.waitUntil(run, 'the repeated guardians request confirmed after resume', state => askState(state) === 'confirmed');
      },
      async check(run) {
        const failures = await asked(run, 'complex');
        const state = await sim.agenda(run);
        const comment = state?.tickets[0]?.ask?.comment;
        const request = {issue: ISSUE, comment, question: QUESTION, tier: 'complex'};
        const received = guardians.received();
        if (JSON.stringify(received) !== JSON.stringify([{request, status: 202}, {request, status: 200}])) failures.push(`the guardians received ${JSON.stringify(received)}, not the request then its repeat answered 200`);
        const effect = state?.effects.find(item => item.action.kind === 'requestAnswer');
        if (effect?.attempt !== 2 || effect.state.kind !== 'confirmed' || effect.state.result.kind !== 'answerRequested' || effect.state.result.status !== 200) failures.push(`the guardians request effect is ${JSON.stringify(effect)}`);
        if (state?.effects.filter(item => item.action.kind === 'requestAnswer').length !== 1) failures.push('more than one guardians request was queued');
        if (!sim.modelLog(run).some(entry => entry.kind === 'main' && entry.step.name === 'dispatch' && JSON.stringify(entry.step.args).includes('"op":"resume"'))) failures.push('Main did not resume the saved agenda');
        const woken = mainWoken(run);
        if (woken.length) failures.push(`Main was woken: ${woken.join('; ')}`);
        return failures;
      },
    },
    {
      // Row 3: nothing listens at the guardians address; the request fails with the connection error and wakes Main.
      ...base, name: 'ask-unreachable', pm: {holdComment: null, guardiansURL: unreachable}, scenario: base.scenario(undefined),
      async drive(run) {
        guardians.reset(false);
        await sim.waitUntil(run, 'the failed guardians request reaching Main', async state => askState(state) === 'failed' && mainWoken(run).some(note => note.includes('failed:A:')) && await stopped(run));
      },
      async check(run) {
        const failures = await asked(run, 'simple');
        const state = await sim.agenda(run);
        const effect = state?.effects.find(item => item.action.kind === 'requestAnswer');
        if (effect?.state.kind !== 'failed' || !effect.state.error.message.startsWith(`POST ${unreachable}/v1/asks: `)) failures.push(`the guardians request is ${JSON.stringify(effect?.state)}, not failed with the connection error`);
        else console.log(`  ask-unreachable failure text: ${effect.state.error.message}`);
        if (!mainWoken(run).some(note => note.includes(`failed:A:${effect?.id}`))) failures.push(`Main was not woken for failed:A:${effect?.id}: ${mainWoken(run).join('; ')}`);
        if (guardians.received().length) failures.push('the fake guardians were called');
        return failures;
      },
    },
  ];
}
