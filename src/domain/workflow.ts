import type {ChecksSnapshot,ParseError,PrSnapshot,Result,Role,Verdict} from './model.ts';

/** The built-in transition target: hand the ticket or closure to Main as `Escalated`. */
export const ESCALATE='escalate';
/** The built-in holding state an escalation enters; no workflow state may take its name. */
export const ESCALATED='Escalated';
/** The built-in holding state a work seat's question enters under PM integration; no workflow state may take its name. */
export const ASKING='Asking';

/** A predicate over source-confirmed facts and the machine's own visit counts. */
export type Condition=
  |{kind:'checks';is:ChecksSnapshot['kind']}
  |{kind:'mergeable';is:PrSnapshot['mergeable']}
  |{kind:'visits';state:string;atLeast:number}
  |{kind:'all';of:Condition[]}
  |{kind:'any';of:Condition[]}
  |{kind:'not';of:Condition};
export type Branch={when:Condition;to:string};
/** Where one outcome leads: the first branch whose condition holds, else `otherwise`. */
export type Route={branches:Branch[];otherwise:string};
/** An entry condition: the state is entered only while `when` holds; otherwise the ticket goes to `otherwise` instead. */
export type Guard={when:Condition;otherwise:string};
export type Judge={role:Role;agent:string;brief:string};
/** Where source events lead while the ticket holds an open PR in this state. Unconfigured events escalate. */
export type Observe={checksFailed:string;conflict:string;behind:string;drift:string};
export type TicketAction=
  |{kind:'publishPr'}
  |{kind:'merge';requires:string[];observe:Observe}
  |{kind:'closeIssue';requires:string[]}
  |{kind:'rerunChecks'};
export type TicketState=
  |{kind:'work';role:Role;agent:string;brief:string;guard:Guard|null;on:{submitted:Route;escalated:Route}}
  |{kind:'judge';subject:'pullRequest';judges:Judge[];guard:Guard|null;observe:Observe;on:{passed:Route;rejected:Route;escalated:Route}}
  |{kind:'judge';subject:'mergeCommit';judges:Judge[];guard:Guard|null;on:{passed:Route;rejected:Route;escalated:Route}}
  |{kind:'action';action:TicketAction;guard:Guard|null;on:{done:Route}}
  |{kind:'decision';guard:Guard|null;observe:Observe;branches:Branch[];otherwise:string|null}
  |{kind:'final';guard:Guard|null};
export type ParentState=
  |{kind:'judge';judges:Judge[];guard:Guard|null;on:{passed:Route;rejected:Route;escalated:Route}}
  |{kind:'action';action:{kind:'closeParent';requires:string[]};guard:Guard|null;on:{done:Route}}
  |{kind:'decision';guard:Guard|null;branches:Branch[];otherwise:string|null}
  |{kind:'final';guard:Guard|null};
/** The ticket and parent-closure state machines; frozen into each agenda at convene. */
export type Workflow={
  ticket:{initial:string;adopted:{pullRequest:string;mergeCommit:string};states:Record<string,TicketState>};
  parent:{initial:string;states:Record<string,ParentState>};
};

/* ------------------------------------------------------------ parsing */

class Invalid extends Error {constructor(readonly path:string,reason:string){super(reason);}}
type Raw=Record<string,unknown>;
const NAME=/^[A-Za-z][A-Za-z0-9_-]*$/;
const CHECKS=['passing','failing','pending','unknown'] as const satisfies readonly ChecksSnapshot['kind'][];
const MERGEABLE=['yes','no','behind','draft','unknown'] as const satisfies readonly PrSnapshot['mergeable'][];

