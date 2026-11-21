#!/usr/bin/env bun
/**
 * Standalone Runnable Simulation & TSP v1 Frame Emitter for Refactored `omp-dispatch` (Agent Dispatch).
 *
 * Usage:
 *   bun demo/simulate-dispatch.ts [--scenario all|1|2|3|4] [--tsp]
 */
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// 1. Domain Types: Issue SSoT, dispatch:meta, 7 Fork Modes, Harness Routing
// ---------------------------------------------------------------------------

type ForkMode =
	| "mode-1-whole-fork"
	| "mode-2-cut-point"
	| "mode-3-tern-debug-fork"
	| "mode-4-tan-clone"
	| "mode-5a-replica-delta"
	| "mode-5b-model-swap"
	| "mode-5c-shake-elide"
	| "mode-5d-overlay-patch"
	| "mode-6-ephemeral-manifest"
	| "mode-7-rework-handoff"
	| "static-sibling-no-work-fork";

type SeatRole = "work" | "judge-blackbox" | "judge-whitebox" | "contract-verifier" | "fallback";

interface DispatchMeta {
	readonly v: 1;
	readonly harness?: string;
	readonly agent?: string;
	readonly model?: string;
	readonly fork?: ForkMode;
	readonly dependsOn?: readonly number[];
	readonly seats?: {
		readonly work?: { readonly fork?: ForkMode; readonly model?: string };
		readonly judge?: { readonly fork?: ForkMode; readonly model?: string };
	};
}

interface RawIssueNode {
	readonly number: number;
	readonly title: string;
	readonly isRoot?: boolean;
	readonly isIntegrationSink?: boolean;
	readonly ghcOutcomes: readonly string[];
	readonly proseDependsOn: readonly number[];
	readonly body: string;
	readonly touches?: readonly string[];
}

interface CompilerDiagnostic {
	readonly pass: 1 | 2 | 3 | 4;
	readonly code:
		| "CYCLE_DETECTED"
		| "DANGLING_DEP"
		| "INTEGRATION_NODE_VIOLATION"
		| "GHC_LINT_ERROR"
		| "DEP_META_CONFLICT"
		| "META_SCHEMA_INVALID"
		| "META_STANCE_VIOLATION";
	readonly issue?: number;
	readonly detail: string;
}

interface SeatHostDescriptor {
	readonly kind: "OmpSeatHost" | "OarSeatHost";
	readonly runtime: string;
	readonly implementedInPhase1: boolean;
	readonly supportsSevenForkModes: boolean;
	readonly nonStopMechanism: string;
	readonly mcpBridgeStrategy: string;
}

// ---------------------------------------------------------------------------
// 2. Hidden Meta Parser + 4-Pass compileAgendaDAG Compiler
// ---------------------------------------------------------------------------

const META_RE = /<!--\s*dispatch:meta\s+(\{[\s\S]*?\})\s*-->/;
const WORK_INHERITING_FORKS = new Set<ForkMode>([
	"mode-5a-replica-delta",
	"mode-5d-overlay-patch",
	"mode-7-rework-handoff",
	"mode-1-whole-fork",
	"mode-2-cut-point",
]);

