// The scripted model for the state-flow simulation. Loaded into the real omp
// process with `-e`, it registers the `sim` provider that both Main
// (`--model sim/main`) and every seat (agent model `sim/seat`) talk to. Each
// call is answered from what omp actually sent: the Main notifications, the
// seat brief, and the results of earlier tool calls in the same session.
// Script state lives in the transcript, not in module memory, so a forked or
// resumed session continues exactly where its history says it is.

import {appendFileSync, readFileSync} from 'node:fs';
import {createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model, type SimpleStreamOptions, type ToolCall} from '@oh-my-pi/pi-ai';
import type {ExtensionAPI} from '@oh-my-pi/pi-coding-agent';
import {z} from '@oh-my-pi/omptype/zod';
import {scenarioSchema, type Expect, type OwnerRound, type TicketSpec} from './scenario.ts';

const scenarioPath = process.env.SIM_SCENARIO;
if (!scenarioPath) throw new Error('SIM_SCENARIO must name the scenario JSON');
const scenario = scenarioSchema.parse(JSON.parse(readFileSync(scenarioPath, 'utf8')));
const repo = scenario.repo;
let callCounter = 0;

type Message = Context['messages'][number];
type Step = {call: {name: string; args: Record<string, unknown>}} | {text: string} | {fail: string};
type Played = {op: string | null; result: string};
/** The `{ok, value}` envelope the dispatch tool returns, with the few fields the script branches on. */
const replySchema = z.object({ok: z.boolean(), value: z.object({
  launchable: z.array(z.string()).optional(),
  ticket: z.object({state: z.string(), revision: z.number(), rulings: z.array(z.unknown())}).optional(),
}).passthrough().optional(), error: z.object({kind: z.string(), error: z.object({kind: z.string()}).passthrough().optional()}).passthrough().optional()}).passthrough();
type Reply = z.infer<typeof replySchema>;
// Ticket notes are objects with `text`; closure notes are plain strings.
const briefTicketSchema = z.object({id: z.string(), revision: z.number(), notes: z.array(z.unknown()).optional()}).passthrough();
const intentSchema = z.object({required: z.array(z.string()).optional()}).passthrough();

const text = (message: Message): string => typeof message.content === 'string' ? message.content
  : message.content.map(block => block.type === 'text' ? block.text : '').join('');
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** The calls of `tool` (any tool when null) made after `from`, paired with their results, in order. */
function played(messages: Message[], from: number, tool: string | null): Played[] {
  const out: Played[] = [];
  for (let index = from; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type !== 'toolCall' || tool !== null && block.name !== tool) continue;
      const result = messages.slice(index + 1).find(item => item.role === 'toolResult' && item.toolCallId === block.id);
      const input = block.arguments.input;
      const op = typeof input === 'object' && input !== null && 'op' in input && typeof input.op === 'string' ? input.op : null;
      out.push({op, result: result ? text(result) : ''});
    }
  }
  return out;
}

/** The latest prompt-like message (user, developer or converted custom notification), optionally matching `marker`. */
function lastUser(messages: Message[], marker?: RegExp): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'assistant' && message.role !== 'toolResult' && (!marker || marker.test(text(message)))) return index;
  }
  return -1;
}

function parseReply(result: string): Reply {
  try {
    const parsed = replySchema.safeParse(JSON.parse(result));
    return parsed.success ? parsed.data : {ok: false};
  } catch { return {ok: false}; }
}

/* ------------------------------------------------------------------ Main */

/** A dispatch call, or a shell command Main runs to wait for the driver. */
type Ask = {input: Record<string, unknown>} | {shell: string};
type MainPlan = Generator<Ask, void, Reply>;

function* startPlan(trigger: string): MainPlan {
  if (scenario.resumeFirst) yield {input: {op: 'resume', agenda: scenario.resumeFirst}};
  const saved = /Saved agendas: active: ([0-9a-f-]{36})/.exec(trigger);
  const reference = (issue: number) => `${repo.owner}/${repo.name}#${issue}`;
  const target = `${repo.owner}/${repo.name}@main`;
  const opened = saved
    ? yield {input: {op: 'resume', agenda: saved[1]}}
    : yield {input: {op: 'convene', ...(scenario.parent === null ? {} : {parent: reference(scenario.parent)}),
        tickets: scenario.tickets.map(ticket => ({id: ticket.id, issue: reference(ticket.issue), target, dependsOn: ticket.dependsOn}))}};
  for (const id of opened.value?.launchable ?? []) yield {input: {op: 'launch', ticketId: id}};
}

