import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import type { Action, ParseError, PortInput, Result } from "../src/domain/model.ts";
import {
	parseAgenda,
	parseDispatchStepParameters,
	parseDispatchTicketParameters,
	parseSeatEscalateParameters,
	parseSeatSubmitParameters,
	parseSeatVerdictParameters,
} from "../src/domain/parse.ts";

const repo = { owner: "oh-my-omp", name: "omp-dispatch" },
	other = { owner: "oh-my-omp", name: "omp-config" };
const wireRepo = { owner: "oh-my-omp", repo: "omp-dispatch" },
	wireOtherRepo = { owner: "oh-my-omp", repo: "omp-config" };
const issue = { repo, number: 236 },
	otherIssue = { repo, number: 237 },
	parent = { repo, number: 290 },
	target = { repo, base: "main" };
const wireIssue = { owner: "oh-my-omp", repo: "omp-dispatch", number: 236 },
	wireOtherIssue = { owner: "oh-my-omp", repo: "omp-dispatch", number: 237 },
	wireParent = { owner: "oh-my-omp", repo: "omp-dispatch", number: 290 },
	wireTarget = { owner: "oh-my-omp", repo: "omp-dispatch", branch: "main" };
const sha = "1".repeat(40),
	hash = "a".repeat(64),
	agenda = "9c825bdb-049d-4098-8836-0559bfd96760";

function required(result: Result<PortInput, ParseError>): PortInput {
	if (!result.ok) throw new Error(`${result.error.path}: ${result.error.reason}`);
	return result.value;
}

test("dispatch_ticket maps flat structured convene, resume, and finish onto PortInput", () => {
	expect(
		required(
			parseDispatchTicketParameters({
				convene: {
					parent: wireParent,
					tickets: [
						{
							id: "A",
							issue: wireIssue,
							target: wireTarget,
							dependsOn: ["B"],
							adoptPr: { owner: "oh-my-omp", repo: "omp-dispatch", number: 300 },
						},
						{ id: "B", issue: wireOtherIssue, target: wireTarget, dependsOn: [] },
					],
				},
			}),
		),
	).toEqual({
		op: "convene",
		parent,
		tickets: [
			{ id: "A", issue, target, dependsOn: ["B"], adoptPr: { repo, number: 300 } },
			{ id: "B", issue: otherIssue, target, dependsOn: [], adoptPr: null },
		],
	});
	expect(
		required(
			parseDispatchTicketParameters({
				convene: {
					tickets: [{ id: "A", issue: wireIssue, target: wireTarget, dependsOn: [] }],
				},
			}),
		),
	).toEqual({ op: "convene", parent: null, tickets: [{ id: "A", issue, target, dependsOn: [], adoptPr: null }] });
	expect(required(parseDispatchTicketParameters({ resume: { agenda } }))).toEqual({ op: "resume", agenda });
	expect(required(parseDispatchTicketParameters({ finish: { summary: "Delivered." } }))).toEqual({
		op: "finish",
		summary: "Delivered.",
	});
});

test("dispatch_ticket refuses empty, combined, wrapped, or unknown fields", () => {
	expect(parseDispatchTicketParameters({}).ok).toBe(false);
	expect(parseDispatchTicketParameters({ resume: { agenda }, finish: { summary: "Both." } }).ok).toBe(false);
	expect(parseDispatchTicketParameters({ input: { op: "resume", agenda } }).ok).toBe(false);
	expect(parseDispatchTicketParameters({ resume: { agenda, confirmed: true } }).ok).toBe(false);
});

