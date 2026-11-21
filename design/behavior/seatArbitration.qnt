// 担心：席位在交接或可受理上报尚未被 Seat Bridge 接纳前退出，或借 CI/上游代码等底层故障直接上报投降（REQ-120、REQ-122）；
// 兜底代理做运维重试时误伤既有评审印记，或规范契约变更后仍凭旧契约上的评审印记放行合并（REQ-121、REQ-123）；
// 或者兜底代理在底层工程故障或尚未穷尽替代方案时终判工单不可实现（REQ-122）。
// 盒子：工作流控制器与停机拦截钩子（下面的各步）、兜底仲裁（fallbackResolve / fallbackDeclareUnimplemented）、
// 瞬时外部故障与并发规范变更环境，以及契约盒子 dispatch_coordinator_bridge。
// 工单交付是一串顺接的步骤（conveneTicket → launchWork → workHandoff → launchJudge → judgeApprove → attemptMerge），
// 每一步从输入线取值、调用 Seat Bridge 端口、把凭据放到下一步的输入线上；席位仅在记入 handedOffSeats 后才能经停机钩子退出。
module seatArbitration {
  import contract.* from "../.gen/contract"
  import Vdm.* from "../.gen/contract"
  import dispatch_coordinator_bridge as Bridge from "../.gen/contract"

  pure val TICKETS = Set("t1", "t2")
  pure val SEATS = Set("s1", "s2", "s3", "s4", "s5", "s6")

  var bridge: Bridge::BridgeFacts
  // 控制器各步之间的传递线。
  var readyToWork: Set[Bridge::TicketId]
  var activeWork: Set[(Bridge::SeatId, Bridge::TicketId)]
  var readyToJudge: Set[Bridge::TicketId]
  var activeJudge: Set[(Bridge::SeatId, Bridge::TicketId, Bridge::ContractId)]
  var readyToMerge: Set[Bridge::TicketId]
  var opRetryPending: Set[Bridge::TicketId]
  // 停机钩子与流转门禁向仍在运行的席位发回的续跑提醒线，以及经停机钩子退出的席位集合。
  var stopNudges: Set[Bridge::SeatId]
  var exitedSeats: Set[Bridge::SeatId]
  // 通过合并门禁的工单及其合并时所锚定的规范契约。
  var merged: Set[(Bridge::TicketId, Bridge::ContractId)]
  // 每张工单已完成的独立验证尝试次数（度量）。
  var attempts: Bridge::TicketId -> int
  var lastCall: Call

  def isMerged(t: Bridge::TicketId): bool = merged.exists(p => p._1 == t)
  def seatUsed(s: Bridge::SeatId): bool =
    s.in(bridge.handedOffSeats) or
    s.in(exitedSeats) or
    activeWork.exists(p => p._1 == s) or
    activeJudge.exists(p => p._1 == s)

  // ---------- 契约盒子的反馈线按 VDM post 前进 ----------
  pure def removeKey(m: Bridge::TicketId -> Bridge::ContractId, k: Bridge::TicketId): Bridge::TicketId -> Bridge::ContractId =
    m.keys().exclude(Set(k)).mapBy(x => m.get(x))

  pure def bridgeAfter(s: Bridge::BridgeFacts, call: Call): Bridge::BridgeFacts = match call {
    | dispatch_coordinator_bridge(op) => match op {
        | registerTicket(a) => { ...s, contractOf: s.contractOf.put(a.t, a.c) }
        | acceptWorkHandoff(a) => { ...s, handedOffSeats: s.handedOffSeats.union(Set(a.s)) }
        | recordJudgeApproval(a) =>
            if (a.result == Bridge::GateReply_Accepted)
              { ...s, approvedContract: s.approvedContract.put(a.t, a.c), handedOffSeats: s.handedOffSeats.union(Set(a.s)) }
            else s
        | submitEscalation(a) =>
            if (a.result == Bridge::GateReply_Accepted)
              { ...s, handedOffSeats: s.handedOffSeats.union(Set(a.s)), openEscalations: s.openEscalations.union(Set(a.t)) }
            else s
        | raiseEffectEscalation(a) => { ...s, openEscalations: s.openEscalations.union(Set(a.t)) }
        | resolveTicket(a) =>
            if (a.kind == Bridge::ResolutionKind_Operational)
              { ...s, openEscalations: s.openEscalations.exclude(Set(a.t)) }
            else
              { ...s,
                contractOf: s.contractOf.put(a.t, a.nextContract),
                approvedContract: removeKey(s.approvedContract, a.t),
                openEscalations: s.openEscalations.exclude(Set(a.t)) }
        | authorizeMerge(_) => s
        | declareUnimplemented(a) =>
            if (a.result == Bridge::GateReply_Accepted)
              { ...s,
                approvedContract: removeKey(s.approvedContract, a.t),
                openEscalations: s.openEscalations.exclude(Set(a.t)),
                unimplemented: s.unimplemented.union(Set(a.t)) }
            else s
      }
    | _ => s
  }

