import { describe, expect, test } from "bun:test";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { YAML } from "bun";
import { registerInternalScheme } from "../omomp-shared/internal-url.ts";
import { createAgenda } from "../src/domain/engine.ts";
import { bodyHash } from "../src/domain/identity.ts";
import type { Agenda, Caller, Facts, PortInput, Result } from "../src/domain/model.ts";
import { parseWorkflow } from "../src/domain/workflow.ts";
import type { ResolvedUrlCaller } from "../src/ports/contracts.ts";
import type { AgendaView, ControllerOutput, RuntimeError } from "../src/runtime/controller.ts";
import { createDispatchProtocolHandler, type DispatchUrlRuntime } from "../src/runtime/dispatch-url.ts";

const repoA = { owner: "oh-my-omp", name: "omp-dispatch" };
const repoB = { owner: "oh-my-omp", name: "omp-config" };
const issue1 = { repo: repoA, number: 1 };
const issue2 = { repo: repoB, number: 2 };
const sha = "1".repeat(40);
const parsedDefaultWorkflow = parseWorkflow(YAML.parse(await Bun.file(new URL("../src/default-workflow.yml", import.meta.url)).text()));
if (!parsedDefaultWorkflow.ok) throw new Error(parsedDefaultWorkflow.error.reason);
const defaultWorkflow = parsedDefaultWorkflow.value;

function makeAgenda(): Agenda {
	const facts: Facts = {
		viewer: "tester",
		issues: [
			{
				ref: issue1,
				body: "Ticket A body",
				bodyHash: bodyHash("Ticket A body"),
				updatedAt: 1,
				state: "open",
				lastClose: null,
				lastReopen: null,
				children: [],
				meerkat: null,
			},
			{
				ref: issue2,
				body: "Ticket B body",
				bodyHash: bodyHash("Ticket B body"),
				updatedAt: 1,
				state: "open",
				lastClose: null,
				lastReopen: null,
				children: [],
				meerkat: null,
			},
		],
		prs: [],
		links: [],
		repos: [
			{
				repo: repoA,
				defaultBranch: "main",
				defaultHead: sha,
				bases: [
					{ name: "main", state: { kind: "present", head: sha, isDefault: true, rules: { required: [], strict: false, constraints: [] } } },
				],
			},
			{
				repo: repoB,
				defaultBranch: "main",
				defaultHead: sha,
				bases: [
					{ name: "main", state: { kind: "present", head: sha, isDefault: true, rules: { required: [], strict: false, constraints: [] } } },
				],
			},
		],
		branches: [],
		maintenance: [],
		commits: [],
		checkAttempts: [],
		createdIssues: [],
	};
	const created = createAgenda(
		{
			op: "convene",
			parent: null,
			tickets: [
				{ id: "A", issue: issue1, target: { repo: repoA, base: "main" }, dependsOn: [], adoptPr: null },
				{ id: "B", issue: issue2, target: { repo: repoB, base: "main" }, dependsOn: ["A"], adoptPr: null },
			],
		},
		defaultWorkflow,
		facts,
		1,
		"00000000-0000-4000-8000-000000000099",
	);
	if (!created.ok) throw new Error(created.error.message);
	created.value.closure = {
		id: `${created.value.id}/closure/1`,
		revision: 1,
		state: "Done",
		stamp: {
			kind: "parent",
			parent: issue1,
			bodyHash: bodyHash("Parent"),
			children: [],
			targets: [],
			rulingsHash: bodyHash("[]"),
		},
		visits: {},
		gates: {},
		rulings: [],
		notes: [],
	};
	return created.value;
}

