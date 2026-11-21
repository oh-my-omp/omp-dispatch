// Worry: after a coordinator crash between GitHub applying a write and the write's outcome being recorded,
// resume performs the same write again, or a write whose outcome was unknown is sent again by itself (REQ-90).
// Boxes: the coordinator's effect executor (steps below), the coordinator crash environment epoch,
// GitHub with its in-flight requests and replies, and the contract box dispatch_agendaStore.
// A write is a chain of steps (requestWrite → markExecuting → performWrite → confirmWrite | giveUpWaiting);
// each step takes a value from its input wire, may call a port, and puts the value on the next wire.
// After a crash, reconcile settles writes still marked executing from a fresh GitHub read instead of sending them.
module writeRecovery {
  import contract.* from "../.gen/contract"
  import Vdm.* from "../.gen/contract"
  import dispatch_agendaStore as Store from "../.gen/contract"

  pure val EFFECTS = Set("e1", "e2")

  var agenda: Store::Effects
  // Which run of the coordinator process this is; a crash and restart adds one.
  var epoch: int
  // Executor wires inside the coordinator process, cleared by a crash.
  var toMark: Set[Store::EffectId]
  var toPerform: Set[Store::EffectId]
  var awaiting: Set[Store::EffectId]
  // Write requests on their way to GitHub, tagged with the run that sent them; they survive a crash.
  var inflight: Set[(Store::EffectId, int)]
  // GitHub's replies on their way back, tagged with the run that sent the request.
  var replies: Set[(Store::EffectId, int)]
  // GitHub's own record: how many times each write took effect.
  var applied: Store::EffectId -> int
  var lastCall: Call

  def shown(e: Store::EffectId): bool = applied.get(e) > 0
  def known(e: Store::EffectId): bool =
    e.in(agenda.executing) or e.in(agenda.outcomes.keys()) or e.in(toMark.union(toPerform).union(awaiting))

  // ---------- The contract box's feedback moves by its VDM post ----------
  pure def agendaAfter(s: Store::Effects, call: Call): Store::Effects = match call {
    | dispatch_agendaStore(op) => match op {
        | beginWrite(a) => { ...s, executing: s.executing.union(Set(a.e)) }
        | settleWrite(a) => { executing: s.executing.exclude(Set(a.e)), outcomes: s.outcomes.put(a.e, a.o) }
      }
    | _ => s
  }

  action commit(call: Call): bool = all {
    lastCall' = call,
    agenda' = agendaAfter(agenda, call),
  }

  action init = all {
    agenda' = Store::initial,
    epoch' = 0,
    toMark' = Set(), toPerform' = Set(), awaiting' = Set(),
    inflight' = Set(), replies' = Set(),
    applied' = EFFECTS.mapBy(_ => 0),
    lastCall' = NoCall,
  }

  // ---------- Effect executor: chained steps ----------
  // An action state asks for a write the executor does not know yet.
  action requestWrite(e: Store::EffectId): bool = all {
    not(known(e)),
    toMark' = toMark.union(Set(e)),
    toPerform' = toPerform, awaiting' = awaiting,
    epoch' = epoch, inflight' = inflight, replies' = replies, applied' = applied,
    commit(NoCall),
  }

  // REQ-90: the write is persisted as executing before it is performed.
  action markExecuting(e: Store::EffectId): bool = all {
    e.in(toMark),
    toMark' = toMark.exclude(Set(e)),
    toPerform' = toPerform.union(Set(e)),
    awaiting' = awaiting,
    epoch' = epoch, inflight' = inflight, replies' = replies, applied' = applied,
    commit(dispatch_agendaStore(Store::beginWrite({ e: e }))),
  }

  // The write request leaves for GitHub, tagged with this run.
  action performWrite(e: Store::EffectId): bool = all {
    e.in(toPerform),
    toPerform' = toPerform.exclude(Set(e)),
    awaiting' = awaiting.union(Set(e)),
    inflight' = inflight.union(Set((e, epoch))),
    toMark' = toMark,
    epoch' = epoch, replies' = replies, applied' = applied,
    commit(NoCall),
  }

  // REQ-90: once the call returns, a fresh GitHub read decides the outcome.
  action confirmWrite(e: Store::EffectId): bool = all {
    e.in(awaiting),
    (e, epoch).in(replies),
    awaiting' = awaiting.exclude(Set(e)),
    replies' = replies.exclude(Set((e, epoch))),
    toMark' = toMark, toPerform' = toPerform,
    epoch' = epoch, inflight' = inflight, applied' = applied,
    commit(dispatch_agendaStore(Store::settleWrite({
      e: e, o: if (shown(e)) Store::Outcome_Confirmed else Store::Outcome_Failed }))),
  }

