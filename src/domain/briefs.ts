import type {Agenda,PmAsk} from './model.ts';
import type {SeatSpec} from './engine.ts';

/** The handoff contract of a seat's kind and subject; the workflow supplies only the seat's duty. */
function protocol(seat:SeatSpec):string {
  if(seat.kind==='work')return 'Push your code branch. Submit ticketId, revision, branch, head, title, and a complete PR body closing exactly this issue through dispatch submit. If blocked, ambiguous, split, or already satisfied, use escalate with kind question/blocked/split/noCode and evidence. The workflow publishes and merges; do not merge your branch into the target yourself.';
  const checkout=seat.subject==='pullRequest'?'a detached checkout of exactly the pull request head under judgment':seat.subject==='mergeCommit'?'a detached checkout of exactly the merge commit under judgment':'a checkout of the target branch after every child ticket was delivered';
  return `Your working directory is ${checkout}. Judge it against the complete current contract and the exact gate stamp. Submit dispatch verdict with ticketId, revision, role ${seat.role}, ok, and a concrete evidence note; the workflow decides where a pass or a failure leads. Do not modify code. Use escalate for a non-programmatic question or blocker.`;
}

/**
 * Under PM integration a work seat's question goes to the intent guardians: the brief explains the tier from the
 * PM configuration and that asking ends the session.
 */
function askProtocol(ask:PmAsk):string {
  return `A question goes to the intent guardians, not to Main: escalate with kind question, reason holding the decision item exactly as they should read it, and tier simple or complex (${ask.defaultTier} when omitted). ${ask.tierHelp} Asking ends this session at once: Dispatch stops it right after the escalate succeeds, so ask only when you cannot continue without the answer, and make the question complete on its own.`;
}

/** Seat scope is one ticket. Ordinary user/tool messages carry it once at entry. `ask` is null while PM integration is off. */
export function seatBrief(state:Agenda,ticketId:string,seat:SeatSpec,ask:PmAsk|null):string {
  const ticket=state.tickets.find(ticket=>ticket.id===ticketId)??(state.closure?.id===ticketId?state.closure:null);
  if(!ticket)throw new Error('Cannot brief an unknown ticket');
  return [
    `You are the ${seat.role} seat for dispatch ticket ${ticketId}. You own only this ticket, in its ${seat.state} state.`,
    'Use dispatch read with this ticketId for the current ticket. Do not query other tickets or write GitHub PRs/issues/merges directly; the state machine owns those effects.',
    seat.brief,
    protocol(seat),
    ...(seat.kind==='work'&&ask?[askProtocol(ask)]:[]),
    'A successful submit, verdict, or escalate is your handoff. Return immediately afterward; do not wait for another assignment.',
    JSON.stringify(ticket),
  ].join('\n\n');
}