function makeRuntime(
	agenda: Agenda,
	callerBySession: Record<string, ResolvedUrlCaller>,
	project: { owner: string; number: number } | null = { owner: "oh-my-omp", number: 7 },
): DispatchUrlRuntime {
	const view: AgendaView = {
		agenda,
		launchable: ["A"],
		asking: [],
		seated: [{ ticketId: "A", roles: ["owner"] }],
	};
	return {
		resolveCaller(context) {
			const hit = context?.sessionId ? callerBySession[context.sessionId] : undefined;
			if (!hit) return { ok: false, error: { kind: "precondition", message: "Unknown caller session" } };
			return { ok: true, value: hit };
		},
		async execute(
			caller: Caller,
			op: Extract<PortInput, { op: "status" | "tickets" | "read" }>,
		): Promise<Result<ControllerOutput, RuntimeError>> {
			if (op.op === "status" || op.op === "tickets") return { ok: true, value: view };
			if (caller.kind === "seat" && caller.ticketId !== op.ticketId) {
				return { ok: false, error: { kind: "domain", error: { kind: "unauthorized", message: "A seat can read only its bound ticket" } } };
			}
			const ticket = agenda.tickets.find((t) => t.id === op.ticketId) ?? (agenda.closure?.id === op.ticketId ? agenda.closure : null);
			if (!ticket) return { ok: false, error: { kind: "domain", error: { kind: "notFound", message: "Unknown ticket" } } };
			return { ok: true, value: { ticket } };
		},
		meerkatProject: () => project,
	};
}