  action commit(call: Call): bool = all {
    lastCall' = call,
    bridge' = bridgeAfter(bridge, call),
  }

  action init = all {
    bridge' = Bridge::initial,
    readyToWork' = Set(),
    activeWork' = Set(),
    readyToJudge' = Set(),
    activeJudge' = Set(),
    readyToMerge' = Set(),
    opRetryPending' = Set(),
    stopNudges' = Set(),
    exitedSeats' = Set(),
    merged' = Set(),
    attempts' = TICKETS.mapBy(_ => 0),
    lastCall' = NoCall,
  }

  // ---------- 自动建图与工作席位 ----------
  // REQ-121：自动为工单登记初始规范契约并放入待执行线。
  action conveneTicket(t: Bridge::TicketId): bool = all {
    not(t.in(bridge.contractOf.keys())),
    readyToWork' = readyToWork.union(Set(t)),
    activeWork' = activeWork, readyToJudge' = readyToJudge, activeJudge' = activeJudge,
    readyToMerge' = readyToMerge, opRetryPending' = opRetryPending,
    stopNudges' = stopNudges, exitedSeats' = exitedSeats, merged' = merged, attempts' = attempts,
    commit(dispatch_coordinator_bridge(Bridge::registerTicket({ t: t, c: "c1" }))),
  }

  action launchWork(s: Bridge::SeatId, t: Bridge::TicketId): bool = all {
    t.in(readyToWork),
    not(seatUsed(s)),
    not(t.in(bridge.openEscalations)),
    not(t.in(bridge.unimplemented)),
    not(isMerged(t)),
    readyToWork' = readyToWork.exclude(Set(t)),
    activeWork' = activeWork.union(Set((s, t))),
    readyToJudge' = readyToJudge, activeJudge' = activeJudge,
    readyToMerge' = readyToMerge, opRetryPending' = opRetryPending,
    stopNudges' = stopNudges, exitedSeats' = exitedSeats, merged' = merged, attempts' = attempts,
    commit(NoCall),
  }

  // REQ-120：工作席位提交经验证的交接并记为一次独立尝试。
  action workHandoff(s: Bridge::SeatId, t: Bridge::TicketId): bool = all {
    (s, t).in(activeWork),
    not(s.in(bridge.handedOffSeats)),
    not(t.in(bridge.unimplemented)),
    readyToJudge' = readyToJudge.union(Set(t)),
    attempts' = attempts.set(t, attempts.get(t) + 1),
    readyToWork' = readyToWork, activeWork' = activeWork, activeJudge' = activeJudge,
    readyToMerge' = readyToMerge, opRetryPending' = opRetryPending,
    stopNudges' = stopNudges, exitedSeats' = exitedSeats, merged' = merged,
    commit(dispatch_coordinator_bridge(Bridge::acceptWorkHandoff({ s: s, t: t }))),
  }

  // REQ-120, REQ-122：工作席位上报时，底层工程故障被桥拒收并发回续跑提醒；外部或契约问题被受理并唤醒兜底。
  action workSubmitEscalation(s: Bridge::SeatId, t: Bridge::TicketId, cause: Bridge::Cause): bool = all {
    (s, t).in(activeWork),
    not(s.in(bridge.handedOffSeats)),
    not(t.in(bridge.unimplemented)),
    val res = if (cause == Bridge::Cause_ContractOrExternal) Bridge::GateReply_Accepted else Bridge::GateReply_Rejected
    all {
      stopNudges' = if (res == Bridge::GateReply_Rejected) stopNudges.union(Set(s)) else stopNudges,
      readyToWork' = readyToWork, activeWork' = activeWork, readyToJudge' = readyToJudge,
      activeJudge' = activeJudge, readyToMerge' = readyToMerge, opRetryPending' = opRetryPending,
      exitedSeats' = exitedSeats, merged' = merged, attempts' = attempts,
      commit(dispatch_coordinator_bridge(Bridge::submitEscalation({ s: s, t: t, cause: cause, result: res }))),
    }
  }

