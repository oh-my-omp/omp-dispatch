// 担心：协调者在 GitHub 已应用一次写入、而该写入的结局尚未记下时崩溃，接管后把同一次写入再执行一遍；
// 或者结局未知的写入被自动再发一次（REQ-91）。
// 盒子：协调者的效果执行器（下面的各步）、协调者崩溃环境 epoch、
// 带着在途请求与回复的 GitHub，以及契约盒子 dispatch_agendaStore。
// 一次写入是一串顺接的步骤（requestWrite → markExecuting → performWrite → confirmWrite | giveUpWaiting）；
// 每一步从输入线取值，可能调用端口，再把值放到下一步的输入线上。
// 崩溃之后，reconcile 按新的 GitHub 读取结算仍记为执行中的写入，而不是重发它们。
module writeRecovery {
  import contract.* from "../.gen/contract"
  import Vdm.* from "../.gen/contract"
  import dispatch_agendaStore as Store from "../.gen/contract"

  pure val EFFECTS = Set("e1", "e2")

  var agenda: Store::Effects
  // 协调者进程的第几次运行；崩溃重启让它加一。
  var epoch: int
  // 协调者进程内执行器各步之间的线，崩溃时清空。
  var toMark: Set[Store::EffectId]
  var toPerform: Set[Store::EffectId]
  var awaiting: Set[Store::EffectId]
  // 发往 GitHub 的在途写入请求，带上发出它的那次运行；跨崩溃保留。
  var inflight: Set[(Store::EffectId, int)]
  // GitHub 在途的回复，带上发出请求的那次运行。
  var replies: Set[(Store::EffectId, int)]
  // GitHub 自己的记录：每次写入生效了几次。
  var applied: Store::EffectId -> int
  var lastCall: Call

  def shown(e: Store::EffectId): bool = applied.get(e) > 0
  def known(e: Store::EffectId): bool =
    e.in(agenda.executing) or e.in(agenda.outcomes.keys()) or e.in(toMark.union(toPerform).union(awaiting))

  // ---------- 契约盒子的反馈线按 VDM post 前进 ----------
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

  // ---------- 效果执行器：顺接的各步 ----------
  // 动作状态请求一次执行器尚不知道的写入。
  action requestWrite(e: Store::EffectId): bool = all {
    not(known(e)),
    toMark' = toMark.union(Set(e)),
    toPerform' = toPerform, awaiting' = awaiting,
    epoch' = epoch, inflight' = inflight, replies' = replies, applied' = applied,
    commit(NoCall),
  }

  // REQ-91：写入在执行之前先持久记为执行中。
  action markExecuting(e: Store::EffectId): bool = all {
    e.in(toMark),
    toMark' = toMark.exclude(Set(e)),
    toPerform' = toPerform.union(Set(e)),
    awaiting' = awaiting,
    epoch' = epoch, inflight' = inflight, replies' = replies, applied' = applied,
    commit(dispatch_agendaStore(Store::beginWrite({ e: e }))),
  }

  // 写入请求发往 GitHub，带上本次运行。
  action performWrite(e: Store::EffectId): bool = all {
    e.in(toPerform),
    toPerform' = toPerform.exclude(Set(e)),
    awaiting' = awaiting.union(Set(e)),
    inflight' = inflight.union(Set((e, epoch))),
    toMark' = toMark,
    epoch' = epoch, replies' = replies, applied' = applied,
    commit(NoCall),
  }

  // REQ-91：调用返回后，由新的 GitHub 读取决定结局。
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

  // REQ-91：一直没有返回的调用结局未知，除非新的读取已经显示这次写入。
  action giveUpWaiting(e: Store::EffectId): bool = all {
    e.in(awaiting),
    not((e, epoch).in(replies)),
    awaiting' = awaiting.exclude(Set(e)),
    toMark' = toMark, toPerform' = toPerform,
    epoch' = epoch, inflight' = inflight, replies' = replies, applied' = applied,
    commit(dispatch_agendaStore(Store::settleWrite({
      e: e, o: if (shown(e)) Store::Outcome_Confirmed else Store::Outcome_Uncertain }))),
  }

  // ---------- GitHub：每个在途请求处理一次；写入可能生效也可能不生效，回复可能丢失 ----------
  action githubHandle(e: Store::EffectId, sender: int, takesEffect: bool, answered: bool): bool = all {
    (e, sender).in(inflight),
    inflight' = inflight.exclude(Set((e, sender))),
    applied' = if (takesEffect) applied.set(e, applied.get(e) + 1) else applied,
    replies' = if (answered) replies.union(Set((e, sender))) else replies,
    toMark' = toMark, toPerform' = toPerform, awaiting' = awaiting, epoch' = epoch,
    commit(NoCall),
  }

  // ---------- 崩溃环境：协调者进程退出并重启 ----------
  // 执行器的线消失；议程状态、在途请求、回复与 GitHub 的记录保留。
  action crash = all {
    epoch' = epoch + 1,
    toMark' = Set(), toPerform' = Set(), awaiting' = Set(),
    inflight' = inflight, replies' = replies, applied' = applied,
    commit(NoCall),
  }

  // REQ-91：接管时按 GitHub 对账被打断的执行中写入，而不是再执行一遍。
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

  // ---------- 性质：写在可观察的线上 ----------
  // REQ-91：跨崩溃、接管与未知结局，任何写入都不会在 GitHub 上生效两次。
  val atMostOnce = EFFECTS.forall(e => applied.get(e) <= 1)
  // REQ-91：记为已确认的写入，GitHub 上看得到。
  val confirmedIsShown = agenda.outcomes.keys().forall(e =>
    agenda.outcomes.get(e) == Store::Outcome_Confirmed implies shown(e))
  // REQ-91：记为失败的写入，GitHub 上看不到。
  val failedIsNotShown = agenda.outcomes.keys().forall(e =>
    agenda.outcomes.get(e) == Store::Outcome_Failed implies not(shown(e)))
  val safety = atMostOnce and confirmedIsShown and failedIsNotShown

  // ---------- 覆盖目标 ----------
  val witnessConfirmed = agenda.outcomes.keys().exists(e => agenda.outcomes.get(e) == Store::Outcome_Confirmed)
  val witnessFailed = agenda.outcomes.keys().exists(e => agenda.outcomes.get(e) == Store::Outcome_Failed)
  // REQ-91：GitHub 已应用的写入，其所在运行在记下结局前崩溃；它仍等待接管。
  val witnessCrashAfterApply = agenda.executing.exists(e => shown(e) and not(e.in(awaiting)))
  pure val maxSteps_witnessCrashAfterApply = 30
  // REQ-91：结算为未知的写入之后在 GitHub 上生效，且没有任何步骤重发它。
  val witnessLateApplyAfterUncertain = agenda.outcomes.keys().exists(e =>
    agenda.outcomes.get(e) == Store::Outcome_Uncertain and shown(e))
  pure val maxSteps_witnessLateApplyAfterUncertain = 30
  // REQ-91：接管按 GitHub 的记录结算了一次写入，而它发给已崩溃运行的回复始终没被取走。
  val witnessReconciledAfterCrash = agenda.outcomes.keys().exists(e =>
    agenda.outcomes.get(e) == Store::Outcome_Confirmed and replies.exists(r => r._1 == e))
  pure val maxSteps_witnessReconciledAfterCrash = 40
}
