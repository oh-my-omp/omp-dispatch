import { hostname } from "node:os";
import { z } from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { logger } from "@oh-my-pi/pi-utils";
import { applyActiveTools } from "./omomp-shared/active-tools.ts";
import { tr } from "./omomp-shared/i18n.ts";
import { registerInternalScheme } from "./omomp-shared/internal-url.ts";
import { omompTool } from "./omomp-shared/tool-entry.ts";
import type { ParseError, PortInput, Result } from "./src/domain/model.ts";
import { parseDispatchStepParameters, parseDispatchTicketParameters } from "./src/domain/parse.ts";
import { buildPublicGrammar } from "./src/domain/public-grammar.ts";
import { launcherCommand } from "./src/launcher/commands.ts";
import { loadMeerkatConfig, type MeerkatConfig } from "./src/meerkat/config.ts";
import type { HostPort } from "./src/ports/contracts.ts";
import { createGitHubPort } from "./src/ports/github.ts";
import { createGuardiansPort } from "./src/ports/guardians.ts";
import { createHostPort } from "./src/ports/host.ts";
import { createProcessPort } from "./src/ports/process.ts";
import { readRuntimeSettings } from "./src/ports/runtime-settings.ts";
import { createAgendaFiles } from "./src/ports/state.ts";
import { configuredWorkflow } from "./src/ports/workflow-settings.ts";
import { Attention } from "./src/runtime/attention.ts";
import { DispatchController, type RuntimeError } from "./src/runtime/controller.ts";
import { type CoordinatorIdentity, coordinatorBriefing, parseCoordinatorFlag } from "./src/runtime/coordinator.ts";
import { createDispatchProtocolHandler, type DispatchUrlRuntime } from "./src/runtime/dispatch-url.ts";
import { runtimeErrorText } from "./src/runtime/error-text.ts";
import { RuntimeExit } from "./src/runtime/exit.ts";

const SLOT = Symbol.for("omp-dispatch.runtime.v4");
type Identity = { kind: "absent" } | { kind: "invalid"; message: string } | ({ kind: "coordinator" } & CoordinatorIdentity);

