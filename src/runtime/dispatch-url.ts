import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { parseRepoReference, sameRepo } from "../domain/identity.ts";
import type { Caller, PortError, PortInput, Result } from "../domain/model.ts";
import type { ResolvedUrlCaller } from "../ports/contracts.ts";
import type { AgendaView, ControllerOutput, RuntimeError } from "./controller.ts";

export interface DispatchUrlRuntime {
	resolveCaller(context?: ResolveContext): Result<ResolvedUrlCaller, PortError>;
	execute(
		caller: Caller,
		operation: Extract<PortInput, { op: "status" | "tickets" | "read" }>,
	): Promise<Result<ControllerOutput, RuntimeError>>;
	meerkatProject(): { owner: string; number: number } | null;
}

const PROJECT_RE = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\/([1-9][0-9]{0,14})$/;
const LIMIT_RE = /^[1-9][0-9]*$/;
const ALLOWED_TICKETS_PARAMS = new Set(["repo", "project", "limit"]);

function jsonResource(url: InternalUrl, payload: unknown): InternalResource<string> {
	return {
		url: url.rawHref ?? url.href,
		content: JSON.stringify(payload, null, 2),
		contentType: "application/json",
		immutable: true,
	};
}

function extractTarget(url: InternalUrl): string {
	const host = decodeURIComponent(url.rawHost || url.hostname);
	const rawPath = (url.rawPathname ?? url.pathname).replace(/^\/+/, "");
	const path = rawPath.length > 0 ? decodeURIComponent(rawPath) : "";
	if (!host && !path) return "";
	return path.length > 0 ? `${host}/${path}` : host;
}

function isAgendaView(output: ControllerOutput): output is AgendaView {
	return "agenda" in output;
}

export function createDispatchProtocolHandler(getRuntime: () => DispatchUrlRuntime | null): ProtocolHandler {
	return {
		scheme: "dispatch",
		spec: {
			backing: "virtual",
			selectors: "lines",
			immutable: true,
		},
		async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource<string>> {
			if (url.hash) throw new ToolError(`Invalid dispatch:// URL: ${url.rawHref ?? url.href}. Fragments are not supported.`);
			const runtime = getRuntime();
			if (!runtime) throw new ToolError("This process is not a Dispatch coordinator.");
			const resolved = runtime.resolveCaller(context);
			if (!resolved.ok) throw new ToolError(resolved.error.message);

			const target = extractTarget(url);
			if (!target) {
				throw new ToolError(
					"Missing dispatch:// target. Main uses dispatch://status, dispatch://tickets, or dispatch://<ticketId>; seats use dispatch://seat.",
				);
			}

			if (target === "seat") {
				if (url.search) throw new ToolError("dispatch://seat does not accept query parameters.");
				if (resolved.value.kind !== "seat") {
					throw new ToolError(
						"dispatch://seat is only available to a bound ticket seat; Main uses dispatch://status, dispatch://tickets, or dispatch://<ticketId>.",
					);
				}
				const { seat } = resolved.value;
				const result = await runtime.execute(seat.caller, { op: "read", ticketId: seat.caller.ticketId });
				if (!result.ok) throw new ToolError(JSON.stringify(result.error));
				if (!("ticket" in result.value)) throw new ToolError("Unexpected response for dispatch://seat.");
				return jsonResource(url, {
					seat: {
						ticketId: seat.caller.ticketId,
						revision: seat.caller.revision,
						role: seat.caller.role,
					},
					brief: seat.brief,
					ticket: result.value.ticket,
				});
			}

			if (target === "status") {
				if (url.search) throw new ToolError("dispatch://status does not accept query parameters.");
				if (resolved.value.kind !== "main") {
					throw new ToolError("Only Main may read dispatch://status; seats read dispatch://seat.");
				}
				const result = await runtime.execute(resolved.value.caller, { op: "status" });
				if (!result.ok) throw new ToolError(JSON.stringify(result.error));
				return jsonResource(url, result.value);
			}

			if (target === "tickets") {
				if (resolved.value.kind !== "main") {
					throw new ToolError("Only Main may read dispatch://tickets; seats read dispatch://seat.");
				}
				for (const key of url.searchParams.keys()) {
					if (!ALLOWED_TICKETS_PARAMS.has(key)) {
						throw new ToolError(`Unknown query parameter "${key}" on dispatch://tickets. Supported: repo, project, limit.`);
					}
				}
				const repoParam = url.searchParams.get("repo");
				let repoFilter: { owner: string; name: string } | null = null;
				if (repoParam !== null) {
					const parsedRepo = parseRepoReference(repoParam);
					if (!parsedRepo.ok) throw new ToolError(`Invalid repo query parameter on dispatch://tickets: ${parsedRepo.error}`);
					repoFilter = parsedRepo.value;
				}
				const projectParam = url.searchParams.get("project");
				let projectFilter: { owner: string; number: number } | null = null;
				if (projectParam !== null) {
					const match = PROJECT_RE.exec(projectParam);
					if (!match?.[1] || !match[2]) {
						throw new ToolError(
							`Invalid project query parameter on dispatch://tickets: expected <owner>/<number>, got ${JSON.stringify(projectParam)}`,
						);
					}
					projectFilter = { owner: match[1], number: Number(match[2]) };
				}
				const limitParam = url.searchParams.get("limit");
				let limitFilter: number | null = null;
				if (limitParam !== null) {
					if (!LIMIT_RE.test(limitParam)) {
						throw new ToolError(
							`Invalid limit query parameter on dispatch://tickets: expected a positive integer, got ${JSON.stringify(limitParam)}`,
						);
					}
					limitFilter = Number(limitParam);
				}

				const result = await runtime.execute(resolved.value.caller, { op: "tickets" });
				if (!result.ok) throw new ToolError(JSON.stringify(result.error));
				if (!isAgendaView(result.value)) throw new ToolError("Unexpected response for dispatch://tickets.");
				const view = result.value;

				let tickets = [...view.agenda.tickets];
				if (repoFilter) {
					const filter = repoFilter;
					tickets = tickets.filter((ticket) => sameRepo(ticket.issue.repo, filter) || sameRepo(ticket.target.repo, filter));
				}
				if (projectFilter) {
					const activeProject = runtime.meerkatProject();
					if (
						!activeProject ||
						activeProject.owner.toLowerCase() !== projectFilter.owner.toLowerCase() ||
						activeProject.number !== projectFilter.number
					) {
						tickets = [];
					}
				}
				if (limitFilter !== null) {
					tickets = tickets.slice(0, limitFilter);
				}

				const ids = new Set(tickets.map((ticket) => ticket.id));
				return jsonResource(url, {
					agendaId: view.agenda.id,
					lifecycle: view.agenda.lifecycle,
					parent: view.agenda.parent,
					tickets,
					closure: view.agenda.closure,
					launchable: view.launchable.filter((id) => ids.has(id)),
					asking: view.asking.filter((item) => ids.has(item.ticketId)),
					seated: view.seated.filter((item) => ids.has(item.ticketId) || item.ticketId === view.agenda.closure?.id),
				});
			}

			if (url.search) throw new ToolError(`dispatch://${target} does not accept query parameters.`);
			const caller = resolved.value.kind === "main" ? resolved.value.caller : resolved.value.seat.caller;
			const result = await runtime.execute(caller, { op: "read", ticketId: target });
			if (!result.ok) throw new ToolError(JSON.stringify(result.error));
			return jsonResource(url, result.value);
		},
	};
}