function record(value:unknown,path:string,keys:readonly string[]):Raw {
  if(typeof value!=='object'||value===null||Array.isArray(value))throw new Invalid(path,'must be a mapping');
  for(const key of Object.keys(value))if(!keys.includes(key))throw new Invalid(`${path}.${key}`,`unknown field; expected one of ${keys.join(', ')}`);
  return value as Raw;
}
function text(value:unknown,path:string):string {
  if(typeof value!=='string'||!value.trim())throw new Invalid(path,'must be a nonempty string');
  return value;
}
function name(value:unknown,path:string):string {
  const result=text(value,path);
  if(!NAME.test(result))throw new Invalid(path,'must start with a letter and use only letters, digits, _ or -');
  return result;
}
function list(value:unknown,path:string):unknown[] {
  if(!Array.isArray(value))throw new Invalid(path,'must be a list');
  return value;
}
function oneOf<const T extends readonly string[]>(value:unknown,path:string,values:T):T[number] {
  if(typeof value!=='string'||!values.includes(value))throw new Invalid(path,`must be one of ${values.join(', ')} (quote yes/no in YAML)`);
  return value;
}
function condition(value:unknown,path:string):Condition {
  const raw=record(value,path,['checks','mergeable','visits','all','any','not']);
  const keys=Object.keys(raw);
  if(keys.length!==1)throw new Invalid(path,'a condition has exactly one of checks, mergeable, visits, all, any, not');
  const key=keys[0]!;
  switch(key){
    case 'checks':return {kind:'checks',is:oneOf(raw.checks,`${path}.checks`,CHECKS)};
    case 'mergeable':return {kind:'mergeable',is:oneOf(raw.mergeable,`${path}.mergeable`,MERGEABLE)};
    case 'visits':{
      const visits=record(raw.visits,`${path}.visits`,['state','atLeast']);
      const atLeast=visits.atLeast;
      if(typeof atLeast!=='number'||!Number.isSafeInteger(atLeast)||atLeast<1)throw new Invalid(`${path}.visits.atLeast`,'must be a positive whole number');
      return {kind:'visits',state:name(visits.state,`${path}.visits.state`),atLeast};
    }
    case 'all':case 'any':{
      const of=list(raw[key],`${path}.${key}`).map((item,index)=>condition(item,`${path}.${key}[${index}]`));
      if(!of.length)throw new Invalid(`${path}.${key}`,'must list at least one condition');
      return {kind:key,of};
    }
    default:return {kind:'not',of:condition(raw.not,`${path}.not`)};
  }
}
function route(value:unknown,path:string):Route {
  if(typeof value==='string')return {branches:[],otherwise:name(value,path)};
  const items=list(value,path);
  if(!items.length)throw new Invalid(path,'must name a target or list branches');
  const branches:Branch[]=[];
  for(const [index,item] of items.entries()){
    const raw=record(item,`${path}[${index}]`,['when','to']);
    const to=name(raw.to,`${path}[${index}].to`);
    const last=index===items.length-1;
    if(raw.when===undefined){
      if(!last)throw new Invalid(`${path}[${index}]`,'only the last branch may omit when');
      return {branches,otherwise:to};
    }
    if(last)throw new Invalid(path,'the last branch must omit when and name the fallback target');
    branches.push({when:condition(raw.when,`${path}[${index}].when`),to});
  }
  throw new Invalid(path,'the last branch must omit when and name the fallback target');
}
/** A decision's branches; an unconditional last branch is its fallback, and without one the decision waits. */
function decisionBranches(value:unknown,path:string):{branches:Branch[];otherwise:string|null} {
  const items=list(value,path);
  if(!items.length)throw new Invalid(path,'must list at least one branch');
  const branches:Branch[]=[];
  for(const [index,item] of items.entries()){
    const raw=record(item,`${path}[${index}]`,['when','to']);
    const to=name(raw.to,`${path}[${index}].to`);
    if(raw.when!==undefined){branches.push({when:condition(raw.when,`${path}[${index}].when`),to});continue;}
    if(index!==items.length-1)throw new Invalid(`${path}[${index}]`,'only the last branch may omit when');
    return {branches,otherwise:to};
  }
  return {branches,otherwise:null};
}
function guard(raw:Raw,path:string):Guard|null {
  if(raw.when===undefined&&raw.otherwise===undefined)return null;
  if(raw.when===undefined||raw.otherwise===undefined)throw new Invalid(path,'when and otherwise must be given together');
  return {when:condition(raw.when,`${path}.when`),otherwise:name(raw.otherwise,`${path}.otherwise`)};
}
function judges(value:unknown,path:string):Judge[] {
  return list(value,path).map((item,index)=>{
    const raw=record(item,`${path}[${index}]`,['role','agent','brief']);
    return {role:name(raw.role,`${path}[${index}].role`),agent:text(raw.agent,`${path}[${index}].agent`),brief:text(raw.brief,`${path}[${index}].brief`)};
  });
}
function outcomes<const K extends readonly string[]>(value:unknown,path:string,keys:K):Record<K[number],Route> {
  const raw=record(value,path,keys);
  const result={} as Record<K[number],Route>;
  for(const key of keys as readonly K[number][]){
    if(raw[key]===undefined)throw new Invalid(`${path}.${key}`,'every outcome of this state kind needs a target');
    result[key]=route(raw[key],`${path}.${key}`);
  }
  return result;
}
function observe(value:unknown,path:string):Observe {
  const raw=value===undefined?{}:record(value,path,['checksFailed','conflict','behind','drift']);
  const target=(key:keyof Observe)=>raw[key]===undefined?ESCALATE:name(raw[key],`${path}.${key}`);
  return {checksFailed:target('checksFailed'),conflict:target('conflict'),behind:target('behind'),drift:target('drift')};
}
function requires(value:unknown,path:string):string[] {
  return value===undefined?[]:list(value,path).map((item,index)=>name(item,`${path}[${index}]`));
}
const GUARD=['when','otherwise'] as const;
function ticketState(value:unknown,path:string):TicketState {
  const kind=oneOf(record(value,path,['kind','when','otherwise','role','agent','brief','subject','judges','action','requires','observe','branches','on']).kind,`${path}.kind`,['work','judge','action','decision','final']);
  switch(kind){
    case 'work':{
      const raw=record(value,path,['kind',...GUARD,'role','agent','brief','on']);
      return {kind,role:name(raw.role,`${path}.role`),agent:text(raw.agent,`${path}.agent`),brief:text(raw.brief,`${path}.brief`),guard:guard(raw,path),on:outcomes(raw.on,`${path}.on`,['submitted','escalated'])};
    }
    case 'judge':{
      const subject=oneOf(record(value,path,['kind',...GUARD,'subject','judges','observe','on']).subject,`${path}.subject`,['pullRequest','mergeCommit']);
      const raw=record(value,path,subject==='pullRequest'?['kind',...GUARD,'subject','judges','observe','on']:['kind',...GUARD,'subject','judges','on']);
      const common={judges:judges(raw.judges,`${path}.judges`),guard:guard(raw,path),on:outcomes(raw.on,`${path}.on`,['passed','rejected','escalated'])};
      return subject==='pullRequest'?{kind,subject,...common,observe:observe(raw.observe,`${path}.observe`)}:{kind,subject,...common};
    }
    case 'action':{
      const action=oneOf(record(value,path,['kind',...GUARD,'action','requires','observe','on']).action,`${path}.action`,['publishPr','merge','closeIssue','rerunChecks']);
      const raw=record(value,path,action==='merge'?['kind',...GUARD,'action','requires','observe','on']:action==='closeIssue'?['kind',...GUARD,'action','requires','on']:['kind',...GUARD,'action','on']);
      const parsed:TicketAction=action==='merge'?{kind:action,requires:requires(raw.requires,`${path}.requires`),observe:observe(raw.observe,`${path}.observe`)}
        :action==='closeIssue'?{kind:action,requires:requires(raw.requires,`${path}.requires`)}:{kind:action};
      return {kind,action:parsed,guard:guard(raw,path),on:outcomes(raw.on,`${path}.on`,['done'])};
    }
    case 'decision':{
      const raw=record(value,path,['kind',...GUARD,'observe','branches']);
      return {kind,guard:guard(raw,path),observe:observe(raw.observe,`${path}.observe`),...decisionBranches(raw.branches,`${path}.branches`)};
    }
    case 'final':return {kind,guard:guard(record(value,path,['kind',...GUARD]),path)};
  }
}
function parentState(value:unknown,path:string):ParentState {
  const kind=oneOf(record(value,path,['kind','when','otherwise','judges','action','requires','branches','on']).kind,`${path}.kind`,['judge','action','decision','final']);
  switch(kind){
    case 'judge':{
      const raw=record(value,path,['kind',...GUARD,'judges','on']);
      return {kind,judges:judges(raw.judges,`${path}.judges`),guard:guard(raw,path),on:outcomes(raw.on,`${path}.on`,['passed','rejected','escalated'])};
    }
    case 'action':{
      const raw=record(value,path,['kind',...GUARD,'action','requires','on']);
      oneOf(raw.action,`${path}.action`,['closeParent']);
      return {kind,action:{kind:'closeParent',requires:requires(raw.requires,`${path}.requires`)},guard:guard(raw,path),on:outcomes(raw.on,`${path}.on`,['done'])};
    }
    case 'decision':{
      const raw=record(value,path,['kind',...GUARD,'branches']);
      return {kind,guard:guard(raw,path),...decisionBranches(raw.branches,`${path}.branches`)};
    }
    case 'final':return {kind,guard:guard(record(value,path,['kind',...GUARD]),path)};
  }
}
function states<S>(value:unknown,path:string,parse:(value:unknown,path:string)=>S):Record<string,S> {
  const raw=record(value,path,Object.keys(typeof value==='object'&&value!==null?value:{}));
  const result:Record<string,S>={};
  for(const [key,item] of Object.entries(raw)){
    name(key,`${path}.${key}`);
    if(key===ESCALATE||key===ESCALATED)throw new Invalid(`${path}.${key}`,`${key} is reserved for Main's escalation`);
    if(key===ASKING)throw new Invalid(`${path}.${key}`,`${key} is reserved for a worker question the intent guardians settle`);
    result[key]=parse(item,`${path}.${key}`);
  }
  if(!Object.keys(result).length)throw new Invalid(path,'must define at least one state');
  return result;
}