  // REQ-120：原生停机钩子拦截未完成交接的工作席位退出，发回续跑提醒而不放行退出。
  action stopHookBlockWork(s: Bridge::SeatId, t: Bridge::TicketId): bool = all {
    (s, t).in(activeWork),
    not(s.in(bridge.handedOffSeats)),
    stopNudges' = stopNudges.union(Set(s)),
    readyToWork' = readyToWork, activeWork' = activeWork, readyToJudge' = readyToJudge,
    activeJudge' = activeJudge, readyToMerge' = readyToMerge, opRetryPending' = opRetryPending,
    exitedSeats' = exitedSeats, merged' = merged, attempts' = attempts,
    commit(NoCall),
  }

  // REQ-120：仅当 Seat Bridge 已接纳该席位的交接或上报，停机钩子才放行退出。
  action seatExitWork(s: Bridge::SeatId, t: Bridge::TicketId): bool = all {
    (s, t).in(activeWork),
    s.in(bridge.handedOffSeats),
    activeWork' = activeWork.exclude(Set((s, t))),
    exitedSeats' = exitedSeats.union(Set(s)),
    readyToWork' = readyToWork, readyToJudge' = readyToJudge, activeJudge' = activeJudge,
    readyToMerge' = readyToMerge, opRetryPending' = opRetryPending,
    stopNudges' = stopNudges, merged' = merged, attempts' = attempts,
    commit(NoCall),
  }

  // ---------- 评审席位与过期契约竞争 ----------
  action launchJudge(s: Bridge::SeatId, t: Bridge::TicketId): bool = all {
    t.in(readyToJudge),
    not(seatUsed(s)),
    t.in(bridge.contractOf.keys()),
    not(t.in(bridge.unimplemented)),
    not(isMerged(t)),
    val c = bridge.contractOf.get(t)
    all {
      readyToJudge' = readyToJudge.exclude(Set(t)),
      activeJudge' = activeJudge.union(Set((s, t, c))),
      readyToWork' = readyToWork, activeWork' = activeWork,
      readyToMerge' = readyToMerge, opRetryPending' = opRetryPending,
      stopNudges' = stopNudges, exitedSeats' = exitedSeats, merged' = merged, attempts' = attempts,
      commit(NoCall),
    }
  }

  // REQ-121, REQ-123：在途评审提交通过结论；若期间发生规范契约变更，旧契约印记被拒绝且不进入合并线。
  action judgeApprove(s: Bridge::SeatId, t: Bridge::TicketId, c: Bridge::ContractId): bool = all {
    (s, t, c).in(activeJudge),
    not(s.in(bridge.handedOffSeats)),
    not(t.in(bridge.unimplemented)),
    val fresh = bridge.contractOf.get(t) == c
    val res = if (fresh) Bridge::GateReply_Accepted else Bridge::GateReply_Rejected
    all {
      readyToMerge' = if (fresh) readyToMerge.union(Set(t)) else readyToMerge,
      activeJudge' = if (fresh) activeJudge else activeJudge.exclude(Set((s, t, c))),
      readyToWork' = readyToWork, activeWork' = activeWork, readyToJudge' = readyToJudge,
      opRetryPending' = opRetryPending, stopNudges' = stopNudges, exitedSeats' = exitedSeats,
      merged' = merged, attempts' = attempts,
      commit(dispatch_coordinator_bridge(Bridge::recordJudgeApproval({ s: s, t: t, c: c, result: res }))),
    }
  }

  action seatExitJudge(s: Bridge::SeatId, t: Bridge::TicketId, c: Bridge::ContractId): bool = all {
    (s, t, c).in(activeJudge),
    s.in(bridge.handedOffSeats),
    activeJudge' = activeJudge.exclude(Set((s, t, c))),
    exitedSeats' = exitedSeats.union(Set(s)),
    readyToWork' = readyToWork, activeWork' = activeWork, readyToJudge' = readyToJudge,
    readyToMerge' = readyToMerge, opRetryPending' = opRetryPending,
    stopNudges' = stopNudges, merged' = merged, attempts' = attempts,
    commit(NoCall),
  }

  // ---------- 瞬时外部写入失败、规范上报与合并门禁 ----------
  // REQ-121：合并阶段遭遇外部写入失败，或评审途中来源规范触发上报，进入待兜底裁决集合。
  action escalateDuringMergeOrJudge(t: Bridge::TicketId): bool = all {
    t.in(readyToMerge) or activeJudge.exists(p => p._2 == t),
    not(t.in(bridge.openEscalations)),
    not(t.in(bridge.unimplemented)),
    not(isMerged(t)),
    opRetryPending' = if (t.in(readyToMerge)) opRetryPending.union(Set(t)) else opRetryPending,
    readyToWork' = readyToWork, activeWork' = activeWork, readyToJudge' = readyToJudge,
    activeJudge' = activeJudge, readyToMerge' = readyToMerge,
    stopNudges' = stopNudges, exitedSeats' = exitedSeats, merged' = merged, attempts' = attempts,
    commit(dispatch_coordinator_bridge(Bridge::raiseEffectEscalation({ t: t }))),
  }