  // REQ-90: a call that never returns has an unknown outcome unless a fresh read already shows the write.
  action giveUpWaiting(e: Store::EffectId): bool = all {
    e.in(awaiting),
    not((e, epoch).in(replies)),
    awaiting' = awaiting.exclude(Set(e)),
    toMark' = toMark, toPerform' = toPerform,
    epoch' = epoch, inflight' = inflight, replies' = replies, applied' = applied,
    commit(dispatch_agendaStore(Store::settleWrite({
      e: e, o: if (shown(e)) Store::Outcome_Confirmed else Store::Outcome_Uncertain }))),
  }

  // ---------- GitHub: handles each in-flight request once; the write may or may not take effect, the reply may be lost ----------
  action githubHandle(e: Store::EffectId, sender: int, takesEffect: bool, answered: bool): bool = all {
    (e, sender).in(inflight),
    inflight' = inflight.exclude(Set((e, sender))),
    applied' = if (takesEffect) applied.set(e, applied.get(e) + 1) else applied,
    replies' = if (answered) replies.union(Set((e, sender))) else replies,
    toMark' = toMark, toPerform' = toPerform, awaiting' = awaiting, epoch' = epoch,
    commit(NoCall),
  }

  // ---------- Crash environment: the coordinator process exits and restarts ----------
  // Executor wires vanish; the agenda state, in-flight requests, replies and GitHub's record stay.
  action crash = all {
    epoch' = epoch + 1,
    toMark' = Set(), toPerform' = Set(), awaiting' = Set(),
    inflight' = inflight, replies' = replies, applied' = applied,
    commit(NoCall),
  }

  // REQ-90: resume reconciles an interrupted executing write against GitHub instead of performing it again.
  action reconcile(e: Store::EffectId): bool = all {
    e.in(agenda.executing),
    not(e.in(toPerform.union(awaiting))),
    toMark' = toMark, toPerform' = toPerform, awaiting' = awaiting,
    epoch' = epoch, inflight' = inflight, replies' = replies, applied' = applied,
    commit(dispatch_agendaStore(Store::settleWrite({
      e: e, o: if (shown(e)) Store::Outcome_Confirmed else Store::Outcome_Uncertain }))),
  }

  action step = {
    nondet e = EFFECTS.oneOf()
    nondet req = inflight.union(Set(("", -1))).oneOf()
    nondet takesEffect = Set(true, false).oneOf()
    nondet reply = Set(true, false).oneOf()
    nondet roll = 1.to(6).oneOf()
    any {
      requestWrite(e), markExecuting(e), performWrite(e), confirmWrite(e), reconcile(e),
      githubHandle(req._1, req._2, takesEffect, reply),
      all { roll == 1, giveUpWaiting(e) },
      all { roll == 2, epoch < 2, crash },
    }
  }

  // ---------- Properties on observable wires ----------
  // REQ-90: no write takes effect on GitHub twice, across crashes, resumes and unknown outcomes.
  val atMostOnce = EFFECTS.forall(e => applied.get(e) <= 1)
  // REQ-90: a write recorded as confirmed is one GitHub shows.
  val confirmedIsShown = agenda.outcomes.keys().forall(e =>
    agenda.outcomes.get(e) == Store::Outcome_Confirmed implies shown(e))
  val safety = atMostOnce and confirmedIsShown

  // ---------- Coverage targets ----------
  val witnessConfirmed = agenda.outcomes.keys().exists(e => agenda.outcomes.get(e) == Store::Outcome_Confirmed)
  val witnessFailed = agenda.outcomes.keys().exists(e => agenda.outcomes.get(e) == Store::Outcome_Failed)
  // REQ-90: GitHub applied a write whose run crashed before recording its outcome; it still waits for resume.
  val witnessCrashAfterApply = agenda.executing.exists(e => shown(e) and not(e.in(awaiting)))
  pure val maxSteps_witnessCrashAfterApply = 30
  // REQ-90: a write settled as uncertain later took effect on GitHub, and nothing sent it again.
  val witnessLateApplyAfterUncertain = agenda.outcomes.keys().exists(e =>
    agenda.outcomes.get(e) == Store::Outcome_Uncertain and shown(e))
  pure val maxSteps_witnessLateApplyAfterUncertain = 30
}