/* ------------------------------------------------------------ validation */

type AnyState=TicketState|ParentState;
function conditions(state:AnyState):Condition[] {
  const routes=[...('on' in state?Object.values(state.on):[])];
  return [...(state.guard?[state.guard.when]:[]),...routes.flatMap(item=>item.branches.map(branch=>branch.when)),...(state.kind==='decision'?state.branches.map(branch=>branch.when):[])];
}
function flatten(condition:Condition):Condition[] {
  switch(condition.kind){
    case 'all':case 'any':return [condition,...condition.of.flatMap(flatten)];
    case 'not':return [condition,...flatten(condition.of)];
    case 'checks':case 'mergeable':case 'visits':return [condition];
  }
}
function targets(state:AnyState):string[] {
  const routes='on' in state?Object.values(state.on):[];
  const observed='observe' in state?Object.values(state.observe):state.kind==='action'&&state.action.kind==='merge'?Object.values(state.action.observe):[];
  return [...routes.flatMap(item=>[...item.branches.map(branch=>branch.to),item.otherwise]),...(state.kind==='decision'?[...state.branches.map(branch=>branch.to),...(state.otherwise?[state.otherwise]:[])]:[]),...(state.guard?[state.guard.otherwise]:[]),...observed];
}
function validateMachine(machine:Record<string,AnyState>,entries:string[],path:string,parent:boolean):void {
  const exists=(target:string)=>target===ESCALATE||target in machine;
  for(const entry of entries)if(!(entry in machine))throw new Invalid(path,`entry state ${entry} is not defined`);
  for(const [key,state] of Object.entries(machine)){
    for(const target of targets(state))if(!exists(target))throw new Invalid(`${path}.states.${key}`,`target ${target} is not a state of this machine`);
    for(const item of conditions(state).flatMap(flatten)){
      if(item.kind==='visits'&&!(item.state in machine))throw new Invalid(`${path}.states.${key}`,`visits names unknown state ${item.state}`);
      if(parent&&(item.kind==='checks'||item.kind==='mergeable'))throw new Invalid(`${path}.states.${key}`,'the parent machine has no pull request; use visits, all, any or not');
    }
    // An entry guard's fallback chain must end in a state that is entered unconditionally or escalates.
    const seen=new Set<string>([key]);
    for(let next=state.guard?.otherwise;next&&next!==ESCALATE;next=machine[next]?.guard?.otherwise){
      if(seen.has(next))throw new Invalid(`${path}.states.${key}`,`entry guards form a cycle through ${next}`);
      seen.add(next);
    }
  }
  const reached=new Set<string>(),pending=[...entries];
  for(let next=pending.pop();next!==undefined;next=pending.pop()){
    if(reached.has(next)||next===ESCALATE)continue;
    reached.add(next);pending.push(...targets(machine[next]!));
  }
  for(const key of Object.keys(machine))if(!reached.has(key))throw new Invalid(`${path}.states.${key}`,'is unreachable from the entry states');
  if(!Object.values(machine).some(state=>state.kind==='final'))throw new Invalid(path,'needs at least one final state');
}
function validate(workflow:Workflow):void {
  const ticket=workflow.ticket.states,parent=workflow.parent.states;
  const initial=ticket[workflow.ticket.initial];
  if(initial&&(initial.kind!=='work'||initial.guard))throw new Invalid('ticket.initial','must be a work state without an entry guard; Main launches it');
  validateMachine(ticket,[workflow.ticket.initial,workflow.ticket.adopted.pullRequest,workflow.ticket.adopted.mergeCommit],'ticket',false);
  validateMachine(parent,[workflow.parent.initial],'parent',true);
  // Seat names key sessions, verdicts, notes and seat lifetimes: a judge name denotes one judge, a work name one session.
  const agents=new Map<Role,string>(),judgeRoles=new Set<Role>();
  for(const [key,state] of Object.entries(ticket))if(state.kind==='work'){
    const agent=agents.get(state.role);
    if(agent!==undefined&&agent!==state.agent)throw new Invalid(`ticket.states.${key}.agent`,`work role ${state.role} continues one session, so every state of it must use agent ${agent}`);
    agents.set(state.role,state.agent);
  }
  for(const [machine,map] of [['ticket',ticket],['parent',parent]] as const)for(const [key,state] of Object.entries(map)){
    if(state.kind!=='judge')continue;
    for(const judge of state.judges){
      if(agents.has(judge.role)||judgeRoles.has(judge.role))throw new Invalid(`${machine}.states.${key}.judges`,`role ${judge.role} is configured more than once`);
      judgeRoles.add(judge.role);
    }
  }
  const required=(path:string,names:string[],accepts:(state:AnyState|undefined)=>boolean,what:string)=>{
    for(const item of names)if(!accepts(path.startsWith('parent')?parent[item]:ticket[item]))throw new Invalid(path,`requires ${item}, which is not ${what}`);
  };
  for(const [key,state] of Object.entries(ticket))if(state.kind==='action'){
    if(state.action.kind==='merge')required(`ticket.states.${key}.requires`,state.action.requires,item=>item?.kind==='judge'&&'subject' in item&&item.subject==='pullRequest','a pullRequest judge state');
    if(state.action.kind==='closeIssue')required(`ticket.states.${key}.requires`,state.action.requires,item=>item?.kind==='judge'&&'subject' in item&&item.subject==='mergeCommit','a mergeCommit judge state');
  }
  for(const [key,state] of Object.entries(parent))if(state.kind==='action')required(`parent.states.${key}.requires`,state.action.requires,item=>item?.kind==='judge','a parent judge state');
}