  // REQ-121：合并门禁仅放行持有当前规范契约印记且无未决上报的工单。
  action attemptMerge(t: Bridge::TicketId): bool = all {
    t.in(readyToMerge),
    t.in(bridge.contractOf.keys()),
    not(isMerged(t)),
    val ok =
      t.in(bridge.approvedContract.keys()) and
      bridge.approvedContract.get(t) == bridge.contractOf.get(t) and
      not(t.in(bridge.openEscalations)) and
      not(t.in(bridge.unimplemented))
    val res = if (ok) Bridge::GateReply_Accepted else Bridge::GateReply_Rejected
    all {
      readyToMerge' = if (ok or not(t.in(opRetryPending))) readyToMerge.exclude(Set(t)) else readyToMerge,
      merged' = if (ok) merged.union(Set((t, bridge.contractOf.get(t)))) else merged,
      readyToWork' = readyToWork, activeWork' = activeWork, readyToJudge' = readyToJudge,
      activeJudge' = activeJudge, opRetryPending' = opRetryPending,
      stopNudges' = stopNudges, exitedSeats' = exitedSeats, attempts' = attempts,
      commit(dispatch_coordinator_bridge(Bridge::authorizeMerge({ t: t, result: res }))),
    }
  }

  // ---------- 兜底代理仲裁 ----------
  // REQ-121, REQ-123：运维裁决保留评审印记并直接恢复合并；规范裁决更新契约、清除旧印记并重新安排工作席位。
  action fallbackResolve(t: Bridge::TicketId, kind: Bridge::ResolutionKind): bool = all {
    t.in(bridge.openEscalations),
    not(t.in(bridge.unimplemented)),
    not(isMerged(t)),
    val cur = bridge.contractOf.get(t)
    val nextC = if (kind == Bridge::ResolutionKind_Operational) cur else if (cur == "c1") "c2" else "c1"
    val op = kind == Bridge::ResolutionKind_Operational
    all {
      opRetryPending' = opRetryPending.exclude(Set(t)),
      readyToMerge' = if (op and t.in(opRetryPending)) readyToMerge.union(Set(t)) else readyToMerge,
      readyToWork' = if (op and t.in(opRetryPending)) readyToWork else readyToWork.union(Set(t)),
      activeWork' = activeWork, readyToJudge' = readyToJudge, activeJudge' = activeJudge,
      stopNudges' = stopNudges, exitedSeats' = exitedSeats, merged' = merged, attempts' = attempts,
      commit(dispatch_coordinator_bridge(Bridge::resolveTicket({ t: t, kind: kind, nextContract: nextC }))),
    }
  }

  // REQ-122, REQ-123：兜底代理请求不可实现终判；底层工程故障或独立尝试不足 2 次时一律拒绝。
  action fallbackDeclareUnimplemented(t: Bridge::TicketId, cause: Bridge::Cause): bool = all {
    t.in(bridge.openEscalations),
    not(t.in(bridge.unimplemented)),
    not(isMerged(t)),
    val exhausted = attempts.get(t) >= 2
    val ok = cause == Bridge::Cause_ContractOrExternal and exhausted
    val res = if (ok) Bridge::GateReply_Accepted else Bridge::GateReply_Rejected
    all {
      opRetryPending' = if (ok) opRetryPending.exclude(Set(t)) else opRetryPending,
      readyToMerge' = if (ok) readyToMerge.exclude(Set(t)) else readyToMerge,
      readyToWork' = if (ok) readyToWork.exclude(Set(t)) else readyToWork,
      readyToJudge' = if (ok) readyToJudge.exclude(Set(t)) else readyToJudge,
      activeWork' = activeWork, activeJudge' = activeJudge,
      stopNudges' = stopNudges, exitedSeats' = exitedSeats, merged' = merged, attempts' = attempts,
      commit(dispatch_coordinator_bridge(Bridge::declareUnimplemented({
        t: t, cause: cause, alternativesExhausted: exhausted, result: res }))),
    }
  }