describe("dispatch:// read-only internal URL protocol", () => {
	const mainCaller: ResolvedUrlCaller = {
		kind: "main",
		caller: { kind: "main", agentId: "main", sessionId: "sess-main", sessionFile: null },
	};
	const seatCaller: ResolvedUrlCaller = {
		kind: "seat",
		seat: {
			caller: {
				kind: "seat",
				agentId: "seat-1",
				sessionId: "sess-seat",
				sessionFile: "/tmp/seat.jsonl",
				ticketId: "A",
				revision: 1,
				role: "owner",
			},
			brief: "You are the owner seat for dispatch ticket A.",
		},
	};

	test("registers without promptDoc and is strictly read-only", () => {
		const router = new InternalUrlRouter();
		const handler = createDispatchProtocolHandler(() => null);
		expect(handler.promptDoc).toBeUndefined();
		expect(handler.promptReference).toBeUndefined();
		expect(handler.spec.write).toBeUndefined();
		expect(handler.spec.immutable).toBe(true);
		expect(registerInternalScheme(router, "omp-dispatch", handler)).toEqual({ kind: "registered" });
		expect(router.canHandle("dispatch://status")).toBe(true);
		expect(
			router
				.describe({
					skillUriAccess: false,
					ruleCount: 0,
					securityEnabled: false,
					settingsApproval: false,
					outReplies: false,
					subagent: false,
				})
				.some((line) => line.includes("dispatch://")),
		).toBe(false);
	});

	test("Main reads dispatch://status, dispatch://tickets with filters, and dispatch://<ticketId> including closure ids", async () => {
		const agenda = makeAgenda();
		const router = new InternalUrlRouter();
		registerInternalScheme(
			router,
			"omp-dispatch",
			createDispatchProtocolHandler(() => makeRuntime(agenda, { "sess-main": mainCaller, "sess-seat": seatCaller })),
		);

		const statusRes = await router.resolve("dispatch://status", { sessionId: "sess-main" });
		const statusJson = JSON.parse(String(statusRes.content)) as AgendaView;
		expect(statusJson.launchable).toEqual(["A"]);
		expect(statusJson.agenda.tickets.map((t) => t.id)).toEqual(["A", "B"]);

		const allTickets = JSON.parse(String((await router.resolve("dispatch://tickets", { sessionId: "sess-main" })).content)) as {
			tickets: { id: string }[];
		};
		expect(allTickets.tickets.map((t) => t.id)).toEqual(["A", "B"]);

		const repoFiltered = JSON.parse(
			String((await router.resolve("dispatch://tickets?repo=oh-my-omp/omp-config", { sessionId: "sess-main" })).content),
		) as { tickets: { id: string }[] };
		expect(repoFiltered.tickets.map((t) => t.id)).toEqual(["B"]);

		const limited = JSON.parse(String((await router.resolve("dispatch://tickets?limit=1", { sessionId: "sess-main" })).content)) as {
			tickets: { id: string }[];
		};
		expect(limited.tickets.map((t) => t.id)).toEqual(["A"]);

		const matchingProject = JSON.parse(
			String((await router.resolve("dispatch://tickets?project=oh-my-omp/7", { sessionId: "sess-main" })).content),
		) as { tickets: { id: string }[] };
		expect(matchingProject.tickets.map((t) => t.id)).toEqual(["A", "B"]);

		const mismatchedProject = JSON.parse(
			String((await router.resolve("dispatch://tickets?project=oh-my-omp/99", { sessionId: "sess-main" })).content),
		) as { tickets: { id: string }[] };
		expect(mismatchedProject.tickets).toEqual([]);

		const oneTicket = JSON.parse(String((await router.resolve("dispatch://B", { sessionId: "sess-main" })).content)) as {
			ticket: { id: string };
		};
		expect(oneTicket.ticket.id).toBe("B");

		const closureId = agenda.closure!.id;
		const closureRes = JSON.parse(String((await router.resolve(`dispatch://${closureId}`, { sessionId: "sess-main" })).content)) as {
			ticket: { id: string };
		};
		expect(closureRes.ticket.id).toBe(closureId);
	});

	test("Seat reads dispatch://seat and is refused dispatch://status, dispatch://tickets, and other tickets", async () => {
		const agenda = makeAgenda();
		const router = new InternalUrlRouter();
		registerInternalScheme(
			router,
			"omp-dispatch",
			createDispatchProtocolHandler(() => makeRuntime(agenda, { "sess-main": mainCaller, "sess-seat": seatCaller })),
		);

		const seatRes = JSON.parse(String((await router.resolve("dispatch://seat", { sessionId: "sess-seat" })).content)) as {
			seat: { ticketId: string; revision: number; role: string };
			brief: string;
			ticket: { id: string };
		};
		expect(seatRes.seat).toEqual({ ticketId: "A", revision: 1, role: "owner" });
		expect(seatRes.brief).toContain("owner seat");
		expect(seatRes.ticket.id).toBe("A");

		await expect(router.resolve("dispatch://status", { sessionId: "sess-seat" })).rejects.toThrow("Only Main may read dispatch://status");
		await expect(router.resolve("dispatch://tickets", { sessionId: "sess-seat" })).rejects.toThrow("Only Main may read dispatch://tickets");
		await expect(router.resolve("dispatch://B", { sessionId: "sess-seat" })).rejects.toThrow("unauthorized");
		await expect(router.resolve("dispatch://seat", { sessionId: "sess-main" })).rejects.toThrow("only available to a bound ticket seat");
	});

	test("rejects inactive coordinator, invalid query parameters, and writes", async () => {
		const router = new InternalUrlRouter();
		registerInternalScheme(
			router,
			"omp-dispatch",
			createDispatchProtocolHandler(() => null),
		);
		await expect(router.resolve("dispatch://status", { sessionId: "sess-main" })).rejects.toThrow("not a Dispatch coordinator");
		await expect(router.write("dispatch://status", "nope")).rejects.toThrow("read-only");

		const agenda = makeAgenda();
		registerInternalScheme(
			router,
			"omp-dispatch",
			createDispatchProtocolHandler(() => makeRuntime(agenda, { "sess-main": mainCaller })),
		);
		await expect(router.resolve("dispatch://tickets?unknown=1", { sessionId: "sess-main" })).rejects.toThrow(
			'Unknown query parameter "unknown"',
		);
		await expect(router.resolve("dispatch://tickets?limit=0", { sessionId: "sess-main" })).rejects.toThrow("Invalid limit query parameter");
		await expect(router.resolve("dispatch://tickets?repo=bad", { sessionId: "sess-main" })).rejects.toThrow("Invalid repo query parameter");
		await expect(router.resolve("dispatch://tickets?project=bad", { sessionId: "sess-main" })).rejects.toThrow(
			"Invalid project query parameter",
		);
	});
});
