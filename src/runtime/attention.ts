import { awaitsLaunch, delivered, ESCALATES_ON_FAILURE, parentDefinition } from "../domain/engine.ts";
import type { ReadonlyAgenda, Role } from "../domain/model.ts";
import { ESCALATED, parentSeatRoles, ticketSeatRoles } from "../domain/workflow.ts";

export function attentionKeys(agenda: ReadonlyAgenda, active: (ticketId: string, role: Role) => boolean): string[] {
	if (agenda.lifecycle !== "active") return [];
	const keys: string[] = [];
	for (const ticket of agenda.tickets) {
		if (awaitsLaunch(agenda, ticket)) keys.push(`launch:${ticket.id}`);
		if (ticket.state === ESCALATED) keys.push(`escalated:${ticket.id}:${ticket.revision}`);
	}
	const closure = agenda.closure;
	if (closure?.state === ESCALATED) keys.push(`escalated:${closure.id}:${closure.revision}`);
	for (const effect of agenda.effects)
		if (effect.state.kind === "failed" && !ESCALATES_ON_FAILURE[effect.action.kind]) keys.push(`failed:${effect.ticketId}:${effect.id}`);
	const ticketRoles = ticketSeatRoles(agenda.workflow);
	const settled =
		agenda.tickets.every((ticket) => delivered(agenda, ticket)) &&
		(!agenda.parent || (closure !== null && parentDefinition(agenda.workflow, closure)?.kind === "final")) &&
		agenda.effects.every((effect) => effect.state.kind === "confirmed" || effect.state.kind === "cancelled") &&
		!agenda.tickets.some((ticket) => ticketRoles.some((role) => active(ticket.id, role))) &&
		!(closure && parentSeatRoles(agenda.workflow).some((role) => active(closure.id, role)));
	if (settled) keys.push("finish");
	return keys;
}

export class Attention {
	private notified = new Set<string>();
	observe(agenda: ReadonlyAgenda, active: (ticketId: string, role: Role) => boolean): string[] {
		const keys = attentionKeys(agenda, active);
		const fresh = keys.filter((key) => !this.notified.has(key));
		this.notified = new Set(keys);
		return fresh;
	}
}
