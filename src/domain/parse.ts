import type { ZodLikeSchema, z } from "@oh-my-pi/omptype/zod";
import { sameRef } from "./identity.ts";
import {
	type Action,
	type Agenda,
	actionSchema,
	agendaSchema,
	dispatchStepParametersSchema,
	dispatchTicketParametersSchema,
	type Entry,
	type IssueRef,
	type ParseError,
	type PortInput,
	portInputSchema,
	type Repo,
	type Result,
	type Role,
	seatEscalateParametersSchema,
	seatSubmitParametersSchema,
	seatVerdictParametersSchema,
	type Target,
} from "./model.ts";
import { ASKING, ESCALATED, encodeWorkflow, parseWorkflow, REPLACED, verdictsMatch } from "./workflow.ts";

type TicketParams = z.infer<typeof dispatchTicketParametersSchema>;
type StepParams = z.infer<typeof dispatchStepParametersSchema>;
type WireEntry = NonNullable<TicketParams["convene"]>["tickets"][number];
type WireGitHubAction = NonNullable<NonNullable<StepParams["resolve"]>["githubActions"]>[number];
type WireRepo = NonNullable<WireGitHubAction["createIssue"]>["repo"];
type WireIssueRef = WireEntry["issue"];
type WireTarget = WireEntry["target"];

function parse<T>(schema: ZodLikeSchema<T>, value: unknown, path = ""): Result<T, ParseError> {
	const parsed = schema.safeParse(value);
	if (parsed.success) return { ok: true, value: parsed.data };
	const first = parsed.error.issues[0];
	const at = first?.path.join(".") ?? "";
	return { ok: false, error: { path: [path, at].filter((part) => part.length > 0).join("."), reason: first?.message ?? "Invalid input" } };
}

function failure<T>(path: string, reason: string): Result<T, ParseError> {
	return { ok: false, error: { path, reason } };
}