class ProcessRuntime {
	private identity: Identity | null = null;
	private binding: { pi: ExtensionAPI; ctx: ExtensionContext } | null = null;
	private controller: DispatchController | null = null;
	private host: HostPort | null = null;
	private meerkatProjectRef: { owner: string; number: number } | null = null;
	private readonly attention = new Attention();
	private readonly exit = new RuntimeExit();
	private started = false;
	private deferred = false;
	readIdentity(pi: ExtensionAPI): Identity {
		if (this.identity) return this.identity;
		const flag = pi.getFlag("dispatch");
		if (flag === undefined) {
			this.identity = { kind: "absent" };
		} else {
			const parsed = parseCoordinatorFlag(flag);
			this.identity = parsed.ok ? { kind: "coordinator", ...parsed.value } : { kind: "invalid", message: parsed.error };
		}
		return this.identity;
	}
	private report(error: RuntimeError): void {
		logger.error("Dispatch runtime error", { error: JSON.stringify(error) });
		this.binding?.ctx.ui.notify(runtimeErrorText(error), "error");
	}
	private changed(turnEnded = false): void {
		const agenda = this.controller?.snapshot(),
			binding = this.binding,
			host = this.host;
		if (!agenda || !binding || !host) return;
		if (!turnEnded && !binding.ctx.isIdle()) {
			this.deferred = true;
			return;
		}
		this.deferred = false;
		const fresh = this.attention.observe(agenda, (ticketId, role) => host.active(ticketId, role));
		this.exit.commit(agenda.lifecycle === "completed", agenda);
		if (!fresh.length) return;
		binding.pi.sendMessage(
			{
				customType: "dispatch-attention",
				display: true,
				content: `Dispatch needs Main: ${fresh.join(", ")}. launch:<ticket> may be launched with dispatch_step; escalated:<ticket>:<revision> awaits read dispatch://<ticket> and dispatch_step resolve; failed:<ticket>:<effect> is a failed Meerkat effect (a record write, or the request asking the intent guardians to settle a worker question) that blocks finish until dispatch_step resolve settles it with retry, adopt or cancel, and a failed guardians request is sent again by resolve to Asking with retry on it; finish means every ticket and the closure are Done (call dispatch_ticket finish). Use read dispatch://status for the source-confirmed agenda; this notification is not a ticket snapshot.`,
			},
			{ triggerTurn: true, deliverAs: "nextTurn" },
		);
	}
	mainTurnEnded(ctx: ExtensionContext): void {
		if (this.deferred && this.binding?.ctx.sessionManager === ctx.sessionManager) this.changed(true);
	}
	urlRuntime(): DispatchUrlRuntime | null {
		const host = this.host,
			controller = this.controller;
		if (!host || !controller || !host.resolveCaller) return null;
		const resolveCaller = host.resolveCaller.bind(host);
		return {
			resolveCaller,
			execute: (caller, operation) => controller.execute(caller, operation),
			meerkatProject: () => this.meerkatProjectRef,
		};
	}
	async start(pi: ExtensionAPI, ctx: ExtensionContext, identity: CoordinatorIdentity): Promise<void> {
		if (this.started) return;
		const root = AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
		if (ctx.agent.id !== MAIN_AGENT_ID || ctx.agent.kind !== "main" || !root || root.sessionManager !== ctx.sessionManager)
			throw new Error("Dispatch requires the actual native Main");
		this.started = true;
		this.binding = { pi, ctx };
		this.exit.grant(() => ctx.shutdown());
		const settings = await readRuntimeSettings(ctx.cwd);
		if (!settings.ok) {
			const message = `${tr("Dispatch settings are invalid; the coordinator does not start", "调度设置无效，协调者不启动")}:\n${settings.error}`;
			ctx.ui.notify(message, "error");
			throw new Error(message);
		}
		const directory = settings.value.dataDir;
		let meerkat: MeerkatConfig | null = null;
		if (settings.value.meerkat) {
			const loaded = await loadMeerkatConfig(settings.value.meerkat);
			if (!loaded.ok) {
				const message = `${tr("Dispatch Meerkat configuration is invalid; the coordinator does not start", "调度 Meerkat 配置无效，协调者不启动")}:\n${loaded.error}`;
				ctx.ui.notify(message, "error");
				throw new Error(message);
			}
			meerkat = loaded.value;
		}
		this.meerkatProjectRef = meerkat ? { owner: meerkat.repos.agenda.project.owner, number: meerkat.repos.agenda.project.number } : null;
		this.host = createHostPort({
			dataDir: directory,
			ticketRevision: (ticketId) => this.controller?.ticketRevision(ticketId) ?? null,
			execute: async (caller, input) => {
				if (!this.controller)
					return { ok: false, error: { kind: "domain", error: { kind: "ownershipBlocked", message: "Coordinator has not started" } } };
				return this.controller.execute(caller, input);
			},
			onExit: (seat, handedOff, error) => {
				if (handedOff && error)
					this.report({
						kind: "host",
						error: { kind: "unavailable", message: `Ticket ${seat.ticketId} ${seat.role} seat cleanup: ${error}` },
					});
				this.controller?.seatExited(seat, handedOff, error);
				this.changed();
			},
			onSeatError: (ticketId, message) =>
				this.report({ kind: "host", error: { kind: "unavailable", message: `Ticket ${ticketId} seat: ${message}` } }),
		});
		this.controller = new DispatchController({
			issue: identity.issue,
			files: createAgendaFiles(directory),
			github: createGitHubPort({
				meerkat: meerkat
					? {
							owner: meerkat.repos.agenda.project.owner,
							number: meerkat.repos.agenda.project.number,
							statusField: meerkat.project.fields.status.name,
						}
					: null,
			}),
			host: this.host,
			process: createProcessPort(),
			cwd: ctx.cwd,
			meerkat: meerkat
				? {
						context: {
							host: hostname(),
							pid: process.pid,
							status: { inProgress: meerkat.project.fields.status.options.inProgress, done: meerkat.project.fields.status.options.done },
							ask: {
								defaultTier: meerkat.delivery.defaultTier,
								tierHelp: meerkat.delivery.tierHelp,
								resumePrompt: meerkat.delivery.resumePrompt,
							},
						},
						guardians: createGuardiansPort(meerkat.delivery.guardiansURL),
					}
				: null,
			workflow: () => configuredWorkflow(ctx.cwd, directory),
			intervalSeconds: settings.value.intervalSeconds,
			onChange: () => this.changed(),
			onError: (error) => this.report(error),
		});
		const caller = this.host.bind(ctx);
		if (!caller.ok || caller.value.kind !== "main") throw new Error("Cannot bind Main to the coordinator");
		this.controller.setMain(caller.value);
		await applyActiveTools(pi, [...pi.getActiveTools(), "dispatch_ticket", "dispatch_step"]);
		const saved = await this.controller.startup(caller.value);
		if (!saved.ok) this.report(saved.error);
		pi.sendMessage(
			{
				customType: "dispatch-start",
				display: true,
				content: coordinatorBriefing({
					reference: identity.reference,
					saved: saved.ok ? { kind: "listed", active: saved.value } : { kind: "unreadable", error: JSON.stringify(saved.error) },
				}),
			},
			{ triggerTurn: true, deliverAs: "nextTurn" },
		);
	}
	async execute(ctx: ExtensionContext, parsed: Result<PortInput, ParseError>) {
		if (!parsed.ok) return { ok: false, error: { kind: "parse", error: parsed.error } };
		if (!this.host || !this.controller)
			return { ok: false, error: { kind: "inactive", message: "This process is not a Dispatch coordinator" } };
		const caller = this.host.bind(ctx);
		if (!caller.ok) return { ok: false, error: { kind: "host", error: caller.error } };
		const result = await this.controller.execute(caller.value, parsed.value);
		this.changed();
		return result;
	}
	async shutdown(ctx: ExtensionContext): Promise<void> {
		if (this.binding?.ctx.sessionManager === ctx.sessionManager) await this.controller?.shutdown();
	}
}
const slots = globalThis as typeof globalThis & { [SLOT]?: ProcessRuntime };