function* attentionPlan(trigger: string): MainPlan {
  const keys = /Dispatch needs Main: (.*?)\. launch:/.exec(trigger)?.[1]?.split(', ') ?? [];
  const finish = {input: {op: 'finish', summary: `Simulation ${scenario.name} delivered every ticket.`}};
  for (const key of keys) {
    const [kind = '', id = '', effect = ''] = key.split(':');
    if (kind === 'launch') yield {input: {op: 'launch', ticketId: id}};
    else if (kind === 'finish') yield finish;
    else if (kind === 'escalated') {
      const read = yield {input: {op: 'read', ticketId: id}};
      const ticket = read.value?.ticket;
      const ruling = scenario.tickets.find(item => item.id === id)?.rulings?.[ticket?.rulings.length ?? 0];
      if (ticket?.state === 'Escalated' && ruling) yield {input: {op: 'resolve', ticketId: id, revision: ticket.revision, ruling: ruling.ruling, to: ruling.to, ...(ruling.noCode ? {noCode: ruling.noCode} : {})}};
    } else if (kind === 'failed' && scenario.retryFailed) {
      yield {shell: `while [ ! -f ${quote(scenario.retryFailed)} ]; do sleep 0.2; done`};
      // The failed record blocks finish; a seat still retiring refuses it first, so wait that out.
      let finished = yield finish;
      while (finished.error?.error?.kind === 'ownershipBlocked') { yield {shell: 'sleep 0.5'}; finished = yield finish; }
      if (finished.ok) return;
      const read = yield {input: {op: 'read', ticketId: id}};
      const ticket = read.value?.ticket;
      if (ticket) yield {input: {op: 'resolve', ticketId: id, revision: ticket.revision, ruling: `Retry the failed Meerkat record ${effect}.`, to: ticket.state, effects: [{effectId: effect, disposition: 'retry'}]}};
    }
  }
}

function mainStep(messages: Message[]): {step: Step; note: string} {
  const index = lastUser(messages, /persistent Dispatch Main coordinator|Dispatch needs Main:/);
  if (index < 0) return {step: {text: 'Nothing for Main to decide.'}, note: 'no trigger'};
  const trigger = text(messages[index]!);
  const plan = /Dispatch needs Main:/.test(trigger) ? attentionPlan(trigger) : startPlan(trigger);
  const history = played(messages, index + 1, null);
  let next = plan.next(parseReply(''));
  for (const item of history) {
    if (next.done) break;
    next = plan.next(parseReply(item.result));
  }
  // The note names the notification and its position, so the driver can group one turn's calls per notification.
  const note = `${index}:${/Dispatch needs Main: (.*?)\. launch:/.exec(trigger)?.[1] ?? 'start'}`;
  if (next.done) return {step: {text: 'Waiting for the next dispatch decision.'}, note};
  const ask = next.value;
  return {step: {call: 'input' in ask ? {name: 'dispatch', args: ask} : {name: 'bash', args: {command: ask.shell, timeout: 0}}}, note};
}

/* ------------------------------------------------------------------ seats */

/** The ticket the brief carries: its last paragraph is the ticket or closure JSON. */
function ticketOf(brief: string): z.infer<typeof briefTicketSchema> {
  return briefTicketSchema.parse(JSON.parse(brief.slice(brief.lastIndexOf('\n\n') + 2)));
}

function inspect(expect: Expect, hold: string | null): string {
  const wait = hold ? `while [ ! -f ${quote(hold)} ]; do sleep 0.2; done; ` : '';
  const files = Object.keys(expect).map(path => `printf 'FILE %s ' ${quote(path)}; if [ -f ${quote(path)} ]; then base64 < ${quote(path)} | tr -d '\\n'; else printf MISSING; fi; echo`).join('; ');
  return `${wait}printf 'HEAD '; git rev-parse HEAD; ${files}`;
}

function verdict(expect: Expect, output: string): {ok: boolean; note: string} {
  const head = /HEAD ([0-9a-f]{40})/.exec(output)?.[1] ?? 'unknown';
  const findings = Object.entries(expect).map(([path, content]) => {
    const seen = new RegExp(`FILE ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\S+)`).exec(output)?.[1];
    const actual = seen === undefined || seen === 'MISSING' ? null : Buffer.from(seen, 'base64').toString('utf8');
    return {path, ok: actual === content, actual};
  });
  return {ok: findings.every(item => item.ok), note: `HEAD ${head}; ${findings.map(item => `${item.path}=${item.actual === null ? 'missing' : JSON.stringify(item.actual)}${item.ok ? '' : ' (expected different)'}`).join('; ')}`};
}