test("dispatch_step maps launch and resolve with every structured githubAction and three-state adoptPr", () => {
	expect(required(parseDispatchStepParameters({ ticketId: "A", launch: { role: "review" } }))).toEqual({
		op: "launch",
		ticketId: "A",
		role: "review",
	});
	expect(required(parseDispatchStepParameters({ ticketId: "A", launch: {} }))).toEqual({
		op: "launch",
		ticketId: "A",
	});

	const actions: Action[] = [
		{
			kind: "publishPr",
			issue,
			headRepo: repo,
			branch: "feature",
			head: sha,
			target,
			pr: null,
			expectedBodyHash: null,
			title: "Publish",
			body: "Body",
		},
		{ kind: "merge", issue, pr: { repo, number: 300 }, head: sha, target, stampHash: hash },
		{ kind: "setIssueState", issue, open: false, bodyHash: hash, afterEvent: null },
		{ kind: "replaceBody", issue, expectedHash: hash, body: "New body" },
		{ kind: "createIssue", repo: other, title: "New issue", body: "Issue body" },
		{ kind: "attachChild", parent: issue, child: otherIssue },
		{ kind: "rerunChecks", pr: { repo, number: 300 }, repo, workflowRunId: 7, previousAttempt: 2, head: sha },
		{ kind: "comment", issue, body: "Comment body\n\n<!-- marker -->", marker: { kind: "impl", key: "key" } },
		{ kind: "setProjectField", issue, field: "status", option: "Done" },
		{ kind: "requestAnswer", issue, comment: 12, question: "Which one?", tier: "complex" },
	];

	const resolved = required(
		parseDispatchStepParameters({
			ticketId: "A",
			resolve: {
				revision: 3,
				ruling: "Ruling.",
				to: "Coding",
				dependsOn: ["B"],
				target: wireTarget,
				adoptPr: { owner: "oh-my-omp", repo: "omp-dispatch", number: 300 },
				noCode: "No code needed.",
				add: [{ id: "C", issue: { owner: "oh-my-omp", repo: "omp-dispatch", number: 238 }, target: wireTarget, dependsOn: [] }],
				remove: ["D"],
				effects: [{ effectId: "run/publishPr/1", disposition: "retry" }],
				githubActions: [
					{
						publishPr: {
							issue: wireIssue,
							headRepo: wireRepo,
							branch: "feature",
							head: sha,
							target: wireTarget,
							title: "Publish",
							body: "Body",
						},
					},
					{
						merge: {
							issue: wireIssue,
							pr: { owner: "oh-my-omp", repo: "omp-dispatch", number: 300 },
							head: sha,
							target: wireTarget,
							stampHash: hash,
						},
					},
					{ setIssueState: { issue: wireIssue, open: false, bodyHash: hash } },
					{ replaceBody: { issue: wireIssue, expectedHash: hash, body: "New body" } },
					{ createIssue: { repo: wireOtherRepo, title: "New issue", body: "Issue body" } },
					{ attachChild: { parent: wireIssue, child: wireOtherIssue } },
					{
						rerunChecks: {
							pr: { owner: "oh-my-omp", repo: "omp-dispatch", number: 300 },
							repo: wireRepo,
							workflowRunId: 7,
							previousAttempt: 2,
							head: sha,
						},
					},
					{
						comment: {
							issue: wireIssue,
							body: "Comment body\n\n<!-- marker -->",
							marker: { kind: "impl", key: "key" },
						},
					},
					{ setProjectField: { issue: wireIssue, field: "status", option: "Done" } },
					{ requestAnswer: { issue: wireIssue, comment: 12, question: "Which one?", tier: "complex" } },
				],
			},
		}),
	);
	expect(resolved).toEqual({
		op: "resolve",
		ticketId: "A",
		revision: 3,
		ruling: "Ruling.",
		to: "Coding",
		dependsOn: ["B"],
		target,
		adoptPr: { repo, number: 300 },
		noCode: "No code needed.",
		add: [{ id: "C", issue: { repo, number: 238 }, target, dependsOn: [], adoptPr: null }],
		remove: ["D"],
		effects: [{ effectId: "run/publishPr/1", disposition: "retry" }],
		actions,
	});

	const cleared = required(
		parseDispatchStepParameters({
			ticketId: "A",
			resolve: { revision: 3, ruling: "Clear.", to: "Coding", clearAdoptPr: true },
		}),
	);
	expect(cleared).toEqual({ op: "resolve", ticketId: "A", revision: 3, ruling: "Clear.", to: "Coding", adoptPr: null });

	const untouched = required(
		parseDispatchStepParameters({
			ticketId: "A",
			resolve: { revision: 3, ruling: "Keep.", to: "Coding" },
		}),
	);
	expect("adoptPr" in untouched).toBe(false);

	expect(
		parseDispatchStepParameters({
			ticketId: "A",
			resolve: {
				revision: 3,
				ruling: "Conflict.",
				to: "Coding",
				adoptPr: { owner: "oh-my-omp", repo: "omp-dispatch", number: 300 },
				clearAdoptPr: true,
			},
		}).ok,
	).toBe(false);
});

test("dispatch_step refuses empty, combined, or malformed githubActions", () => {
	expect(parseDispatchStepParameters({ ticketId: "A" }).ok).toBe(false);
	expect(
		parseDispatchStepParameters({
			ticketId: "A",
			launch: {},
			resolve: { revision: 1, ruling: "Ruling.", to: "Coding" },
		}).ok,
	).toBe(false);
	expect(
		parseDispatchStepParameters({
			ticketId: "A",
			resolve: {
				revision: 3,
				ruling: "Ruling.",
				to: "Coding",
				githubActions: [{}],
			},
		}).ok,
	).toBe(false);
	expect(
		parseDispatchStepParameters({
			ticketId: "A",
			resolve: {
				revision: 3,
				ruling: "Ruling.",
				to: "Coding",
				githubActions: [
					{
						createIssue: { repo: wireOtherRepo, title: "New", body: "Body" },
						attachChild: { parent: wireIssue, child: wireOtherIssue },
					},
				],
			},
		}).ok,
	).toBe(false);
	expect(
		parseDispatchStepParameters({
			ticketId: "A",
			resolve: {
				revision: 3,
				ruling: "Ruling.",
				to: "Coding",
				githubActions: [
					{
						merge: {
							issue: wireIssue,
							pr: { owner: "oh-my-omp", repo: "omp-dispatch", number: 300 },
							head: sha,
							target: wireTarget,
							stampHash: hash,
							title: "Foreign field",
						},
					},
				],
			},
		}).ok,
	).toBe(false);
});