  action step = {
    nondet t = TICKETS.oneOf()
    nondet s = SEATS.oneOf()
    nondet w = activeWork.union(Set(("", ""))).oneOf()
    nondet j = activeJudge.union(Set(("", "", ""))).oneOf()
    nondet cause = Set(Bridge::Cause_InfraFault, Bridge::Cause_ContractOrExternal).oneOf()
    nondet kind = Set(Bridge::ResolutionKind_Operational, Bridge::ResolutionKind_Normative).oneOf()
    any {
      conveneTicket(t),
      launchWork(s, t),
      workHandoff(w._1, w._2),
      workSubmitEscalation(w._1, w._2, cause),
      stopHookBlockWork(w._1, w._2),
      seatExitWork(w._1, w._2),
      launchJudge(s, t),
      judgeApprove(j._1, j._2, j._3),
      seatExitJudge(j._1, j._2, j._3),
      escalateDuringMergeOrJudge(t),
      attemptMerge(t),
      fallbackResolve(t, kind),
      fallbackDeclareUnimplemented(t, cause),
    }
  }

  // ---------- 性质：写在可观察的线上 ----------
  // REQ-120：任何已退出的席位都先获得了 Seat Bridge 接纳的交接或上报。
  val noUnverifiedSeatExit = exitedSeats.forall(s => s.in(bridge.handedOffSeats))
  // REQ-121, REQ-123：所有已放行合并的工单都持有当前规范契约上的评审印记，且未终判不可实现。
  val mergedMatchesCurrentApproval = merged.forall(p =>
    p._1.in(bridge.approvedContract.keys()) and
    bridge.approvedContract.get(p._1) == p._2 and
    bridge.contractOf.get(p._1) == p._2 and
    not(p._1.in(bridge.unimplemented)))
  // REQ-122：任何终判不可实现的工单都至少穷尽了 2 次独立验证尝试，且既未合并也不留悬空上报。
  val unimplementedRequiresExhaustion = bridge.unimplemented.forall(t =>
    attempts.get(t) >= 2 and not(isMerged(t)) and not(t.in(bridge.openEscalations)))
  val safety = noUnverifiedSeatExit and mergedMatchesCurrentApproval and unimplementedRequiresExhaustion

  // ---------- 覆盖目标 ----------
  // REQ-120：未交接的席位被停机钩子拦截后，最终完成交接并安全退出。
  val witnessBlockedStopThenExit = exitedSeats.exists(s => s.in(stopNudges))
  pure val maxSteps_witnessBlockedStopThenExit = 30
  // REQ-121：合并阶段遭遇运维上报后，经运维裁决解除上报且仍保留原规范契约上的评审印记并重新回到合并线。
  val witnessOperationalRetryPreservesApproval =
    readyToMerge.exists(t => t.in(bridge.approvedContract.keys()) and not(t.in(bridge.openEscalations))) and
    match lastCall {
      | dispatch_coordinator_bridge(op) => match op {
          | resolveTicket(a) => a.kind == Bridge::ResolutionKind_Operational
          | _ => false
        }
      | _ => false
    }
  pure val maxSteps_witnessOperationalRetryPreservesApproval = 40
  // REQ-121, REQ-123：评审途中发生规范契约变更，旧契约上的在途评审被桥拒绝。
  val witnessStaleJudgeRejected = match lastCall {
    | dispatch_coordinator_bridge(op) => match op {
        | recordJudgeApproval(a) => a.result == Bridge::GateReply_Rejected
        | _ => false
      }
    | _ => false
  }
  pure val maxSteps_witnessStaleJudgeRejected = 45
  // REQ-121：规范契约更新后，工单在新契约 c2 下重新通过评审并放行合并。
  val witnessMergedOnRevisedContract = merged.exists(p => p._2 == "c2")
  pure val maxSteps_witnessMergedOnRevisedContract = 50
  // REQ-122：兜底代理仅在穷尽至少 2 次独立验证尝试后成功终判工单不可实现。
  val witnessUnimplementedAfterExhaustion = bridge.unimplemented.size() > 0
  pure val maxSteps_witnessUnimplementedAfterExhaustion = 50
  // REQ-122：底层工程故障触发的上报或不可实现请求被桥拒绝。
  val witnessInfraRejected = match lastCall {
    | dispatch_coordinator_bridge(op) => match op {
        | submitEscalation(a) => a.cause == Bridge::Cause_InfraFault and a.result == Bridge::GateReply_Rejected
        | declareUnimplemented(a) => a.cause == Bridge::Cause_InfraFault and a.result == Bridge::GateReply_Rejected
        | _ => false
      }
    | _ => false
  }
  pure val maxSteps_witnessInfraRejected = 30
}
