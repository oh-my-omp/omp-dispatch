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
module contract {
  import dispatch_agendaStore as dispatch_agendaStore
  type Call =
    | NoCall
    | dispatch_agendaStore(dispatch_agendaStore::Call)
}