function compact(fields: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function toRepo(value: WireRepo): Repo {
	return { owner: value.owner, name: value.repo };
}

function toIssueRef(value: WireIssueRef): IssueRef {
	return { repo: { owner: value.owner, name: value.repo }, number: value.number };
}

function toTarget(value: WireTarget): Target {
	return { repo: { owner: value.owner, name: value.repo }, base: value.branch };
}

function toEntry(value: WireEntry): Entry {
	return {
		id: value.id,
		issue: toIssueRef(value.issue),
		target: toTarget(value.target),
		dependsOn: value.dependsOn,
		adoptPr: value.adoptPr === undefined ? null : toIssueRef(value.adoptPr),
	};
}

function toAction(value: WireGitHubAction, path: string): Result<Action, ParseError> {
	const defined = Object.entries(value).filter(([, item]) => item !== undefined);
	if (defined.length !== 1) return failure(path, "Specify exactly one GitHub action property per item");
	if (value.publishPr) {
		const a = value.publishPr;
		return parse(
			actionSchema,
			{
				kind: "publishPr",
				issue: toIssueRef(a.issue),
				headRepo: toRepo(a.headRepo),
				branch: a.branch,
				head: a.head,
				target: toTarget(a.target),
				pr: a.pr === undefined ? null : toIssueRef(a.pr),
				expectedBodyHash: a.expectedBodyHash ?? null,
				title: a.title,
				body: a.body,
			},
			`${path}.publishPr`,
		);
	}
	if (value.merge) {
		const a = value.merge;
		return parse(
			actionSchema,
			{
				kind: "merge",
				issue: toIssueRef(a.issue),
				pr: toIssueRef(a.pr),
				head: a.head,
				target: toTarget(a.target),
				stampHash: a.stampHash,
			},
			`${path}.merge`,
		);
	}
	if (value.setIssueState) {
		const a = value.setIssueState;
		return parse(
			actionSchema,
			{
				kind: "setIssueState",
				issue: toIssueRef(a.issue),
				open: a.open,
				bodyHash: a.bodyHash,
				afterEvent: a.afterEvent ?? null,
			},
			`${path}.setIssueState`,
		);
	}
	if (value.replaceBody) {
		const a = value.replaceBody;
		return parse(
			actionSchema,
			{
				kind: "replaceBody",
				issue: toIssueRef(a.issue),
				expectedHash: a.expectedHash,
				body: a.body,
			},
			`${path}.replaceBody`,
		);
	}
	if (value.createIssue) {
		const a = value.createIssue;
		return parse(
			actionSchema,
			{
				kind: "createIssue",
				repo: toRepo(a.repo),
				title: a.title,
				body: a.body,
			},
			`${path}.createIssue`,
		);
	}
	if (value.attachChild) {
		const a = value.attachChild;
		return parse(
			actionSchema,
			{
				kind: "attachChild",
				parent: toIssueRef(a.parent),
				child: toIssueRef(a.child),
			},
			`${path}.attachChild`,
		);
	}
	if (value.rerunChecks) {
		const a = value.rerunChecks;
		return parse(
			actionSchema,
			{
				kind: "rerunChecks",
				pr: toIssueRef(a.pr),
				repo: toRepo(a.repo),
				workflowRunId: a.workflowRunId,
				previousAttempt: a.previousAttempt,
				head: a.head,
			},
			`${path}.rerunChecks`,
		);
	}
	if (value.comment) {
		const a = value.comment;
		return parse(
			actionSchema,
			{
				kind: "comment",
				issue: toIssueRef(a.issue),
				body: a.body,
				marker: a.marker,
			},
			`${path}.comment`,
		);
	}
	if (value.setProjectField) {
		const a = value.setProjectField;
		return parse(
			actionSchema,
			{
				kind: "setProjectField",
				issue: toIssueRef(a.issue),
				field: a.field,
				option: a.option,
			},
			`${path}.setProjectField`,
		);
	}
	if (value.requestAnswer) {
		const a = value.requestAnswer;
		return parse(
			actionSchema,
			{
				kind: "requestAnswer",
				issue: toIssueRef(a.issue),
				comment: a.comment,
				question: a.question,
				tier: a.tier,
			},
			`${path}.requestAnswer`,
		);
	}
	return failure(path, "Specify exactly one GitHub action property per item");
}

function toActions(values: readonly WireGitHubAction[], path: string): Result<Action[], ParseError> {
	const collected: Action[] = [];
	for (let index = 0; index < values.length; index++) {
		const item = toAction(values[index]!, `${path}.${index}`);
		if (!item.ok) return item;
		collected.push(item.value);
	}
	return { ok: true, value: collected };
}

export function parseDispatchTicketParameters(value: unknown): Result<PortInput, ParseError> {
	const wire = parse(dispatchTicketParametersSchema, value);
	if (!wire.ok) return wire;
	const { convene, resume, finish } = wire.value;
	const chosen = [convene !== undefined, resume !== undefined, finish !== undefined].filter(Boolean).length;
	if (chosen !== 1) return failure("", "Specify exactly one of convene, resume, or finish");
	if (convene) {
		return parse(portInputSchema, {
			op: "convene",
			parent: convene.parent === undefined ? null : toIssueRef(convene.parent),
			tickets: convene.tickets.map(toEntry),
		});
	}
	if (resume) {
		return parse(portInputSchema, { op: "resume", agenda: resume.agenda });
	}
	return parse(portInputSchema, { op: "finish", summary: finish!.summary });
}

export function parseDispatchStepParameters(value: unknown): Result<PortInput, ParseError> {
	const wire = parse(dispatchStepParametersSchema, value);
	if (!wire.ok) return wire;
	const { ticketId, launch, resolve } = wire.value;
	const chosen = [launch !== undefined, resolve !== undefined].filter(Boolean).length;
	if (chosen !== 1) return failure("", "Specify exactly one of launch or resolve");
	if (launch) {
		return parse(portInputSchema, compact({ op: "launch", ticketId, role: launch.role }));
	}
	const r = resolve!;
	if (r.clearAdoptPr === true && r.adoptPr !== undefined) {
		return failure("resolve.adoptPr", "adoptPr and clearAdoptPr cannot be combined");
	}
	const adoptPr = r.clearAdoptPr === true ? null : r.adoptPr === undefined ? undefined : toIssueRef(r.adoptPr);
	const enqueued = r.githubActions === undefined ? undefined : toActions(r.githubActions, "resolve.githubActions");
	if (enqueued !== undefined && !enqueued.ok) return enqueued;
	return parse(
		portInputSchema,
		compact({
			op: "resolve",
			ticketId,
			revision: r.revision,
			ruling: r.ruling,
			to: r.to,
			dependsOn: r.dependsOn,
			target: r.target === undefined ? undefined : toTarget(r.target),
			adoptPr,
			noCode: r.noCode,
			add: r.add === undefined ? undefined : r.add.map(toEntry),
			remove: r.remove,
			effects: r.effects,
			actions: enqueued?.value,
		}),
	);
}

export function parseSeatSubmitParameters(value: unknown, bound: { ticketId: string; revision: number }): Result<PortInput, ParseError> {
	const wire = parse(seatSubmitParametersSchema, value);
	if (!wire.ok) return wire;
	return parse(portInputSchema, {
		op: "submit",
		ticketId: bound.ticketId,
		revision: wire.value.revision ?? bound.revision,
		branch: wire.value.branch,
		head: wire.value.head,
		title: wire.value.title,
		body: wire.value.body,
	});
}

export function parseSeatVerdictParameters(
	value: unknown,
	bound: { ticketId: string; revision: number; role: Role },
): Result<PortInput, ParseError> {
	const wire = parse(seatVerdictParametersSchema, value);
	if (!wire.ok) return wire;
	return parse(portInputSchema, {
		op: "verdict",
		ticketId: bound.ticketId,
		revision: wire.value.revision ?? bound.revision,
		role: bound.role,
		ok: wire.value.ok,
		note: wire.value.note,
	});
}

export function parseSeatEscalateParameters(value: unknown, bound: { ticketId: string; revision: number }): Result<PortInput, ParseError> {
	const wire = parse(seatEscalateParametersSchema, value);
	if (!wire.ok) return wire;
	if (wire.value.kind !== "question" && wire.value.tier !== undefined) {
		return failure("tier", "tier is only allowed when kind is question");
	}
	return parse(
		portInputSchema,
		compact({
			op: "escalate",
			ticketId: bound.ticketId,
			revision: wire.value.revision ?? bound.revision,
			kind: wire.value.kind,
			reason: wire.value.reason,
			tier: wire.value.tier,
		}),
	);
}

export function validateTopology(state: Pick<Agenda, "tickets">): string | null {
	const byId = new Map(state.tickets.map((ticket) => [ticket.id, ticket]));
	if (byId.size !== state.tickets.length) return "Ticket IDs must be unique";
	const issues = new Set<string>();
	for (const ticket of state.tickets) {
		const key = `${ticket.issue.repo.owner}/${ticket.issue.repo.name}#${ticket.issue.number}`.toLowerCase();
		if (issues.has(key)) return "Each issue must have exactly one ticket";
		issues.add(key);
		if (new Set(ticket.dependsOn).size !== ticket.dependsOn.length) return `Duplicate dependency on ${ticket.id}`;
		for (const dependency of ticket.dependsOn) if (!byId.has(dependency)) return `Unknown dependency ${dependency}`;
	}
	const visited = new Set<string>(),
		visiting = new Set<string>();
	function visit(id: string): boolean {
		if (visiting.has(id)) return false;
		if (visited.has(id)) return true;
		visiting.add(id);
		for (const dependency of byId.get(id)?.dependsOn ?? []) if (!visit(dependency)) return false;
		visiting.delete(id);
		visited.add(id);
		return true;
	}
	for (const ticket of state.tickets) if (!visit(ticket.id)) return "Ticket dependencies must be acyclic";
	return null;
}
export function encodeAgenda(agenda: Agenda): unknown {
	return { ...agenda, workflow: encodeWorkflow(agenda.workflow) };
}
export function parseAgenda(value: unknown): Result<Agenda, ParseError> {
	const parsed = parse(agendaSchema, value);
	if (!parsed.ok) return parsed;
	const workflow = parseWorkflow(parsed.value.workflow);
	if (!workflow.ok) return { ok: false, error: { path: `workflow.${workflow.error.path}`, reason: workflow.error.reason } };
	const agenda: Agenda = { ...parsed.value, workflow: workflow.value };
	const topology = validateTopology(agenda);
	if (topology) return { ok: false, error: { path: "tickets", reason: topology } };
	const ids = new Set(agenda.effects.map((effect) => effect.id));
	if (ids.size !== agenda.effects.length) return { ok: false, error: { path: "effects", reason: "Effect IDs must be unique" } };
	for (const effect of agenda.effects) {
		const ticket = agenda.tickets.some((ticket) => ticket.id === effect.ticketId),
			closure = effect.ticketId === agenda.closure?.id;
		if (!ticket && !closure) return { ok: false, error: { path: "effects", reason: "Effect must belong to a ticket or closure" } };
		const states = ticket ? workflow.value.ticket.states : workflow.value.parent.states;
		if (effect.origin && !(effect.origin.state in states) && !(ticket && effect.origin.state === ASKING))
			return {
				ok: false,
				error: {
					path: "effects",
					reason: `Effect ${effect.id} was requested by ${effect.origin.state}, which the agenda workflow does not define`,
				},
			};
	}
	const ticketStates = workflow.value.ticket.states,
		parentStates = workflow.value.parent.states;
	for (const ticket of agenda.tickets) {
		const fail = (reason: string): Result<Agenda, ParseError> => ({
			ok: false,
			error: { path: "tickets", reason: `Ticket ${ticket.id} ${reason}` },
		});
		if (ticket.state !== ESCALATED && ticket.state !== ASKING && ticket.state !== REPLACED && !(ticket.state in ticketStates))
			return fail(`is in ${ticket.state}, which the agenda workflow does not define`);
		if ((ticket.state === ASKING) !== (ticket.ask !== null))
			return fail(ticket.ask ? `records a question outside ${ASKING}` : `is ${ASKING} without its question`);
		if ((ticket.state === REPLACED) !== (ticket.terminal?.kind === "replaced"))
			return fail(ticket.state === REPLACED ? `is ${REPLACED} without the replacement` : `records a replacement outside ${REPLACED}`);
		if (ticket.ask && ticket.ask.from !== null && ticketStates[ticket.ask.from]?.kind !== "work")
			return fail(`asked from ${ticket.ask.from}, which is not a work state of the agenda workflow`);
		for (const [name, gate] of Object.entries(ticket.gates)) {
			const state = ticketStates[name];
			if (state?.kind !== "judge" || state.subject !== gate.stamp.kind || !verdictsMatch(state.judges, gate.verdicts))
				return fail(`holds a ${name} gate that does not match the agenda workflow`);
		}
		for (const role of Object.keys(ticket.sessions))
			if (!Object.values(ticketStates).some((state) => state.kind === "work" && state.role === role))
				return fail(`holds a session for ${role}, which is not a work role`);
		for (const name of Object.keys(ticket.visits))
			if (!(name in ticketStates)) return fail(`counts visits to ${name}, which the agenda workflow does not define`);
	}
	const closure = agenda.closure;
	if (closure) {
		const fail = (reason: string): Result<Agenda, ParseError> => ({ ok: false, error: { path: "closure", reason: `Closure ${reason}` } });
		if (!agenda.parent || !sameRef(closure.stamp.parent, agenda.parent)) return fail("belongs to no parent of this agenda");
		if (closure.state !== ESCALATED && !(closure.state in parentStates))
			return fail(`is in ${closure.state}, which the agenda workflow does not define`);
		for (const name of Object.keys(closure.visits))
			if (!(name in parentStates)) return fail(`counts visits to ${name}, which the agenda workflow does not define`);
		for (const [name, gate] of Object.entries(closure.gates)) {
			const state = parentStates[name];
			if (state?.kind !== "judge" || !verdictsMatch(state.judges, gate.verdicts))
				return fail(`holds a ${name} gate that does not match the agenda workflow`);
		}
	}
	return { ok: true, value: agenda };
}