test("an empty replaceBody body is allowed, while an empty createIssue body is refused", () => {
	expect(
		required(
			parseDispatchStepParameters({
				ticketId: "A",
				resolve: {
					revision: 3,
					ruling: "Clear body.",
					to: "Coding",
					githubActions: [{ replaceBody: { issue: wireIssue, expectedHash: hash, body: "" } }],
				},
			}),
		),
	).toEqual({
		op: "resolve",
		ticketId: "A",
		revision: 3,
		ruling: "Clear body.",
		to: "Coding",
		actions: [{ kind: "replaceBody", issue, expectedHash: hash, body: "" }],
	});
	const refused = parseDispatchStepParameters({
		ticketId: "A",
		resolve: {
			revision: 3,
			ruling: "Ruling.",
			to: "Coding",
			githubActions: [{ createIssue: { repo: wireOtherRepo, title: "New issue", body: "" } }],
		},
	});
	expect(refused.ok).toBe(false);
	if (!refused.ok) expect(refused.error.path).toBe("resolve.githubActions.0.createIssue.body");
});

test("zero-op seat tools map flat parameters using bound seat identity", () => {
	expect(
		required(
			parseSeatSubmitParameters(
				{
					branch: "feature",
					head: sha,
					title: "Deliver",
					body: "Closes oh-my-omp/omp-dispatch#236",
				},
				{ ticketId: "A", revision: 2 },
			),
		),
	).toEqual({
		op: "submit",
		ticketId: "A",
		revision: 2,
		branch: "feature",
		head: sha,
		title: "Deliver",
		body: "Closes oh-my-omp/omp-dispatch#236",
	});
	expect(
		required(parseSeatVerdictParameters({ ok: true, note: "Verified the head." }, { ticketId: "A", revision: 2, role: "review" })),
	).toEqual({
		op: "verdict",
		ticketId: "A",
		revision: 2,
		role: "review",
		ok: true,
		note: "Verified the head.",
	});
	expect(
		required(parseSeatEscalateParameters({ kind: "question", reason: "Which one?", tier: "complex" }, { ticketId: "A", revision: 2 })),
	).toEqual({
		op: "escalate",
		ticketId: "A",
		revision: 2,
		kind: "question",
		reason: "Which one?",
		tier: "complex",
	});
	for (const kind of ["blocked", "split", "noCode"] as const) {
		expect(required(parseSeatEscalateParameters({ kind, reason: `${kind} reason` }, { ticketId: "A", revision: 2 }))).toEqual({
			op: "escalate",
			ticketId: "A",
			revision: 2,
			kind,
			reason: `${kind} reason`,
		});
	}
	expect(
		parseSeatSubmitParameters({ branch: "feature", head: sha, title: "T", body: "B", op: "submit" }, { ticketId: "A", revision: 2 }).ok,
	).toBe(false);
	expect(parseSeatVerdictParameters({ ok: true, note: "N", branch: "feature" }, { ticketId: "A", revision: 2, role: "review" }).ok).toBe(
		false,
	);
	expect(parseSeatEscalateParameters({ kind: "blocked", reason: "R", tier: "simple" }, { ticketId: "A", revision: 2 }).ok).toBe(false);
});

test("structured coordinates refuse malformed owner/repo/number fields and string DSLs", () => {
	const badOwner = parseDispatchTicketParameters({
		convene: {
			tickets: [{ id: "A", issue: { owner: "bad/owner", repo: "omp-dispatch", number: 236 }, target: wireTarget, dependsOn: [] }],
		},
	});
	expect(badOwner.ok).toBe(false);
	if (!badOwner.ok) expect(badOwner.error.reason).toContain("bad/owner");

	const badNumber = parseDispatchTicketParameters({
		convene: {
			tickets: [{ id: "A", issue: { owner: "oh-my-omp", repo: "omp-dispatch", number: 0 }, target: wireTarget, dependsOn: [] }],
		},
	});
	expect(badNumber.ok).toBe(false);
	if (!badNumber.ok) expect(badNumber.error.path).toBe("convene.tickets.0.issue.number");

	const stringDslRefused = parseDispatchTicketParameters({
		convene: {
			tickets: [{ id: "A", issue: "oh-my-omp/omp-dispatch#236", target: "oh-my-omp/omp-dispatch@main", dependsOn: [] }],
		},
	});
	expect(stringDslRefused.ok).toBe(false);
});

test("the stored agenda formats still parse", () => {
	const fixtures = new URL("../tests/sim/fixtures/", import.meta.url);
	const names = readdirSync(fixtures).filter((name) => name.endsWith(".json"));
	expect(names.length).toBeGreaterThan(0);
	for (const name of names) {
		const envelope = JSON.parse(readFileSync(new URL(name, fixtures), "utf8")) as { format: number; state: unknown };
		const parsed = parseAgenda(envelope.state);
		if (!parsed.ok) throw new Error(`${name}: ${parsed.error.path}: ${parsed.error.reason}`);
		expect(parsed.value.id).toBe(name.replace(/\.json$/, ""));
	}
});