function commitScript(spec: TicketSpec, write: Record<string, string>, remove: string[], label: string): string {
  // `tee` keeps the script valid under the operator's bash interceptor, which refuses printf/echo redirection into files.
  const writes = Object.entries(write).map(([path, content]) => `printf '%s' ${quote(content)} | tee -- ${quote(path)} >/dev/null`);
  const removes = remove.map(path => `git rm -q --ignore-unmatch ${quote(path)}`);
  return ['set -e', `git switch -q -C sim-${spec.id}`, ...writes, ...removes, 'git add -A',
    `git -c user.name=sim -c user.email=sim@local commit -q --allow-empty -m ${quote(`${spec.id} ${label}`)}`,
    `git push -q --force origin HEAD:refs/heads/sim-${spec.id}`, 'git rev-parse HEAD'].join('\n');
}

function ownerStep(messages: Message[], spec: TicketSpec, brief: string): {step: Step; note: string} {
  const latest = lastUser(messages);
  const prompt = text(messages[latest]!);
  const continued = /Continue ticket \S+ at revision (\d+)/.exec(prompt);
  const ticket = ticketOf(brief);
  const revision = continued ? Number(continued[1]) : ticket.revision;
  // Handoffs before the latest prompt: a forked rework session inherits its predecessor's accepted handoffs.
  const handoffs = played(messages.slice(0, latest), 0, 'dispatch').filter(item => (item.op === 'submit' || item.op === 'escalate') && parseReply(item.result).ok).length;
  const abandoned = continued ? 0 : (ticket.notes ?? []).filter(note => JSON.stringify(note).includes('ended without a handoff')).length;
  const round = handoffs + abandoned;
  const owner: OwnerRound = spec.owner[Math.min(round, spec.owner.length - 1)]!;
  const step = messages.slice(latest + 1).filter(message => message.role === 'assistant').length;
  const note = `round ${round} step ${step} revision ${revision}`;
  if (owner.kind === 'quit') return {step: {text: 'I cannot finish this ticket.'}, note};
  if (owner.kind === 'escalate') return {step: step === 0 ? {call: {name: 'dispatch', args: {input: {op: 'escalate', ticketId: spec.id, revision, kind: owner.escalation, reason: owner.reason, ...(owner.tier ? {tier: owner.tier} : {})}}}} : {text: 'Escalated.'}, note};
  const bash = played(messages, latest + 1, 'bash');
  if (step === 0) return {step: {call: {name: 'bash', args: {command: commitScript(spec, owner.write, owner.remove ?? [], `round ${round}`)}}}, note};
  if (step === 1) {
    const head = [...(bash[0]?.result ?? '').matchAll(/\b([0-9a-f]{40})\b/g)].at(-1)?.[1];
    if (!head) return {step: {text: `Commit failed: ${bash[0]?.result ?? 'no output'}`}, note};
    return {step: {call: {name: 'dispatch', args: {input: {op: 'submit', ticketId: spec.id, revision, branch: `sim-${spec.id}`, head, title: `Sim ${spec.id}`, body: `Closes #${spec.issue}`}}}}, note};
  }
  if (step === 2 && owner.after?.kind === 'block') return {step: {call: {name: 'bash', args: {command: `while [ ! -f ${quote(owner.after.marker)} ]; do sleep 0.2; done`, timeout: 0}}}, note};
  if (step === 2 && owner.after?.kind === 'push') return {step: {call: {name: 'bash', args: {command: `while [ ! -f ${quote(owner.after.waitFor)} ]; do sleep 0.2; done\n${commitScript(spec, owner.after.write, [], `round ${round} follow-up`)}`, timeout: 0}}}, note};
  return {step: {text: 'Handed off.'}, note};
}