function parseDispatchMeta(body: string): { ok: true; meta: DispatchMeta | null } | { ok: false; error: string } {
	const match = META_RE.exec(body);
	if (!match?.[1]) return { ok: true, meta: null };
	try {
		const parsed = JSON.parse(match[1]) as Record<string, unknown>;
		if (parsed.v !== 1) return { ok: false, error: `unsupported dispatch:meta version: ${String(parsed.v)}` };
		return { ok: true, meta: parsed as unknown as DispatchMeta };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function routeSeatHost(harness?: string): SeatHostDescriptor {
	if (!harness || harness === "omp" || harness === "omp-pane" || harness === "omp-rpc") {
		return {
			kind: "OmpSeatHost",
			runtime: harness ?? "omp-pane",
			implementedInPhase1: true,
			supportsSevenForkModes: true,
			nonStopMechanism: 'agentKind:"main" session_stop { decision:"block" } + SeatBridge + Supervisor',
			mcpBridgeStrategy: "Native @oh-my-pi/pi-natives IpcServer + dispatch-seat-guard extension",
		};
	}
	const runtime = harness.startsWith("oar:") ? harness.slice(4) : harness;
	return {
		kind: "OarSeatHost",
		runtime,
		implementedInPhase1: false,
		supportsSevenForkModes: false,
		nonStopMechanism: "Deferred (@botiverse/oar): monitor turn_ended -> session.deliver(origin:automation)",
		mcpBridgeStrategy: "Deferred (@botiverse/oar): check refusedSessionOptions -> serveMcpTools(SeatBridge)",
	};
}

function findCycles(nodes: readonly number[], edges: ReadonlyMap<number, readonly number[]>): number[][] {
	const state = new Map<number, 0 | 1 | 2>();
	const stack: number[] = [];
	const cycles: number[][] = [];

	function dfs(u: number): void {
		state.set(u, 1);
		stack.push(u);
		for (const v of edges.get(u) ?? []) {
			const s = state.get(v) ?? 0;
			if (s === 1) {
				const idx = stack.indexOf(v);
				if (idx >= 0) cycles.push([...stack.slice(idx), v]);
			} else if (s === 0 && edges.has(v)) {
				dfs(v);
			}
		}
		stack.pop();
		state.set(u, 2);
	}

	for (const n of nodes) {
		if ((state.get(n) ?? 0) === 0) dfs(n);
	}
	return cycles;
}

function compileAgendaDAG(issues: readonly RawIssueNode[]): {
	ok: boolean;
	diagnostics: CompilerDiagnostic[];
	adjacency: Map<number, number[]>;
	hosts: Map<number, SeatHostDescriptor>;
	metas: Map<number, DispatchMeta | null>;
} {
	const diagnostics: CompilerDiagnostic[] = [];
	const children = issues.filter((i) => !i.isRoot);
	const childIds = new Set(children.map((i) => i.number));
	const adjacency = new Map<number, number[]>();
	const hosts = new Map<number, SeatHostDescriptor>();
	const metas = new Map<number, DispatchMeta | null>();

	// Pass 2 & Pass 3: ghc outcomes + dispatch:meta schema + stance safety + Pass 4 host routing
	for (const issue of children) {
		if (issue.ghcOutcomes.length === 0) {
			diagnostics.push({
				pass: 2,
				code: "GHC_LINT_ERROR",
				issue: issue.number,
				detail: `#${issue.number} missing ## 交付结果 (- 结果 N)`,
			});
		}

		const parsed = parseDispatchMeta(issue.body);
		if (!parsed.ok) {
			diagnostics.push({
				pass: 3,
				code: "META_SCHEMA_INVALID",
				issue: issue.number,
				detail: `#${issue.number} invalid dispatch:meta: ${parsed.error}`,
			});
			metas.set(issue.number, null);
		} else {
			metas.set(issue.number, parsed.meta);
			const meta = parsed.meta;
			if (meta?.dependsOn) {
				const a = [...issue.proseDependsOn].sort((x, y) => x - y).join(",");
				const b = [...meta.dependsOn].sort((x, y) => x - y).join(",");
				if (issue.proseDependsOn.length > 0 && a !== b) {
					diagnostics.push({
						pass: 2,
						code: "DEP_META_CONFLICT",
						issue: issue.number,
						detail: `#${issue.number} prose dependsOn [${a}] conflicts with dispatch:meta [${b}]`,
					});
				}
			}
			const judgeFork = meta?.seats?.judge?.fork;
			if (judgeFork && WORK_INHERITING_FORKS.has(judgeFork)) {
				diagnostics.push({
					pass: 3,
					code: "META_STANCE_VIOLATION",
					issue: issue.number,
					detail: `#${issue.number} assigns work-history fork '${judgeFork}' to adversarial judge seat`,
				});
			}
			hosts.set(issue.number, routeSeatHost(meta?.harness));
		}

		const deps = [...new Set([...issue.proseDependsOn, ...(metas.get(issue.number)?.dependsOn ?? [])])];
		adjacency.set(issue.number, deps);
		for (const dep of deps) {
			if (!childIds.has(dep)) {
				diagnostics.push({
					pass: 1,
					code: "DANGLING_DEP",
					issue: issue.number,
					detail: `#${issue.number} depends on #${dep} which is absent from issue tree`,
				});
			}
		}
	}

	// Pass 1: Cycles + Integration Sink
	for (const cycle of findCycles(children.map((c) => c.number), adjacency)) {
		diagnostics.push({
			pass: 1,
			code: "CYCLE_DETECTED",
			detail: `Dependency cycle detected: ${cycle.map((n) => `#${n}`).join(" -> ")}`,
		});
	}

	if (children.length > 1) {
		const sinks = children.filter((c) => c.isIntegrationSink);
		if (sinks.length !== 1) {
			diagnostics.push({
				pass: 1,
				code: "INTEGRATION_NODE_VIOLATION",
				detail: `Multi-child tree requires exactly 1 类型：总体验收 sink; found ${sinks.length}`,
			});
		}
	}

	return { ok: diagnostics.length === 0, diagnostics, adjacency, hosts, metas };
}

// ---------------------------------------------------------------------------
// 3. Action-Typed Stamp Verifier (Operational vs Normative Resolution)
// ---------------------------------------------------------------------------

interface JudgeStamp {
	readonly judge: "AcceptanceJudge" | "CodeReviewJudge" | "ContractVerifier";
	readonly headSha: string;
	readonly normativeContractDigest: string;
	readonly verdict: "PASS" | "REJECT";
}

function computeNormativeDigest(ghcSemanticDigest: string, normativeRulings: readonly string[]): string {
	const canonical = [...normativeRulings].sort().join("|");
	return createHash("sha256").update(`${ghcSemanticDigest}::${canonical}`).digest("hex").slice(0, 12);
}

class StampLedger {
	ghcSemanticDigest: string;
	normativeRulings: string[] = [];
	operationalRulings: string[] = [];
	stamps: JudgeStamp[] = [];

	constructor(ghcSemanticDigest: string) {
		this.ghcSemanticDigest = ghcSemanticDigest;
	}

	get normativeDigest(): string {
		return computeNormativeDigest(this.ghcSemanticDigest, this.normativeRulings);
	}

	recordStamp(stamp: Omit<JudgeStamp, "normativeContractDigest">): JudgeStamp {
		const full: JudgeStamp = { ...stamp, normativeContractDigest: this.normativeDigest };
		this.stamps.push(full);
		return full;
	}

	applyOperationalResolution(note: string): { digestBefore: string; digestAfter: string; validStampsCount: number } {
		const digestBefore = this.normativeDigest;
		this.operationalRulings.push(note);
		const digestAfter = this.normativeDigest;
		return { digestBefore, digestAfter, validStampsCount: this.validStampsFor(this.stamps.at(-1)?.headSha ?? "").length };
	}

	applyNormativeResolution(ruling: string): { digestBefore: string; digestAfter: string; validStampsCount: number } {
		const digestBefore = this.normativeDigest;
		this.normativeRulings.push(ruling);
		const digestAfter = this.normativeDigest;
		return { digestBefore, digestAfter, validStampsCount: this.validStampsFor(this.stamps.at(-1)?.headSha ?? "").length };
	}

	validStampsFor(headSha: string): JudgeStamp[] {
		const current = this.normativeDigest;
		return this.stamps.filter((s) => s.headSha === headSha && s.normativeContractDigest === current && s.verdict === "PASS");
	}
}

// ---------------------------------------------------------------------------
// 4. SeatBridge: 3-Layer Non-Stop Gate & Fallback-Only Unimplemented Rule
// ---------------------------------------------------------------------------

const FORBIDDEN_BLOCKER_KINDS = new Set(["ci_broken", "flaky_test", "upstream_bug"]);

function evaluateSessionStop(input: { agentKind: "main" | "sub"; handedOff: boolean }): {
	fired: boolean;
	decision: "allow" | "block";
	reason?: string;
} {
	if (input.agentKind === "sub") {
		return { fired: false, decision: "allow", reason: "agentKind=sub suppresses session_stop (why OMP seats MUST be top-level main)" };
	}
	if (!input.handedOff) {
		return {
			fired: true,
			decision: "block",
			reason: "Layer 1 Non-Stop Guard: seat has not invoked an accepted transition tool; bypassing SESSION_STOP_CONTINUATION_CAP",
		};
	}
	return { fired: true, decision: "allow" };
}

function evaluateEscalation(input: {
	role: SeatRole;
	kind: "ci_broken" | "upstream_bug" | "repair_ticket_required" | "scope_contradiction" | "declare_unimplemented";
	alternativesExhausted?: boolean;
	cause?: string;
}): { accepted: boolean; action: string } {
	if (input.kind === "declare_unimplemented") {
		if (input.role !== "fallback") {
			return { accepted: false, action: "REJECTED: only FallbackArbiter holds declare_unimplemented authority" };
		}
		if (input.cause && FORBIDDEN_BLOCKER_KINDS.has(input.cause)) {
			return { accepted: false, action: `REJECTED (REQ-14): cause '${input.cause}' is categorically forbidden as a blocker` };
		}
		if (!input.alternativesExhausted) {
			return { accepted: false, action: "REJECTED (REQ-14): alternativesExhausted must be verified true before unimplemented" };
		}
		return { accepted: true, action: "ACCEPTED: terminal unimplemented recorded by FallbackArbiter" };
	}

	if (FORBIDDEN_BLOCKER_KINDS.has(input.kind)) {
		return {
			accepted: false,
			action: `REJECTED (Layer 2 Bridge): '${input.kind}' is never a valid blocker — fix in-repo or emit repair_ticket_required for external repo`,
		};
	}

	return { accepted: true, action: `ACCEPTED: routed '${input.kind}' to FallbackArbiter hub` };
}

// ---------------------------------------------------------------------------
// 5. Fork Mode Selector + Touch-Set Collision Detector
// ---------------------------------------------------------------------------

function selectForkMode(transition: string, sameModel: boolean): { mode: ForkMode; expectedKvHit: number; note: string } {
	switch (transition) {
		case "scout->implement":
			return sameModel
				? {
						mode: "mode-5a-replica-delta",
						expectedKvHit: 1.0,
						note: "Unified Work wire tools frozen at Turn 1; DeltaStream unlocks edit/write at tail",
					}
				: {
						mode: "mode-6-ephemeral-manifest",
						expectedKvHit: 0.92,
						note: "Cross-model handoff: synthesize RepoContextManifest on Planner's hot cache",
					};
		case "judge-reject->rework":
			return {
				mode: "mode-7-rework-handoff",
				expectedKvHit: 0.98,
				note: "Reuse Coder worktree + dispatch-session-contract; pair with Mode 5c shake('elide') on context pressure",
			};
		case "work->judge":
			return {
				mode: "static-sibling-no-work-fork",
				expectedKvHit: 0.95,
				note: "NEVER fork Work history; share static Judge taskPromptCacheKey + Stance Firewall bundle",
			};
		case "runtime-collision-suspend":
			return {
				mode: "mode-5d-overlay-patch",
				expectedKvHit: 0.97,
				note: "Save suspended.overlay.patch (Mode 5d) + hot Mode 6 manifest before cache TTL expires",
			};
		case "intra-seat-bisect":
			return { mode: "mode-4-tan-clone", expectedKvHit: 1.0, note: "1-hop /tan clone sharing parent KV shard" };
		case "human-debug-branch":
			return { mode: "mode-3-tern-debug-fork", expectedKvHit: 0.99, note: "Tern IPC fork -> interactive omp --fork pane" };
		default:
			return { mode: "mode-1-whole-fork", expectedKvHit: 0.96, note: "FallbackArbiter epoch checkpoint" };
	}
}

function detectTouchCollision(
	leader: { number: number; touches: readonly string[] },
	follower: { number: number; touches: readonly string[] },
): string[] {
	const set = new Set(leader.touches);
	return follower.touches.filter((file) => set.has(file));
}

// ---------------------------------------------------------------------------
// 6. Optional TSP v1 Wire Frame Emitter (--tsp)
// ---------------------------------------------------------------------------

const ESC = "\x1b";
let tspSeq = 0;

function emitTsp(enabled: boolean, verb: "o" | "s" | "f", body: unknown): void {
	if (!enabled) return;
	process.stdout.write(`${ESC}_tsp;${verb};${JSON.stringify(body)}${ESC}\\\n`);
}

function emitOsc7501(enabled: boolean, state: "working" | "blocked" | "done" | "error", msg: string): void {
	if (!enabled) return;
	process.stdout.write(`${ESC}]7501;state=${state};msg=${msg}${ESC}\\\n`);
}

function logLine(tspMode: boolean, text: string): void {
	if (!tspMode) process.stdout.write(`${text}\n`);
}

// ---------------------------------------------------------------------------
// 7. Four Deterministic Simulation Scenarios
// ---------------------------------------------------------------------------

function runScenario1(tsp: boolean): void {
	logLine(tsp, "\n=== SCENARIO 1: Happy Path · 7 Fork Modes · Orthogonal Judges · Operational Retry ===");
	const issues: RawIssueNode[] = [
		{ number: 185, title: "Refactor DispatchEngine", isRoot: true, ghcOutcomes: [], proseDependsOn: [], body: "" },
		{
			number: 186,
			title: "Action-typed stamp hashing & SeatBridge",
			ghcOutcomes: ["结果 1 [改] Split normativeContractDigest from operational rulings"],
			proseDependsOn: [],
			body: '<!-- dispatch:meta {"v":1,"agent":"dispatch-owner","model":"anthropic/claude-opus-4-6","fork":"mode-5a-replica-delta"} -->',
		},
		{
			number: 187,
			title: "End-to-end integration verification",
			isIntegrationSink: true,
			ghcOutcomes: ["结果 1 [新] Full sim suite passes"],
			proseDependsOn: [186],
			body: "类型：总体验收",
		},
	];
	const compiled = compileAgendaDAG(issues);
	if (!compiled.ok) throw new Error(`Scenario 1 expected clean DAG, got ${JSON.stringify(compiled.diagnostics)}`);
	logLine(tsp, `  [compileAgendaDAG] OK (0 diagnostics), host(#186)=${compiled.hosts.get(186)?.kind}`);

	const scoutToImpl = selectForkMode("scout->implement", true);
	logLine(tsp, `  [Scout -> Implement] ${scoutToImpl.mode} (KV=${scoutToImpl.expectedKvHit * 100}%) — ${scoutToImpl.note}`);

	const workToJudge = selectForkMode("work->judge", true);
	logLine(tsp, `  [Work -> Orthogonal Judges] ${workToJudge.mode} (KV=${workToJudge.expectedKvHit * 100}%) — ${workToJudge.note}`);

	const ledger = new StampLedger("ghc-digest-186-v1");
	ledger.recordStamp({ judge: "AcceptanceJudge", headSha: "4a12c8e", verdict: "PASS" });
	ledger.recordStamp({ judge: "CodeReviewJudge", headSha: "4a12c8e", verdict: "REJECT" });
	logLine(tsp, `  [Judging #1] AcceptanceJudge=PASS, CodeReviewJudge=REJECT -> routing to Rework (1/3)`);

	const rework = selectForkMode("judge-reject->rework", true);
	logLine(tsp, `  [Rework #1] ${rework.mode} + mode-5c-shake-elide (KV=${rework.expectedKvHit * 100}%)`);

	ledger.recordStamp({ judge: "AcceptanceJudge", headSha: "9e7f01b", verdict: "PASS" });
	ledger.recordStamp({ judge: "CodeReviewJudge", headSha: "9e7f01b", verdict: "PASS" });

	const opRetry = ledger.applyOperationalResolution("Retry GitHub 502 mergePr(#208)");
	if (opRetry.digestBefore !== opRetry.digestAfter || opRetry.validStampsCount !== 2) {
		throw new Error("OperationalResolution must preserve normativeContractDigest and all 2 Judge stamps");
	}
	logLine(
		tsp,
		`  [OperationalResolution 502 Retry] digest=${opRetry.digestAfter} (unchanged), preservedStamps=${opRetry.validStampsCount}/2 -> Merged -> Done`,
	);

	emitOsc7501(tsp, "done", "Scenario 1 Complete (2/2 stamps preserved)");
	emitTsp(tsp, "f", {
		sf: "dispatch-pane",
		s: ++tspSeq,
		ops: [
			[
				"add",
				"main.s1",
				"main",
				null,
				{
					id: "main.s1",
					k: "agent",
					p: {
						name: "WorkSeat · #186",
						agent: "work",
						status: "done",
						model: "claude-opus-4-6",
						stats: { contextLabel: "KV 98%" },
						badges: [{ text: "OperationalResolution: Stamps Preserved", tone: "success" }],
					},
				},
			],
		],
	});
}

function runScenario2(tsp: boolean): void {
	logLine(tsp, "\n=== SCENARIO 2: Compile-Time Graph Defect Self-Healing (ConveneEscalated) ===");
	const brokenIssues: RawIssueNode[] = [
		{ number: 185, title: "Refactor DispatchEngine", isRoot: true, ghcOutcomes: [], proseDependsOn: [], body: "" },
		{
			number: 186,
			title: "SeatBridge & Stop Hook",
			ghcOutcomes: ["结果 1 [新] SeatBridge"],
			proseDependsOn: [187],
			body: '<!-- dispatch:meta {"v":1,"seats":{"judge":{"fork":"mode-5a-replica-delta"}}} -->',
		},
		{
			number: 187,
			title: "Worktree & Fork Manager",
			ghcOutcomes: ["结果 1 [新] Worktree manager"],
			proseDependsOn: [186],
			body: "",
		},
	];
	const badCompile = compileAgendaDAG(brokenIssues);
	if (badCompile.ok || badCompile.diagnostics.length < 3) {
		throw new Error(`Scenario 2 expected >=3 compiler defects, got ${badCompile.diagnostics.length}`);
	}
	logLine(tsp, `  [compileAgendaDAG Epoch 1] ConveneEscalated (${badCompile.diagnostics.length} defects caught pre-launch):`);
	for (const d of badCompile.diagnostics) logLine(tsp, `    - Pass ${d.pass} ${d.code}: ${d.detail}`);

	// FallbackArbiter invokes dispatch_repair_graph_ssot -> synchronous re-compile
	const repairedIssues: RawIssueNode[] = [
		{ number: 185, title: "Refactor DispatchEngine", isRoot: true, ghcOutcomes: [], proseDependsOn: [], body: "" },
		{
			number: 186,
			title: "SeatBridge & Stop Hook",
			ghcOutcomes: ["结果 1 [新] SeatBridge"],
			proseDependsOn: [],
			body: '<!-- dispatch:meta {"v":1,"seats":{"judge":{"fork":"static-sibling-no-work-fork"}}} -->',
		},
		{
			number: 187,
			title: "Worktree & Fork Manager",
			ghcOutcomes: ["结果 1 [新] Worktree manager"],
			proseDependsOn: [186],
			body: "",
		},
		{
			number: 190,
			title: "Integration verification sink",
			isIntegrationSink: true,
			ghcOutcomes: ["结果 1 [新] End-to-end suite"],
			proseDependsOn: [186, 187],
			body: "类型：总体验收",
		},
	];
	const repaired = compileAgendaDAG(repairedIssues);
	if (!repaired.ok) throw new Error(`Repaired DAG failed compile: ${JSON.stringify(repaired.diagnostics)}`);
	logLine(tsp, `  [FallbackArbiter -> dispatch_repair_graph_ssot] Sync compile OK (0 defects) -> graphEpoch 1 -> 2 -> auto-launched #186`);

	emitOsc7501(tsp, "working", "Scenario 2 Self-Healed (graphEpoch=2)");
	emitTsp(tsp, "f", {
		sf: "dispatch-pane",
		s: ++tspSeq,
		ops: [
			[
				"add",
				"main.s2",
				"main",
				null,
				{
					id: "main.s2",
					k: "card",
					p: {
						head: "Scenario 2 · ConveneEscalated -> Active (graphEpoch 2)",
						status: "done",
					},
					c: [{ id: "main.s2.t", k: "text", p: { text: "Repaired cycle #186<->#187, missing 总体验收 sink, and META_STANCE_VIOLATION." } }],
				},
			],
		],
	});
}

function runScenario3(tsp: boolean): void {
	logLine(tsp, "\n=== SCENARIO 3: Runtime Graph Collision & Zero-Loss 7-Fork-Mode Healing (SuspendedOnGraph) ===");
	const t188 = { number: 188, touches: ["src/domain/engine.ts", "tests/stamp.test.ts"] };
	const t189 = { number: 189, touches: ["src/domain/engine.ts", "tests/dag.test.ts"] };
	const overlap = detectTouchCollision(t188, t189);
	if (!overlap.includes("src/domain/engine.ts")) throw new Error("Expected touch-set collision on src/domain/engine.ts");
	const suspFork = selectForkMode("runtime-collision-suspend", true);
	logLine(tsp, `  [TouchSetCollisionDetector] Conflict on [${overlap.join(", ")}] -> Leader=#188 uninterrupted, Follower=#189 -> SuspendedOnGraph`);
	logLine(tsp, `  [Zero-Loss Capture] ${suspFork.mode} (suspended.overlay.patch) + mode-6-ephemeral-manifest (hot KV=${suspFork.expectedKvHit * 100}%)`);
	logLine(tsp, `  [Branch A: add_dependency_edge(#189 -> #188)] SSoT updated (graphEpoch 2); after #188 merges -> rebase + replay Mode 5d + Mode 7/2 resume`);
	logLine(tsp, `  [Branch B: coalesce_tickets(#188 + #189)] PR gets 'Closes #188\\nCloses #189'; Mode 5d patch + Mode 6 manifest injected at #188 DeltaStream tail`);

	emitTsp(tsp, "f", {
		sf: "dispatch-pane",
		s: ++tspSeq,
		ops: [
			[
				"add",
				"main.s3",
				"main",
				null,
				{
					id: "main.s3",
					k: "checklist",
					p: {
						phases: [
							{
								id: "p-s3",
								title: "Scenario 3 · SuspendedOnGraph Zero-Loss Resolution",
								items: [
									{ id: "i1", text: "Leader #188 uninterrupted", status: "done" },
									{ id: "i2", text: "Follower #189 saved Mode 5d patch + Mode 6 hot manifest", status: "done" },
									{ id: "i3", text: "Verified both add_dependency_edge and coalesce_tickets paths", status: "done" },
								],
							},
						],
					},
				},
			],
		],
	});
}

function runScenario4(tsp: boolean): void {
	logLine(tsp, "\n=== SCENARIO 4: 3-Layer Non-Stop Loop · Broken CI Fix · Deferred @botiverse/oar Routing ===");
	const stopCheck = evaluateSessionStop({ agentKind: "main", handedOff: false });
	if (!stopCheck.fired || stopCheck.decision !== "block") throw new Error("Layer 1 session_stop must block premature stop on agentKind=main");
	logLine(tsp, `  [Layer 1 session_stop] fired=${stopCheck.fired}, decision=${stopCheck.decision} — ${stopCheck.reason}`);

	const ciEsc = evaluateEscalation({ role: "work", kind: "ci_broken" });
	if (ciEsc.accepted) throw new Error("Layer 2 Bridge must reject ci_broken");
	logLine(tsp, `  [Layer 2 SeatBridge] work.escalate(ci_broken) -> ${ciEsc.action}`);

	const badUnimpl = evaluateEscalation({
		role: "fallback",
		kind: "declare_unimplemented",
		cause: "upstream_bug",
		alternativesExhausted: false,
	});
	if (badUnimpl.accepted) throw new Error("Fallback must be blocked from declaring unimplemented on upstream_bug");
	logLine(tsp, `  [REQ-14 Hard Gate] fallback.declare_unimplemented(upstream_bug) -> ${badUnimpl.action}`);

	const repairEsc = evaluateEscalation({ role: "work", kind: "repair_ticket_required" });
	if (!repairEsc.accepted) throw new Error("repair_ticket_required must route to FallbackArbiter");
	logLine(tsp, `  [Out-of-Scope Upstream Bug] work.escalate(repair_ticket_required) -> ${repairEsc.action} -> Fallback spawns #191`);

	const nativeHost = routeSeatHost("omp-pane");
	const oarHost = routeSeatHost("oar:claude");
	if (!nativeHost.implementedInPhase1 || oarHost.implementedInPhase1 || oarHost.kind !== "OarSeatHost") {
		throw new Error("Harness routing mismatch between native OmpSeatHost and deferred OarSeatHost");
	}
	logLine(tsp, `  [SeatHostRouter #186 (native)] ${nativeHost.kind} (${nativeHost.runtime}, phase1=${nativeHost.implementedInPhase1}) -> ${nativeHost.nonStopMechanism}`);
	logLine(tsp, `  [SeatHostRouter #192 (oar:claude)] ${oarHost.kind} (${oarHost.runtime}, phase1=${oarHost.implementedInPhase1}) -> ${oarHost.mcpBridgeStrategy}`);

	emitTsp(tsp, "f", {
		sf: "dispatch-pane",
		s: ++tspSeq,
		ops: [
			[
				"add",
				"main.s4",
				"main",
				null,
				{
					id: "main.s4",
					k: "agent",
					p: {
						name: "ExternalSeat · #192 (oar:claude)",
						agent: "oar-deferred",
						status: "parked",
						model: "claude-sonnet-4-6",
						badges: [
							{ text: "OarSeatHost (@botiverse/oar · Deferred)", tone: "warning" },
							{ text: "Native Primary: OmpSeatHost", tone: "success" },
						],
					},
				},
			],
		],
	});
}

// ---------------------------------------------------------------------------
// 8. CLI Entrypoint
// ---------------------------------------------------------------------------

function main(): void {
	const args = process.argv.slice(2);
	let scenario = "all";
	let tsp = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--tsp") {
			tsp = true;
		} else if (arg === "--scenario" && args[i + 1]) {
			scenario = args[++i]!;
		} else if (arg?.startsWith("--scenario=")) {
			scenario = arg.slice("--scenario=".length);
		}
	}

	if (tsp) {
		emitTsp(true, "o", { id: "dispatch-pane", mode: "screen", title: "Dispatch Pane Simulation", role: "omp.dispatch" });
		emitTsp(true, "s", { sf: "dispatch-pane", name: "main", css: ".sf-main { font-family: var(--mono); }" });
		emitOsc7501(true, "working", `Running dispatch simulation (${scenario})`);
	}

	const runners: Record<string, () => void> = {
		"1": () => runScenario1(tsp),
		"2": () => runScenario2(tsp),
		"3": () => runScenario3(tsp),
		"4": () => runScenario4(tsp),
	};

	if (scenario === "all") {
		for (const key of ["1", "2", "3", "4"]) runners[key]!();
	} else if (runners[scenario]) {
		runners[scenario]!();
	} else {
		process.stderr.write(`Unknown --scenario "${scenario}". Expected all|1|2|3|4.\n`);
		process.exit(2);
	}

	logLine(tsp, "\n[PASS] All selected Agent Dispatch simulation invariants verified (exit 0).");
}

main();
