// 由 ssot gen 从 contract/*.vdmsl 生成；只读，不要手改。
module Vdm {
  type Opt[a] = | Nil | Some(a)
}
module dispatch_agendaStore {
  type EffectId = str
  type Outcome = | Outcome_Confirmed | Outcome_Failed | Outcome_Uncertain
  type Effects = { executing: Set[EffectId], outcomes: EffectId -> Outcome }
  pure val initial: Effects = { executing: Set(), outcomes: Map() }
  type Call =
    | beginWrite({ e: EffectId })
    | settleWrite({ e: EffectId, o: Outcome })
}
module dispatch_coordinator_bridge {
  type SeatId = str
  type TicketId = str
  type ContractId = str
  type Cause = | Cause_ContractOrExternal | Cause_InfraFault
  type ResolutionKind = | ResolutionKind_Normative | ResolutionKind_Operational
  type GateReply = | GateReply_Accepted | GateReply_Rejected
  type BridgeFacts = { contractOf: TicketId -> ContractId, approvedContract: TicketId -> ContractId, handedOffSeats: Set[SeatId], openEscalations: Set[TicketId], unimplemented: Set[TicketId] }
  pure val initial: BridgeFacts = { contractOf: Map(), approvedContract: Map(), handedOffSeats: Set(), openEscalations: Set(), unimplemented: Set() }
  type Call =
    | registerTicket({ t: TicketId, c: ContractId })
    | acceptWorkHandoff({ s: SeatId, t: TicketId })
    | recordJudgeApproval({ s: SeatId, t: TicketId, c: ContractId, result: GateReply })
    | submitEscalation({ s: SeatId, t: TicketId, cause: Cause, result: GateReply })
    | raiseEffectEscalation({ t: TicketId })
    | resolveTicket({ t: TicketId, kind: ResolutionKind, nextContract: ContractId })
    | authorizeMerge({ t: TicketId, result: GateReply })
    | declareUnimplemented({ t: TicketId, cause: Cause, alternativesExhausted: bool, result: GateReply })
}
module contract {
  import dispatch_agendaStore as dispatch_agendaStore
  import dispatch_coordinator_bridge as dispatch_coordinator_bridge
  type Call =
    | NoCall
    | dispatch_agendaStore(dispatch_agendaStore::Call)
    | dispatch_coordinator_bridge(dispatch_coordinator_bridge::Call)
}
