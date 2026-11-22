import type { SeatSpec } from "./engine.ts";
import type { MeerkatAsk, ReadonlyAgenda } from "./model.ts";

function protocol(seat: SeatSpec): string {
	if (seat.kind === "work")
		return "Push your code branch. Hand off with `dispatch_submit` passing `branch`, `head`, `title`, and a complete PR `body` closing exactly this issue (your ticket id and revision are bound to this seat). If blocked, ambiguous, split, or already satisfied, call `dispatch_escalate` with `kind` (`question`/`blocked`/`split`/`noCode`) and `reason` with evidence. The workflow publishes and merges; do not merge your branch into the target yourself.";
	const checkout =
		seat.subject === "pullRequest"
			? "a detached checkout of exactly the pull request head under judgment"
			: seat.subject === "mergeCommit"
				? "a detached checkout of exactly the merge commit under judgment"
				: "a checkout of the target branch after every child ticket was delivered";
	return `Your working directory is ${checkout}. Judge it against the complete current contract and the exact gate stamp. Submit \`dispatch_verdict\` with \`ok\` and a concrete evidence \`note\` (your ticket id, revision, and role ${seat.role} are bound to this seat); the workflow decides where a pass or a failure leads. Do not modify code. Use \`dispatch_escalate\` for a non-programmatic question or blocker.`;
}

function askProtocol(ask: MeerkatAsk): string {
	return `A question goes to the intent guardians, not to Main: call \`dispatch_escalate\` with \`kind: "question"\`, \`reason\` holding the decision item exactly as they should read it, and \`tier\` \`simple\` or \`complex\` (${ask.defaultTier} when omitted). ${ask.tierHelp} Asking ends this session at once: Dispatch stops it right after \`dispatch_escalate\` succeeds, so ask only when you cannot continue without the answer, and make the question complete on its own.`;
}

export function seatBrief(state: ReadonlyAgenda, ticketId: string, seat: SeatSpec, ask: MeerkatAsk | null): string {
	const ticket = state.tickets.find((ticket) => ticket.id === ticketId) ?? (state.closure?.id === ticketId ? state.closure : null);
	if (!ticket) throw new Error("Cannot brief an unknown ticket");
	return [
		`You are the ${seat.role} seat for dispatch ticket ${ticketId}. You own only this ticket, in its ${seat.state} state.`,
		"Use `read dispatch://seat` to inspect your bound seat context and latest ticket snapshot. Do not query other tickets or write GitHub PRs/issues/merges directly; the state machine owns those effects.",
		seat.brief,
		protocol(seat),
		...(seat.kind === "work" && ask ? [askProtocol(ask)] : []),
		"A successful `dispatch_submit`, `dispatch_verdict`, or `dispatch_escalate` is your handoff. Return immediately afterward; do not wait for another assignment.",
		JSON.stringify(ticket),
	].join("\n\n");
}