function gateStep(messages: Message[], role: string, ticketId: string, brief: string): {step: Step; note: string} {
  const ticket = ticketOf(brief);
  const spec = scenario.tickets.find(item => item.id === ticketId);
  const expect = scenario.parentRoles.includes(role) ? scenario.closure : spec!.judgeExpect?.[role] ?? spec!.gate;
  const hold = spec?.hold?.roles.some(item => item === role) ? spec.hold.marker : null;
  const step = messages.filter(message => message.role === 'assistant').length;
  // The provider failure hits the first judge of this role, once: its request fails and the seat ends with that error.
  if (spec?.judgeFailure?.role === role && step === 0) {
    const failedBefore = readFileSync(scenario.log, 'utf8').split('\n').filter(Boolean).some(line => {
      const entry = JSON.parse(line) as {ticket?: string; role?: string; note?: string};
      return entry.ticket === ticketId && entry.role === role && entry.note === 'provider error';
    });
    if (!failedBefore) return {step: {fail: spec.judgeFailure.message}, note: 'provider error'};
  }
  if (step === 0) return {step: {call: {name: 'bash', args: {command: inspect(expect, hold), timeout: 0}}}, note: 'inspect'};
  if (step === 1) {
    const judged = verdict(expect, played(messages, 0, 'bash')[0]?.result ?? '');
    return {step: {call: {name: 'dispatch', args: {input: {op: 'verdict', ticketId, revision: ticket.revision, role, ok: judged.ok, note: judged.note}}}}, note: judged.note};
  }
  return {step: {text: 'Verdict recorded.'}, note: 'done'};
}

/* ------------------------------------------------------------------ provider */

function respond(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
  const messages = context.messages;
  let decided: {step: Step; note: string};
  let who: Record<string, string> = {kind: 'main'};
  if (model.id === 'main') decided = mainStep(messages);
  else {
    const brief = text(messages[messages.findIndex(message => message.role === 'user')]!);
    const seat = /You are the ([\w-]+) seat for dispatch ticket (\S+?)\. /.exec(brief);
    if (!seat) throw new Error(`Seat brief not recognised: ${brief.slice(0, 200)}`);
    const [role, ticketId] = [seat[1]!, seat[2]!];
    who = {kind: 'seat', role, ticket: ticketId};
    const spec = scenario.tickets.find(item => item.id === ticketId);
    decided = scenario.workRoles.includes(role) ? ownerStep(messages, spec!, brief) : gateStep(messages, role, ticketId, brief);
  }
  // Tools that trace intent require an `i` argument; supply it only when the schema asks for it.
  const withIntent = (name: string, args: Record<string, unknown>) => {
    const schema = intentSchema.safeParse(context.tools?.find(tool => tool.name === name)?.parameters);
    return schema.success && schema.data.required?.includes('i') ? {i: 'Simulated step', ...args} : args;
  };
  appendFileSync(scenario.log, `${JSON.stringify({at: Date.now(), session: options?.sessionId ?? null, ...who, note: decided.note, step: 'call' in decided.step ? decided.step.call : 'fail' in decided.step ? {error: decided.step.fail} : decided.step})}\n`);
  const partial: AssistantMessage = {role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: {input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: {input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003}},
    stopReason: 'stop', timestamp: Date.now()};
  const stream = createAssistantMessageEventStream();
  stream.push({type: 'start', partial});
  if ('fail' in decided.step) {
    // A provider failure ends the stream with stopReason 'error', as omp reports a request that failed after retries.
    const failure: AssistantMessage = {...partial, stopReason: 'error', errorMessage: decided.step.fail};
    stream.push({type: 'error', reason: 'error', error: failure});
  } else if ('call' in decided.step) {
    const call: ToolCall = {type: 'toolCall', id: `sim_${++callCounter}_${Date.now().toString(36)}`, name: decided.step.call.name, arguments: withIntent(decided.step.call.name, decided.step.call.args)};
    partial.content.push(call);
    stream.push({type: 'toolcall_start', contentIndex: 0, partial});
    stream.push({type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(call.arguments), partial});
    stream.push({type: 'toolcall_end', contentIndex: 0, toolCall: call, partial});
    partial.stopReason = 'toolUse';
    stream.push({type: 'done', reason: 'toolUse', message: partial});
  } else {
    partial.content.push({type: 'text', text: decided.step.text});
    stream.push({type: 'text_start', contentIndex: 0, partial});
    stream.push({type: 'text_delta', contentIndex: 0, delta: decided.step.text, partial});
    stream.push({type: 'text_end', contentIndex: 0, content: decided.step.text, partial});
    stream.push({type: 'done', reason: 'stop', message: partial});
  }
  return stream;
}

export default function simulation(pi: ExtensionAPI): void {
  const model = (id: string, name: string) => ({id, name, reasoning: false, input: ['text' as const], cost: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0}, contextWindow: 200_000, maxTokens: 32_768});
  pi.registerProvider('sim', {api: 'sim-script', baseUrl: 'sim://local', apiKey: 'sim-literal-key', models: [model('main', 'Sim Main'), model('seat', 'Sim Seat')],
    streamSimple: (model, context, options) => respond(model, context, options)});
}