export default function dispatch(pi: ExtensionAPI): void {
	if (!slots[SLOT]) slots[SLOT] = new ProcessRuntime();
	const runtime = slots[SLOT];
	const grammar = buildPublicGrammar(z);
	const schemeResult = registerInternalScheme(
		InternalUrlRouter.instance(),
		"omp-dispatch",
		createDispatchProtocolHandler(() => runtime.urlRuntime()),
	);
	if (schemeResult.kind !== "registered") {
		pi.logger.warn(`omp-dispatch: dispatch:// registration skipped: ${schemeResult.reason}`);
	}
	pi.registerFlag("dispatch", {
		description: tr("Start Main as coordinator for <owner>/<repo>#<number>", "将 Main 启动为 <owner>/<repo>#<number> 的协调者"),
		type: "string",
	});
	pi.registerTool(
		omompTool({
			name: "dispatch_ticket",
			label: tr("Dispatch Ticket", "调度工单"),
			description:
				"Manage Dispatch agenda lifecycle (convene a new ticket graph, resume a saved active agenda, or finish a completed agenda). Read live state via read dispatch://status, dispatch://tickets, or dispatch://<ticketId>.",
			loadMode: "essential",
			parameters: grammar.dispatchTicketParametersSchema,
			defaultInactive: true,
			async execute(_id, params, _signal, _update, ctx) {
				const response = await runtime.execute(ctx, parseDispatchTicketParameters(params));
				return { content: [{ type: "text", text: JSON.stringify(response) }], details: response, isError: !response.ok };
			},
		}),
	);
	pi.registerTool(
		omompTool({
			name: "dispatch_step",
			label: tr("Dispatch Step", "调度步骤"),
			description:
				"Launch a Dispatch ticket once (Dispatch relays its seats automatically) or resolve a ticket/closure with an exceptional ruling, topology edit, effect disposition, or GitHub write actions. Read state via read dispatch://status or dispatch://<ticketId>.",
			loadMode: "essential",
			parameters: grammar.dispatchStepParametersSchema,
			defaultInactive: true,
			async execute(_id, params, _signal, _update, ctx) {
				const response = await runtime.execute(ctx, parseDispatchStepParameters(params));
				return { content: [{ type: "text", text: JSON.stringify(response) }], details: response, isError: !response.ok };
			},
		}),
	);
	pi.registerCommand("dispatch-launcher", {
		description: tr(
			"Install, uninstall, or inspect the local Dispatch launcher, or register its GitHub App (install|uninstall|status|github-app register --webhook-url <url>)",
			"安装、卸载或查看本地调度启动器，或注册其 GitHub App（install|uninstall|status|github-app register --webhook-url <url>）",
		),
		async handler(args, ctx) {
			const result = await launcherCommand(
				args
					.trim()
					.split(/\s+/)
					.filter((part) => part.length > 0),
			);
			ctx.ui.notify(result.ok ? result.value : result.error, result.ok ? "info" : "error");
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		const identity = runtime.readIdentity(pi);
		if (identity.kind === "absent") return;
		if (identity.kind === "invalid") {
			ctx.ui.notify(
				tr("--dispatch must carry a value of the form <owner>/<repo>#<number>", "--dispatch 的值必须为 <owner>/<repo>#<number> 格式"),
				"error",
			);
			return;
		}
		if (ctx.agent.id === MAIN_AGENT_ID && ctx.agent.kind === "main") await runtime.start(pi, ctx, identity);
	});
	pi.on("agent_end", (_event, ctx) => runtime.mainTurnEnded(ctx));
	pi.on("session_shutdown", async (_event, ctx) => runtime.shutdown(ctx));
}