/** Parse untrusted workflow data (a YAML file or a persisted agenda) into the exact state machines. */
export function parseWorkflow(value:unknown):Result<Workflow,ParseError> {
  try {
    const raw=record(value,'workflow',['ticket','parent']);
    const ticketRaw=record(raw.ticket,'ticket',['initial','adopted','states']);
    const adopted=record(ticketRaw.adopted,'ticket.adopted',['pullRequest','mergeCommit']);
    const parentRaw=record(raw.parent,'parent',['initial','states']);
    const workflow:Workflow={
      ticket:{initial:name(ticketRaw.initial,'ticket.initial'),adopted:{pullRequest:name(adopted.pullRequest,'ticket.adopted.pullRequest'),mergeCommit:name(adopted.mergeCommit,'ticket.adopted.mergeCommit')},states:states(ticketRaw.states,'ticket.states',ticketState)},
      parent:{initial:name(parentRaw.initial,'parent.initial'),states:states(parentRaw.states,'parent.states',parentState)},
    };
    validate(workflow);
    return {ok:true,value:workflow};
  }catch(error){
    if(error instanceof Invalid)return {ok:false,error:{path:error.path,reason:error.message}};
    throw error;
  }
}

/* ------------------------------------------------------------ queries */

/** Every seat a delivery ticket can hold: its work roles, then its judges, in configured order. */
export function ticketSeatRoles(workflow:Workflow):Role[] {
  const roles:Role[]=[];
  for(const state of Object.values(workflow.ticket.states)){
    if(state.kind==='work'&&!roles.includes(state.role))roles.push(state.role);
    if(state.kind==='judge')roles.push(...state.judges.map(judge=>judge.role));
  }
  return roles;
}
export function parentSeatRoles(workflow:Workflow):Role[] {
  return Object.values(workflow.parent.states).flatMap(state=>state.kind==='judge'?state.judges.map(judge=>judge.role):[]);
}
/** Every agent the workflow names, checked before the workflow is frozen into an agenda. */
export function workflowAgents(workflow:Workflow):string[] {
  const states=[...Object.values(workflow.ticket.states),...Object.values(workflow.parent.states)];
  return [...new Set(states.flatMap(state=>state.kind==='work'?[state.agent]:state.kind==='judge'?state.judges.map(judge=>judge.agent):[]))];
}
export function openVerdicts(roster:readonly Judge[]):Verdict[] {return roster.map(judge=>({role:judge.role,status:'pending',note:''}));}
/** The frozen roster, not the recorded verdicts, decides which judges a state requires; an empty roster passes. */
export function stagePassed(roster:readonly Judge[],verdicts:readonly Verdict[]):boolean {
  return roster.every(judge=>verdicts.some(verdict=>verdict.role===judge.role&&verdict.status==='passed'));
}
export function pendingRoles(roster:readonly Judge[],verdicts:readonly Verdict[]):Role[] {
  return roster.filter(judge=>verdicts.some(verdict=>verdict.role===judge.role&&verdict.status==='pending')).map(judge=>judge.role);
}
/** Recorded verdicts must name exactly the state's configured judges, in order. */
export function verdictsMatch(roster:readonly Judge[],verdicts:readonly Verdict[]):boolean {
  return roster.length===verdicts.length&&roster.every((judge,index)=>verdicts[index]!.role===judge.role);
}
/** The first branch whose condition holds decides the target; otherwise the route's fallback. */
export function routeTarget(route:Route,holds:(condition:Condition)=>boolean):string {
  return route.branches.find(branch=>holds(branch.when))?.to??route.otherwise;
}

/* ------------------------------------------------------------ encoding */

/** The file-shaped form of a parsed workflow; `parseWorkflow(encodeWorkflow(w))` reproduces `w` exactly. Agendas persist this form. */
export function encodeWorkflow(workflow:Workflow):unknown {
  const condition=(item:Condition):unknown=>{
    switch(item.kind){
      case 'checks':return {checks:item.is};
      case 'mergeable':return {mergeable:item.is};
      case 'visits':return {visits:{state:item.state,atLeast:item.atLeast}};
      case 'all':case 'any':return {[item.kind]:item.of.map(condition)};
      case 'not':return {not:condition(item.of)};
    }
  };
  const route=(item:Route):unknown=>item.branches.length?[...item.branches.map(branch=>({when:condition(branch.when),to:branch.to})),{to:item.otherwise}]:item.otherwise;
  const on=(item:Record<string,Route>)=>Object.fromEntries(Object.entries(item).map(([key,value])=>[key,route(value)]));
  const guard=(item:Guard|null)=>item?{when:condition(item.when),otherwise:item.otherwise}:{};
  const branches=(state:{branches:Branch[];otherwise:string|null})=>[...state.branches.map(branch=>({when:condition(branch.when),to:branch.to})),...(state.otherwise?[{to:state.otherwise}]:[])];
  const ticket=(state:TicketState):unknown=>{
    switch(state.kind){
      case 'work':return {kind:state.kind,...guard(state.guard),role:state.role,agent:state.agent,brief:state.brief,on:on(state.on)};
      case 'judge':return {kind:state.kind,...guard(state.guard),subject:state.subject,judges:state.judges,...(state.subject==='pullRequest'?{observe:state.observe}:{}),on:on(state.on)};
      case 'action':{
        const action=state.action;
        return {kind:state.kind,...guard(state.guard),action:action.kind,...(action.kind==='merge'||action.kind==='closeIssue'?{requires:action.requires}:{}),...(action.kind==='merge'?{observe:action.observe}:{}),on:on(state.on)};
      }
      case 'decision':return {kind:state.kind,...guard(state.guard),observe:state.observe,branches:branches(state)};
      case 'final':return {kind:state.kind,...guard(state.guard)};
    }
  };
  const parent=(state:ParentState):unknown=>{
    switch(state.kind){
      case 'judge':return {kind:state.kind,...guard(state.guard),judges:state.judges,on:on(state.on)};
      case 'action':return {kind:state.kind,...guard(state.guard),action:state.action.kind,requires:state.action.requires,on:on(state.on)};
      case 'decision':return {kind:state.kind,...guard(state.guard),branches:branches(state)};
      case 'final':return {kind:state.kind,...guard(state.guard)};
    }
  };
  return {
    ticket:{initial:workflow.ticket.initial,adopted:workflow.ticket.adopted,states:Object.fromEntries(Object.entries(workflow.ticket.states).map(([key,state])=>[key,ticket(state)]))},
    parent:{initial:workflow.parent.initial,states:Object.fromEntries(Object.entries(workflow.parent.states).map(([key,state])=>[key,parent(state)]))},
  };
}
