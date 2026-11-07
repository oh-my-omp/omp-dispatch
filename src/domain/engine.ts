import type {Action,Agenda,Caller,ClosureGate,ConveneInput,DomainError,Effect,EffectResult,Entry,Facts,MergeCommitStamp,NoteAuthor,ParentStamp,PmAsk,PmContext,PortError,PortInput,PrSnapshot,PullRequestStamp,Result,Role,Ticket,Tier,WorkerStarted,Workflow} from './model.ts';
import {bodyHash,canonical,contains,digest,exactClosingBody,nextId,sameRef,sameRepo,sameTarget,targetHead} from './identity.ts';
import {formatMarker} from '../pm/markers.ts';
import {settlement} from '../pm/settlement.ts';
import {validateTopology} from './parse.ts';
import {ASKING,ESCALATE,ESCALATED,REPLACED,openVerdicts,pendingRoles,routeTarget,stagePassed,type Branch,type Condition,type Observe,type ParentState,type TicketState} from './workflow.ts';

const SYSTEM:NoteAuthor={kind:'system'},MAIN:NoteAuthor={kind:'main'};
/** A machine that keeps entering states without waiting for a seat, an effect or a source change is misconfigured. */
const HOPS=64;
type NoteKind=Ticket['notes'][number]['kind'];
type Holds=(condition:Condition)=>boolean;
function reject(kind:DomainError['kind'],message:string):{ok:false;error:DomainError}{return {ok:false,error:{kind,message}};}
function note(ticket:Ticket,author:NoteAuthor,kind:NoteKind,text:string,at:number):void {ticket.notes.push({at,author,kind,text});}
function escalateTicket(ticket:Ticket,text:string,at:number,kind:NoteKind):void {
  ticket.revision++;ticket.gates={};ticket.state=ESCALATED;ticket.ask=null;note(ticket,SYSTEM,kind,text,at);
}
function escalateClosure(closure:ClosureGate,text:string):void {closure.revision++;closure.gates={};closure.state=ESCALATED;closure.notes.push(text);}
export function enqueue(state:Agenda,ticketId:string,action:Action,origin:Effect['origin']):Effect {
  const effect:Effect={id:nextId(state,'effect'),ticketId,action,origin,attempt:0,state:{kind:'ready'}};
  state.effects.push(effect);return effect;
}

/* ------------------------------------------------------------ definitions */

export function ticketDefinition(workflow:Workflow,ticket:Ticket):TicketState|null {return ticket.state===ESCALATED||ticket.state===ASKING||ticket.state===REPLACED?null:workflow.ticket.states[ticket.state]??null;}
export function parentDefinition(workflow:Workflow,closure:ClosureGate):ParentState|null {return closure.state===ESCALATED?null:workflow.parent.states[closure.state]??null;}
/** A ticket is delivered while it rests in a final state of the workflow, or in `Replaced` once its issue was replaced. */
export function delivered(state:Agenda,ticket:Ticket):boolean {return ticket.state===REPLACED||ticketDefinition(state.workflow,ticket)?.kind==='final';}
export function dependenciesDone(state:Agenda,ticket:Ticket):boolean {
  return ticket.dependsOn.every(id=>{const dependency=state.tickets.find(item=>item.id===id);return dependency!==undefined&&delivered(state,dependency);});
}
function sourcePr(ticket:Ticket,facts:Facts):PrSnapshot|undefined{return ticket.pr?.ref?facts.prs.find(pr=>sameRef(pr.ref,ticket.pr!.ref!)):undefined;}
function ticketHolds(ticket:Ticket,facts:Facts):Holds {
  const holds:Holds=condition=>{
    switch(condition.kind){
      case 'checks':return sourcePr(ticket,facts)?.checks.kind===condition.is;
      case 'mergeable':return sourcePr(ticket,facts)?.mergeable===condition.is;
      case 'visits':return (ticket.visits[condition.state]??0)>=condition.atLeast;
      case 'all':return condition.of.every(holds);
      case 'any':return condition.of.some(holds);
      case 'not':return !holds(condition.of);
    }
  };
  return holds;
}
function parentHolds(closure:ClosureGate):Holds {
  const holds:Holds=condition=>{
    switch(condition.kind){
      // The workflow parser refuses PR conditions in the parent machine.
      case 'checks':case 'mergeable':return false;
      case 'visits':return (closure.visits[condition.state]??0)>=condition.atLeast;
      case 'all':return condition.of.every(holds);
      case 'any':return condition.of.some(holds);
      case 'not':return !holds(condition.of);
    }
  };
  return holds;
}
/** The first branch whose condition holds; else the decision's fallback, or null to keep waiting. */
function decide(decision:{branches:Branch[];otherwise:string|null},holds:Holds):string|null {return decision.branches.find(branch=>holds(branch.when))?.to??decision.otherwise;}

/* ------------------------------------------------------------ fingerprints */

function contractIssue(ticket:Ticket,facts:Facts){
  const issue=facts.issues.find(issue=>sameRef(issue.ref,ticket.issue));
  return issue&&issue.bodyHash===ticket.contract.bodyHash?issue:null;
}
/** What a pullRequest judge judges: the exact open PR head that closes this issue at its target. */
export function pullRequestStamp(ticket:Ticket,facts:Facts):PullRequestStamp|null {
  const issue=contractIssue(ticket,facts),pr=sourcePr(ticket,facts);
  if(!issue||!pr||pr.state.kind!=='open'||pr.head!==ticket.pr?.head||!sameTarget(pr.target,ticket.target)||!exactClosingBody(pr.body,ticket.issue,pr.ref.repo)||pr.closes.length!==1||!sameRef(pr.closes[0]!,ticket.issue))return null;
  return {kind:'pullRequest',pr:pr.ref,head:pr.head,target:pr.target,bodyHash:issue.bodyHash,prBodyHash:pr.bodyHash,contractRevision:ticket.contract.revision,rulingsHash:digest(ticket.rulings)};
}
/** What a mergeCommit judge judges: the ticket's merge commit, still contained in its target. */
export function mergeCommitStamp(ticket:Ticket,facts:Facts):MergeCommitStamp|null {
  const issue=contractIssue(ticket,facts),terminal=ticket.terminal,head=targetHead(facts,ticket.target);
  if(!issue||terminal?.kind!=='merged'||!head||!contains(facts,ticket.target.repo,terminal.mergeSha,head))return null;
  const pr=facts.prs.find(pr=>sameRef(pr.ref,terminal.pr));
  if(pr?.state.kind!=='merged'||pr.state.sha!==terminal.mergeSha||!sameTarget(pr.target,ticket.target))return null;
  return {kind:'mergeCommit',issue:ticket.issue,bodyHash:issue.bodyHash,contractRevision:ticket.contract.revision,terminal,target:ticket.target,commit:terminal.mergeSha,rulingsHash:digest(ticket.rulings)};
}
/** What parent judges judge: every delivered child, its terminal and its target. */
function parentStamp(state:Agenda,facts:Facts):ParentStamp|null {
  if(!state.parent||state.tickets.some(ticket=>!delivered(state,ticket)||!ticket.terminal))return null;
  const parent=facts.issues.find(issue=>sameRef(issue.ref,state.parent!));
  if(!parent||parent.children.some(child=>!state.tickets.some(ticket=>sameRef(ticket.issue,child))))return null;
  const targets:Ticket['target'][]=[];
  const children:{id:string;issue:Ticket['issue'];terminal:NonNullable<Ticket['terminal']>}[]=[];
  for(const ticket of state.tickets){
    const issue=facts.issues.find(issue=>sameRef(issue.ref,ticket.issue));
    if(issue?.state!=='closed'||issue.bodyHash!==ticket.contract.bodyHash||!ticket.terminal)return null;
    const head=targetHead(facts,ticket.target);if(!head)return null;
    if(ticket.terminal.kind==='merged'&&!contains(facts,ticket.target.repo,ticket.terminal.mergeSha,head))return null;
    if(!targets.some(item=>sameTarget(item,ticket.target)))targets.push(ticket.target);
    children.push({id:ticket.id,issue:ticket.issue,terminal:ticket.terminal});
  }
  return {kind:'parent',parent:state.parent,bodyHash:parent.bodyHash,children,targets,rulingsHash:digest(state.closure?.rulings??[])};
}
function mergeReady(ticket:Ticket,pr:PrSnapshot,facts:Facts):boolean {
  const base=facts.repos.find(item=>sameRepo(item.repo,ticket.target.repo))?.bases.find(item=>item.name===ticket.target.base);
  return pr.state.kind==='open'&&pr.mergeable==='yes'&&pr.checks.kind==='passing'&&base?.state.kind==='present';
}

/* ------------------------------------------------------------ safety capabilities */

/** A judge state's approval: its gate exists, judged exactly `stamp`, and every configured judge passed. */
function approved(roster:TicketState|ParentState|undefined,gate:{stamp:unknown;verdicts:Ticket['gates'][string]['verdicts']}|undefined,stamp:unknown):boolean {
  return roster?.kind==='judge'&&gate!==undefined&&canonical(gate.stamp)===canonical(stamp)&&stagePassed(roster.judges,gate.verdicts);
}
/** Merging needs every required approval, and every approval the ticket still holds, on the current PR fingerprint. */
function mergeProblem(state:Agenda,ticket:Ticket,facts:Facts,requires:string[]):string|null {
  const stamp=pullRequestStamp(ticket,facts);
  if(!stamp)return 'the pull request is not an open PR that closes exactly this issue at its target';
  for(const name of requires)if(!approved(state.workflow.ticket.states[name],ticket.gates[name],stamp))return `${name} has not approved the current pull request`;
  for(const [name,gate] of Object.entries(ticket.gates))if(gate.stamp.kind==='pullRequest'&&!approved(state.workflow.ticket.states[name],gate,stamp))return `${name} approved a different pull request fingerprint`;
  return null;
}
/** Closing the issue needs a Main noCode ruling on the current contract, or a contained merge with its approvals. */
function closeProblem(state:Agenda,ticket:Ticket,facts:Facts,requires:string[]):string|null {
  const terminal=ticket.terminal,issue=facts.issues.find(issue=>sameRef(issue.ref,ticket.issue));
  if(terminal?.kind==='noCode')return terminal.bodyHash===issue?.bodyHash?null:'the noCode ruling no longer matches the issue contract';
  if(terminal?.kind!=='merged')return 'the ticket has neither a merged PR nor a noCode ruling';
  const stamp=mergeCommitStamp(ticket,facts);
  if(!stamp)return 'the merge commit or its contract is not present in the target';
  for(const name of requires)if(!approved(state.workflow.ticket.states[name],ticket.gates[name],stamp))return `${name} has not approved the current merge commit`;
  for(const [name,gate] of Object.entries(ticket.gates))if(gate.stamp.kind==='mergeCommit'&&!approved(state.workflow.ticket.states[name],gate,stamp))return `${name} approved a different merge fingerprint`;
  return null;
}
function closeParentProblem(state:Agenda,closure:ClosureGate,facts:Facts,requires:string[]):string|null {
  const stamp=parentStamp(state,facts);
  if(!stamp||canonical(stamp)!==canonical(closure.stamp))return 'the children, their terminals or targets changed';
  for(const name of requires)if(!approved(state.workflow.parent.states[name],closure.gates[name],stamp))return `${name} has not approved the current children`;
  for(const [name,gate] of Object.entries(closure.gates))if(!approved(state.workflow.parent.states[name],gate,stamp))return `${name} approved different children`;
  return null;
}
/** A final state holds only while the issue is closed and its terminal is still true at source. */
function finalProblem(ticket:Ticket,facts:Facts):string|null {
  const issue=facts.issues.find(issue=>sameRef(issue.ref,ticket.issue)),terminal=ticket.terminal;
  if(issue?.state!=='closed')return 'the issue is not closed';
  if(!terminal)return 'the ticket has neither a merged PR nor a noCode ruling';
  switch(terminal.kind){
    case 'noCode':return terminal.bodyHash===issue.bodyHash?null:'the noCode ruling no longer matches the issue contract';
    // A replaced issue rests in the built-in Replaced, never in a workflow final state.
    case 'replaced':return `the issue was replaced by ${terminal.by}, not delivered through this workflow`;
    case 'merged':{
      const head=targetHead(facts,ticket.target);
      return head&&contains(facts,ticket.target.repo,terminal.mergeSha,head)?null:'the merge is no longer in the target';
    }
  }
}
function currentOrigin(state:Agenda,effect:Effect):boolean {
  const owner=state.tickets.find(ticket=>ticket.id===effect.ticketId)??(state.closure?.id===effect.ticketId?state.closure:null);
  return effect.origin!==null&&owner!==null&&owner.state===effect.origin.state&&owner.revision===effect.origin.revision;
}
function liveFromEntry(state:Agenda,ticketId:string,origin:{state:string;revision:number}):Effect[] {
  return state.effects.filter(effect=>effect.ticketId===ticketId&&effect.origin?.state===origin.state&&effect.origin.revision===origin.revision&&effect.state.kind!=='cancelled');
}

/* ------------------------------------------------------------ ticket machine */

/** Enter `target`, following entry guards and states that complete at once, until the ticket waits. */
function enterTicket(state:Agenda,ticket:Ticket,target:string,facts:Facts,at:number):void {
  const holds=ticketHolds(ticket,facts);
  let next=target;
  for(let hop=0;hop<HOPS;hop++){
    if(next===ESCALATE){escalateTicket(ticket,'The workflow routed this ticket to Main.',at,'escalation');return;}
    const definition:TicketState=state.workflow.ticket.states[next]!;
    if(definition.guard&&!holds(definition.guard.when)){next=definition.guard.otherwise;continue;}
    ticket.revision++;ticket.state=next;ticket.ask=null;ticket.visits[next]=(ticket.visits[next]??0)+1;
    const after=arriveTicket(state,ticket,next,definition,facts,at,holds);
    if(after===null)return;
    next=after;
  }
  escalateTicket(ticket,`The workflow moved through ${HOPS} states without waiting; check its routes for a loop.`,at,'escalation');
}
/** Start the state just entered; return the next state when it completes at once. */
function arriveTicket(state:Agenda,ticket:Ticket,name:string,definition:TicketState,facts:Facts,at:number,holds:Holds):string|null {
  const origin={state:name,revision:ticket.revision};
  switch(definition.kind){
    case 'work':ticket.gates={};return null;
    case 'judge':{
      const stamp=definition.subject==='pullRequest'?pullRequestStamp(ticket,facts):mergeCommitStamp(ticket,facts);
      if(!stamp){escalateTicket(ticket,definition.subject==='pullRequest'?`${name} needs an open PR that closes exactly this issue at its target.`:`${name} needs the merged commit and its contract in the target.`,at,'sourceChange');return null;}
      ticket.gates[name]={stamp,verdicts:openVerdicts(definition.judges)};
      return definition.judges.length?null:routeTarget(definition.on.passed,holds);
    }
    case 'action':{
      const action=definition.action;
      switch(action.kind){
        case 'publishPr':{
          const submission=ticket.pr;
          if(!submission){escalateTicket(ticket,`${name} cannot publish: no work state has submitted a branch.`,at,'escalation');return null;}
          enqueue(state,ticket.id,{kind:'publishPr',issue:ticket.issue,headRepo:submission.headRepo,branch:submission.branch,head:submission.head,title:submission.title,body:submission.body,pr:submission.ref,target:ticket.target,expectedBodyHash:sourcePr(ticket,facts)?.bodyHash??null},origin);
          return null;
        }
        case 'merge':{
          const problem=mergeProblem(state,ticket,facts,action.requires);
          if(problem){escalateTicket(ticket,`${name} cannot merge: ${problem}.`,at,'escalation');return null;}
          tryMerge(state,ticket,origin,facts);return null;
        }
        case 'closeIssue':{
          const problem=closeProblem(state,ticket,facts,action.requires);
          const issue=facts.issues.find(issue=>sameRef(issue.ref,ticket.issue));
          if(problem||!issue){escalateTicket(ticket,`${name} cannot close the issue: ${problem??'the issue is unavailable'}.`,at,'escalation');return null;}
          enqueue(state,ticket.id,{kind:'setIssueState',issue:ticket.issue,open:false,bodyHash:issue.bodyHash,afterEvent:issue.lastReopen?.id??null},origin);
          return null;
        }
        case 'rerunChecks':{
          const pr=sourcePr(ticket,facts);
          const runs=pr?.checks.kind==='failing'?pr.checks.required.flatMap(failure=>failure.kind==='actions'?[failure]:[]):[];
          if(!pr||!runs.length){escalateTicket(ticket,`${name} cannot rerun checks: the PR has no failing GitHub Actions check.`,at,'checks');return null;}
          for(const run of runs.filter((run,index)=>runs.findIndex(item=>item.workflowRunId===run.workflowRunId)===index))
            enqueue(state,ticket.id,{kind:'rerunChecks',pr:pr.ref,repo:pr.ref.repo,workflowRunId:run.workflowRunId,previousAttempt:run.runAttempt,head:pr.head},origin);
          return null;
        }
      }
    }
    case 'decision':return decide(definition,holds);
    case 'final':{
      const problem=finalProblem(ticket,facts);
      if(problem)escalateTicket(ticket,`${name} is final, but ${problem}.`,at,'sourceChange');
      return null;
    }
  }
}
/** A merge is requested once the PR is mergeable with passing checks and every dependency is delivered. */
function tryMerge(state:Agenda,ticket:Ticket,origin:{state:string;revision:number},facts:Facts):void {
  if(liveFromEntry(state,ticket.id,origin).length||!dependenciesDone(state,ticket))return;
  const pr=sourcePr(ticket,facts),stamp=pullRequestStamp(ticket,facts);
  if(!pr||!stamp||!mergeReady(ticket,pr,facts))return;
  enqueue(state,ticket.id,{kind:'merge',issue:ticket.issue,pr:pr.ref,head:pr.head,target:ticket.target,stampHash:digest(stamp)},origin);
}
/**
 * While the ticket holds an open PR in a state that observes it, source events route the ticket by the state's
 * `observe` map. A PR that stops being this delivery, unknown checks and drafts always reach Main.
 */
function observePullRequest(state:Agenda,ticket:Ticket,observe:Observe,facts:Facts,at:number):boolean {
  if(!ticket.pr?.ref||ticket.terminal)return false;
  const pr=sourcePr(ticket,facts);
  if(!pr||pr.state.kind!=='open'||!sameTarget(pr.target,ticket.target)||!exactClosingBody(pr.body,ticket.issue,pr.ref.repo)||pr.closes.length!==1||!sameRef(pr.closes[0]!,ticket.issue)){
    escalateTicket(ticket,'PR is closed, missing, retargeted, or no longer closes exactly this issue.',at,'sourceChange');return true;
  }
  if(pr.checks.kind==='unknown'){escalateTicket(ticket,`Required CI observations cannot be verified: ${pr.checks.reason}`,at,'checks');return true;}
  if(pr.mergeable==='draft'){escalateTicket(ticket,'The PR is a draft; Main must obtain a source change or adopt a ready PR.',at,'sourceChange');return true;}
  // GitHub fixes a PR's head repository and branch at creation, so only these fields can legitimately move.
  const drifted=pr.head!==ticket.pr.head||pr.body!==ticket.pr.body||pr.title!==ticket.pr.title;
  if(drifted){
    ticket.pr={...ticket.pr,head:pr.head,title:pr.title,body:pr.body};
    for(const [name,gate] of Object.entries(ticket.gates))if(gate.stamp.kind==='pullRequest')delete ticket.gates[name];
    note(ticket,SYSTEM,'sourceChange',`Open PR changed to head ${pr.head}; gates restart on the new fingerprint.`,at);
  }
  if(pr.checks.kind==='failing'){note(ticket,SYSTEM,'checks',JSON.stringify(pr.checks),at);enterTicket(state,ticket,observe.checksFailed,facts,at);return true;}
  if(pr.mergeable==='no'){note(ticket,SYSTEM,'conflict','PR conflicts with the target.',at);enterTicket(state,ticket,observe.conflict,facts,at);return true;}
  if(pr.mergeable==='behind'){note(ticket,SYSTEM,'conflict','GitHub requires this branch to be updated with the target.',at);enterTicket(state,ticket,observe.behind,facts,at);return true;}
  if(drifted){enterTicket(state,ticket,observe.drift,facts,at);return true;}
  return false;
}
function reconcileTicket(state:Agenda,ticket:Ticket,facts:Facts,at:number):void {
  const definition=ticketDefinition(state.workflow,ticket);
  if(!definition)return;
  const issue=facts.issues.find(issue=>sameRef(issue.ref,ticket.issue));
  if(!issue)return;
  if(issue.bodyHash!==ticket.contract.bodyHash){escalateTicket(ticket,'GitHub issue body changed; Main must synchronize the contract and rule.',at,'sourceChange');return;}
  const holds=ticketHolds(ticket,facts);
  switch(definition.kind){
    case 'work':return;
    case 'final':{
      const problem=finalProblem(ticket,facts);
      if(problem)escalateTicket(ticket,`Completed source was reopened or its merge is no longer in the target: ${problem}.`,at,'sourceChange');
      return;
    }
    case 'judge':{
      if(definition.subject==='pullRequest'){observePullRequest(state,ticket,definition.observe,facts,at);return;}
      const stamp=mergeCommitStamp(ticket,facts),gate=ticket.gates[ticket.state];
      if(!stamp)escalateTicket(ticket,'Merged commit or post-merge contract is not present in the target.',at,'sourceChange');
      // The judged merge commit stays fixed; a changed contract or ruling restarts this state on the new fingerprint.
      else if(gate&&canonical(gate.stamp)!==canonical(stamp))enterTicket(state,ticket,ticket.state,facts,at);
      return;
    }
    case 'action':{
      if(definition.action.kind!=='merge')return;
      if(observePullRequest(state,ticket,definition.action.observe,facts,at))return;
      const problem=mergeProblem(state,ticket,facts,definition.action.requires);
      if(problem){escalateTicket(ticket,`PR head, target, closing link, body, or review contract changed after approval; fresh gates are required (${problem}).`,at,'sourceChange');return;}
      tryMerge(state,ticket,{state:ticket.state,revision:ticket.revision},facts);
      return;
    }
    case 'decision':{
      if(observePullRequest(state,ticket,definition.observe,facts,at))return;
      const next=decide(definition,holds);
      if(next)enterTicket(state,ticket,next,facts,at);
      return;
    }
  }
}

/* ------------------------------------------------------------ parent machine */

function enterParent(state:Agenda,closure:ClosureGate,target:string,facts:Facts,at:number):void {
  const holds=parentHolds(closure);
  let next=target;
  for(let hop=0;hop<HOPS;hop++){
    if(next===ESCALATE){escalateClosure(closure,'The workflow routed the parent closure to Main.');return;}
    const definition:ParentState=state.workflow.parent.states[next]!;
    if(definition.guard&&!holds(definition.guard.when)){next=definition.guard.otherwise;continue;}
    closure.revision++;closure.state=next;closure.visits[next]=(closure.visits[next]??0)+1;
    const after=arriveParent(state,closure,next,definition,facts,holds);
    if(after===null)return;
    next=after;
  }
  escalateClosure(closure,`The parent workflow moved through ${HOPS} states without waiting; check its routes for a loop.`);
}
/** A parent final state holds only while the parent issue is closed and the children are the ones judged. */
function parentFinalProblem(state:Agenda,closure:ClosureGate,facts:Facts):string|null {
  const parent=state.parent?facts.issues.find(issue=>sameRef(issue.ref,state.parent!)):undefined;
  if(parent?.state!=='closed')return 'the parent issue is not closed';
  const stamp=parentStamp(state,facts);
  return stamp&&canonical(stamp)===canonical(closure.stamp)?null:'the children, their terminals or targets changed';
}
function arriveParent(state:Agenda,closure:ClosureGate,name:string,definition:ParentState,facts:Facts,holds:Holds):string|null {
  switch(definition.kind){
    case 'judge':
      closure.gates[name]={stamp:closure.stamp,verdicts:openVerdicts(definition.judges)};
      return definition.judges.length?null:routeTarget(definition.on.passed,holds);
    case 'action':{
      const problem=closeParentProblem(state,closure,facts,definition.action.requires);
      const parent=state.parent?facts.issues.find(issue=>sameRef(issue.ref,state.parent!)):undefined;
      if(problem||!parent){escalateClosure(closure,`${name} cannot close the parent: ${problem??'the parent issue is unavailable'}.`);return null;}
      enqueue(state,closure.id,{kind:'setIssueState',issue:parent.ref,open:false,bodyHash:parent.bodyHash,afterEvent:parent.lastReopen?.id??null},{state:name,revision:closure.revision});
      return null;
    }
    case 'decision':return decide(definition,holds);
    case 'final':{
      const problem=parentFinalProblem(state,closure,facts);
      if(problem)escalateClosure(closure,`${name} is final, but ${problem}.`);
      return null;
    }
  }
}
function reconcileParent(state:Agenda,facts:Facts,at:number):void {
  if(!state.parent)return;
  const stamp=parentStamp(state,facts);
  if(!state.closure){
    if(!stamp)return;
    state.closure={id:`${state.id}/closure`,revision:0,state:state.workflow.parent.initial,stamp,visits:{},gates:{},rulings:[],notes:[]};
    enterParent(state,state.closure,state.workflow.parent.initial,facts,at);return;
  }
  const closure=state.closure;
  if(!stamp){
    if(closure.state!==ESCALATED)escalateClosure(closure,'Parent, child membership, terminal, or target verification changed.');
    return;
  }
  // Changed children restart the parent machine on the new fingerprint, also after an escalation.
  if(canonical(closure.stamp)!==canonical(stamp)){closure.stamp=stamp;closure.gates={};enterParent(state,closure,state.workflow.parent.initial,facts,at);return;}
  const definition=parentDefinition(state.workflow,closure);
  if(definition?.kind==='decision'){const next=decide(definition,parentHolds(closure));if(next)enterParent(state,closure,next,facts,at);}
  if(definition?.kind==='final'){const problem=parentFinalProblem(state,closure,facts);if(problem)escalateClosure(closure,`The delivered parent no longer holds: ${problem}.`);}
}

/* ------------------------------------------------------------ queries */

export function availableRoles(state:Agenda,ticket:Ticket):Role[] {
  const definition=ticketDefinition(state.workflow,ticket);
  if(!definition||!dependenciesDone(state,ticket))return [];
  switch(definition.kind){
    case 'work':return [definition.role];
    case 'judge':{const gate=ticket.gates[ticket.state];return gate?pendingRoles(definition.judges,gate.verdicts):[];}
    case 'action':case 'decision':case 'final':return [];
  }
}
/** The parent closure's judges still owing a verdict on its current state. */
export function closureRoles(state:Agenda):Role[] {
  const closure=state.closure,definition=closure?parentDefinition(state.workflow,closure):null;
  if(!closure||definition?.kind!=='judge')return [];
  const gate=closure.gates[closure.state];
  return gate?pendingRoles(definition.judges,gate.verdicts):[];
}
/** A ticket Main has not launched yet, whose dependencies are all delivered. */
export function awaitsLaunch(state:Agenda,ticket:Ticket):boolean {
  const definition=ticketDefinition(state.workflow,ticket);
  return !ticket.started&&definition!==null&&definition.kind!=='final'&&dependenciesDone(state,ticket);
}
/** The seat a role holds in its ticket's or closure's current state. */
export type SeatSpec={kind:'work';state:string;role:Role;agent:string;brief:string}|{kind:'judge';state:string;subject:'pullRequest'|'mergeCommit'|'parent';role:Role;agent:string;brief:string};
export function currentSeat(state:Agenda,ticketId:string,role:Role):SeatSpec|null {
  const ticket=state.tickets.find(ticket=>ticket.id===ticketId);
  if(ticket){
    const definition=ticketDefinition(state.workflow,ticket);
    if(definition?.kind==='work'&&definition.role===role)return {kind:'work',state:ticket.state,role,agent:definition.agent,brief:definition.brief};
    const judge=definition?.kind==='judge'?definition.judges.find(item=>item.role===role):undefined;
    return definition?.kind==='judge'&&judge?{kind:'judge',state:ticket.state,subject:definition.subject,...judge}:null;
  }
  const closure=state.closure?.id===ticketId?state.closure:null,definition=closure?parentDefinition(state.workflow,closure):null;
  const judge=definition?.kind==='judge'?definition.judges.find(item=>item.role===role):undefined;
  return closure&&judge?{kind:'judge',state:closure.state,subject:'parent',...judge}:null;
}

/* ------------------------------------------------------------ convene and reconcile */

function ticketFrom(state:Agenda,entry:Entry,facts:Facts,at:number):Result<Ticket,DomainError> {
  const source=facts.issues.find(issue=>sameRef(issue.ref,entry.issue));
  if(!source)return reject('sourceUnavailable',`Issue ${entry.id} was not returned by GitHub`);
  if(!targetHead(facts,entry.target))return reject('sourceUnavailable',`Target for ${entry.id} does not exist`);
  const initial=state.workflow.ticket.initial;
  // A ticket starts in the initial work state; an adopted one starts where its PR stands and never visited it.
  const ticket:Ticket={id:entry.id,revision:1,issue:entry.issue,target:entry.target,dependsOn:entry.dependsOn,
    contract:{revision:1,bodyHash:source.bodyHash,body:source.body},state:initial,started:false,visits:entry.adoptPr?{}:{[initial]:1},sessions:{},pr:null,
    gates:{},rulings:[],notes:[],terminal:null,ask:null,resumeMessage:null};
  if(entry.adoptPr){
    const pr=facts.prs.find(pr=>sameRef(pr.ref,entry.adoptPr!));
    if(!pr||!sameTarget(pr.target,ticket.target)||pr.closes.length!==1||!sameRef(pr.closes[0]!,ticket.issue))return reject('sourceChanged','Adopted PR must close exactly this issue at the target');
    ticket.pr={ref:pr.ref,headRepo:pr.headRepo,branch:pr.headBranch,head:pr.head,title:pr.title,body:pr.body};
    if(pr.state.kind==='merged'){
      ticket.terminal={kind:'merged',pr:pr.ref,mergeSha:pr.state.sha,at:pr.state.at};
      enterTicket(state,ticket,state.workflow.ticket.adopted.mergeCommit,facts,at);
    }else if(pr.state.kind==='open')enterTicket(state,ticket,state.workflow.ticket.adopted.pullRequest,facts,at);
    else return reject('invalidTransition','A closed unmerged PR cannot be adopted');
  }else if(source.state==='closed')escalateTicket(ticket,'The issue is already closed; Main must rule on it.',at,'sourceChange');
  return {ok:true,value:ticket};
}
export function createAgenda(input:ConveneInput,workflow:Workflow,facts:Facts,at:number,id:string):Result<Agenda,DomainError> {
  const state:Agenda={id,version:1,nextId:1,convenedAt:at,lifecycle:'active',parent:input.parent,workflow,tickets:[],closure:null,effects:[],run:{kind:'detached'},summary:null};
  for(const entry of input.tickets){const ticket=ticketFrom(state,entry,facts,at);if(!ticket.ok)return ticket;state.tickets.push(ticket.value);}
  const topology=validateTopology(state);if(topology)return reject('invalidTopology',topology);
  if(input.parent){
    const parent=facts.issues.find(issue=>sameRef(issue.ref,input.parent!));
    if(!parent||parent.children.some(child=>!state.tickets.some(ticket=>sameRef(ticket.issue,child))))return reject('invalidTopology','Every current parent sub-issue must be represented by a ticket');
    if(state.tickets.some(ticket=>sameRef(ticket.issue,input.parent!)))return reject('invalidTopology','Parent cannot be its own delivery ticket');
  }
  reconcile(state,facts,at);return {ok:true,value:state};
}
/** Reconcile only fresh, complete GitHub observations. No local intent establishes source state. */
export function reconcile(state:Agenda,facts:Facts,at:number):void {
  // A settled question moves its ticket first, so the state it lands in is reconciled in the same pass.
  for(const ticket of state.tickets)settleAsk(state,ticket,facts,at);
  for(const ticket of state.tickets)reconcileTicket(state,ticket,facts,at);
  reconcileParent(state,facts,at);
  // An effect that is still only an intent belongs to the state entry that requested it.
  for(const effect of state.effects)if(effect.state.kind==='ready'&&effect.origin&&!currentOrigin(state,effect))effect.state={kind:'cancelled',reason:'The state that requested this effect has been left'};
  // A non-escalating effect left uncertain is settled by this complete read: confirmed when the source shows it,
  // failed otherwise. It belongs to no state entry, so its confirmation moves no machine.
  for(const effect of state.effects){
    if(effect.state.kind!=='uncertain'||ESCALATES_ON_FAILURE[effect.action.kind])continue;
    const result=satisfiedResult(state,effect,facts);
    effect.state=result?{kind:'confirmed',result}:{kind:'failed',startedAt:effect.state.startedAt,error:effect.state.error};
  }
  // A confirmed `ask` comment hands its decision item to the intent guardians, once per question: the comment id
  // GitHub shows is recorded on the ticket, and the guardians are asked to answer that comment.
  for(const ticket of state.tickets){
    const ask=ticket.ask;
    if(!ask||ask.comment!==null)continue;
    const posted=state.effects.some(effect=>effect.ticketId===ticket.id&&effect.state.kind==='confirmed'&&effect.action.kind==='comment'&&effect.action.marker.kind==='ask'&&effect.action.marker.key===ask.session);
    const marker=posted?facts.issues.find(issue=>sameRef(issue.ref,ticket.issue))?.pm?.markers.find(marker=>marker.kind==='ask'&&marker.json.session===ask.session):undefined;
    if(!marker)continue;
    ask.comment=marker.id;
    enqueue(state,ticket.id,{kind:'requestAnswer',issue:ticket.issue,comment:marker.id,question:ask.question,tier:ask.tier},{state:ASKING,revision:ticket.revision});
  }
}

/**
 * Whether a failed or uncertain effect of each kind escalates its ticket. PM effects (`comment`, `setProjectField`,
 * `requestAnswer`) are written beside a live seat or for a ticket that waits on the intent guardians, so they never
 * escalate the ticket or supersede its seats: an uncertain one is settled by the next complete read, and a failed
 * one is shown to Main and blocks `finish` until Main resolves it.
 */
export const ESCALATES_ON_FAILURE:Readonly<Record<Action['kind'],boolean>>={publishPr:true,merge:true,setIssueState:true,replaceBody:true,createIssue:true,attachChild:true,rerunChecks:true,comment:false,setProjectField:false,requestAnswer:false};
/**
 * Whether an effect's callee is the authority on its outcome and accepts the same request again. Such an effect is
 * confirmed by the callee's own success response rather than by a GitHub read, its failure is never uncertain, and
 * an intent a restart left executing is called again. The intent guardians accept a repeated `requestAnswer` for
 * the same comment; a GitHub write is confirmed only by reading it back and is never sent twice.
 */
export const REPLAYABLE:Readonly<Record<Action['kind'],boolean>>={publishPr:false,merge:false,setIssueState:false,replaceBody:false,createIssue:false,attachChild:false,rerunChecks:false,comment:false,setProjectField:false,requestAnswer:true};

/**
 * Whether `retry` without a source result sends the same effect again. PM records belong to no state entry, so no
 * action state can request them afresh, and they are idempotent by marker key or field value: the executor adopts
 * one the source already shows instead of writing it twice. `requestAnswer` is requested only once per ask comment,
 * and the guardians accept a repeat for that comment; GitHub never shows it, so its retry always sends it again,
 * provided Main's resolution keeps the ticket in `Asking`. Every other kind is requested afresh by its action state.
 */
const RETRY_RESENDS:Readonly<Record<Action['kind'],boolean>>={publishPr:false,merge:false,setIssueState:false,replaceBody:false,createIssue:false,attachChild:false,rerunChecks:false,comment:true,setProjectField:true,requestAnswer:true};

/* ------------------------------------------------------------ effects */

export function effectPrecondition(state:Agenda,effect:Effect,facts:Facts):string|null {
  const action=effect.action,ticket=state.tickets.find(ticket=>ticket.id===effect.ticketId);
  if(effect.origin&&!currentOrigin(state,effect))return 'The state that requested this effect has been left';
  const definition=ticket?ticketDefinition(state.workflow,ticket):null;
  switch(action.kind){
    case 'publishPr':{
      if(!ticket||ticket.contract.bodyHash!==facts.issues.find(issue=>sameRef(issue.ref,action.issue))?.bodyHash)return 'Publishing contract changed';
      const branch=facts.branches.find(branch=>sameRepo(branch.repo,action.headRepo)&&branch.name===action.branch);
      if(branch?.state.kind!=='present'||branch.state.head!==action.head)return 'Submitted branch head changed';
      if(!exactClosingBody(action.body,action.issue,action.target.repo))return 'PR must close exactly its issue';
      if(action.pr){
        const pr=facts.prs.find(pr=>sameRef(pr.ref,action.pr!));
        if(!pr||pr.state.kind!=='open'||pr.bodyHash!==action.expectedBodyHash)return 'PR edit baseline changed';
        if(!facts.maintenance.some(item=>sameRef(item.pr,action.pr!)&&item.result.kind==='maintainable'))return 'The authenticated actor does not own an authorized editable PR';
      }
      return null;
    }
    case 'merge':{
      if(!ticket||definition?.kind!=='action'||definition.action.kind!=='merge'||!dependenciesDone(state,ticket))return 'Ticket no longer authorizes merging';
      const pr=facts.prs.find(pr=>sameRef(pr.ref,action.pr)),stamp=pullRequestStamp(ticket,facts);
      if(!pr||!stamp||pr.head!==action.head||!sameTarget(pr.target,action.target)||digest(stamp)!==action.stampHash||mergeProblem(state,ticket,facts,definition.action.requires)||!mergeReady(ticket,pr,facts))return 'Fresh gates, exact PR head, CI, or mergeability no longer permit merging';
      return null;
    }
    case 'setIssueState':{
      const issue=facts.issues.find(issue=>sameRef(issue.ref,action.issue));
      if(!issue||issue.bodyHash!==action.bodyHash||(action.open?issue.lastClose:issue.lastReopen)?.id!==(action.afterEvent??undefined))return 'Issue body or opposite lifecycle event changed';
      if(action.open)return null;
      if(ticket)return definition?.kind==='action'&&definition.action.kind==='closeIssue'?closeProblem(state,ticket,facts,definition.action.requires):'Ticket has no accepted closure';
      const closure=state.closure,parent=closure?parentDefinition(state.workflow,closure):null;
      if(closure?.id!==effect.ticketId||parent?.kind!=='action')return 'Parent closure gate changed';
      return closeParentProblem(state,closure,facts,parent.action.requires);
    }
    case 'replaceBody':return facts.issues.find(issue=>sameRef(issue.ref,action.issue))?.bodyHash===action.expectedHash?null:'Issue body edit baseline changed';
    case 'createIssue':return null;
    case 'attachChild':return facts.issues.some(issue=>sameRef(issue.ref,action.parent))&&facts.issues.some(issue=>sameRef(issue.ref,action.child))?null:'Attachment source missing';
    case 'rerunChecks':{
      const pr=facts.prs.find(pr=>sameRef(pr.ref,action.pr)),attempt=facts.checkAttempts.find(item=>sameRepo(item.repo,action.repo)&&item.workflowRunId===action.workflowRunId);
      return pr?.head===action.head&&attempt?.attempt===action.previousAttempt?null:'Workflow attempt or PR head changed';
    }
    // PM records have no source precondition: the comment and the field value are confirmed by reading them back.
    case 'comment':case 'setProjectField':return null;
    // The ticket must still wait on this question, which the effect's origin entry already establishes.
    case 'requestAnswer':return null;
  }
}
export function satisfiedResult(state:Agenda,effect:Effect,facts:Facts):EffectResult|null {
  const action=effect.action;
  switch(action.kind){
    case 'publishPr':{
      const candidates=facts.prs.filter(pr=>(!action.pr||sameRef(pr.ref,action.pr))&&pr.state.kind==='open'&&sameRepo(pr.headRepo,action.headRepo)&&pr.headBranch===action.branch&&pr.head===action.head&&sameTarget(pr.target,action.target)&&pr.title===action.title&&pr.body===action.body&&pr.closes.length===1&&sameRef(pr.closes[0]!,action.issue));
      const pr=candidates.length===1?candidates[0]:undefined;
      const maintained=pr&&facts.maintenance.some(item=>sameRef(item.pr,pr.ref)&&item.result.kind==='maintainable');
      return pr&&maintained?{kind:'published',pr:pr.ref}:null;
    }
    case 'merge':{
      const pr=facts.prs.find(pr=>sameRef(pr.ref,action.pr));
      return pr?.state.kind==='merged'&&pr.head===action.head&&sameTarget(pr.target,action.target)&&pr.closes.length===1&&sameRef(pr.closes[0]!,action.issue)?{kind:'merged',pr:pr.ref,mergeSha:pr.state.sha,at:pr.state.at}:null;
    }
    case 'setIssueState':{
      const issue=facts.issues.find(issue=>sameRef(issue.ref,action.issue));
      return issue&&issue.bodyHash===action.bodyHash&&issue.state===(action.open?'open':'closed')?{kind:'issueState',issue:action.issue,open:action.open}:null;
    }
    case 'replaceBody':return facts.issues.find(issue=>sameRef(issue.ref,action.issue))?.body===action.body?{kind:'bodyReplaced',issue:action.issue,hash:bodyHash(action.body)}:null;
    case 'createIssue':{
      const candidates=facts.createdIssues.filter(issue=>sameRepo(issue.issue.repo,action.repo)&&issue.title===action.title&&issue.body===action.body&&issue.actor.toLowerCase()===facts.viewer.toLowerCase()&&issue.createdAt>=state.convenedAt);
      return candidates.length===1?{kind:'created',issue:candidates[0]!.issue}:null;
    }
    case 'attachChild':return facts.issues.find(issue=>sameRef(issue.ref,action.parent))?.children.some(child=>sameRef(child,action.child))?{kind:'attached',parent:action.parent,child:action.child}:null;
    case 'rerunChecks':{
      const attempt=facts.checkAttempts.find(item=>sameRepo(item.repo,action.repo)&&item.workflowRunId===action.workflowRunId&&item.head===action.head&&item.attempt>action.previousAttempt);
      return attempt?{kind:'rerun',repo:action.repo,workflowRunId:action.workflowRunId,attempt:attempt.attempt}:null;
    }
    case 'comment':{
      const key=action.marker;
      const marker=facts.issues.find(issue=>sameRef(issue.ref,action.issue))?.pm?.markers.find(marker=>(marker.kind==='impl'||marker.kind==='ask')&&marker.kind===key.kind&&marker.json.session===key.key);
      return marker?{kind:'commented',issue:action.issue,comment:marker.id}:null;
    }
    case 'setProjectField':return facts.issues.find(issue=>sameRef(issue.ref,action.issue))?.pm?.item?.status===action.option?{kind:'projectFieldSet',issue:action.issue,field:action.field,option:action.option}:null;
    // GitHub holds no trace of a guardians request; only the guardians' own response confirms it.
    case 'requestAnswer':return null;
  }
}
/**
 * A source-confirmed effect records what it changed. It advances its machine only when it belongs to the current
 * state entry and is the last unconfirmed effect of that entry; a late confirmation never moves a newer state.
 */
export function confirmEffect(state:Agenda,effect:Effect,result:EffectResult,facts:Facts,at:number):void {
  effect.state={kind:'confirmed',result};
  const ticket=state.tickets.find(ticket=>ticket.id===effect.ticketId);
  if(ticket){
    if(result.kind==='published'&&ticket.pr)ticket.pr.ref=result.pr;
    if(result.kind==='merged')ticket.terminal={kind:'merged',pr:result.pr,mergeSha:result.mergeSha,at:result.at};
  }
  const origin=effect.origin;
  if(origin&&currentOrigin(state,effect)&&liveFromEntry(state,effect.ticketId,origin).every(item=>item.state.kind==='confirmed')){
    if(ticket){
      const definition=ticketDefinition(state.workflow,ticket);
      if(definition?.kind==='action')enterTicket(state,ticket,routeTarget(definition.on.done,ticketHolds(ticket,facts)),facts,at);
    }else if(state.closure?.id===effect.ticketId){
      const closure=state.closure,definition=parentDefinition(state.workflow,closure);
      if(definition?.kind==='action')enterParent(state,closure,routeTarget(definition.on.done,parentHolds(closure)),facts,at);
    }
  }
  reconcile(state,facts,at);
}
export function failEffect(state:Agenda,effect:Effect,error:PortError,uncertain:boolean,at:number):void {
  const startedAt=effect.state.kind==='executing'?effect.state.startedAt:at;
  effect.state={kind:uncertain?'uncertain':'failed',startedAt,error};
  if(!ESCALATES_ON_FAILURE[effect.action.kind])return;
  const ticket=state.tickets.find(ticket=>ticket.id===effect.ticketId);
  if(ticket)escalateTicket(ticket,`Effect ${effect.id} ${effect.state.kind}: ${error.message}`,at,'escalation');
  else if(state.closure)escalateClosure(state.closure,`Effect ${effect.id}: ${error.message}`);
}
/**
 * A seat that left its still-current revision without a handoff, or could not be seated at all, needs Main's
 * ruling rather than an automatic relaunch loop. Superseded seats return false: their successor is already due.
 */
export function abandonSeat(state:Agenda,ticketId:string,role:Role,revision:number,reason:string,at:number):boolean {
  const ticket=state.tickets.find(ticket=>ticket.id===ticketId);
  if(ticket){
    if(ticket.revision!==revision||!availableRoles(state,ticket).includes(role))return false;
    escalateTicket(ticket,`The ${role} seat ended without a handoff: ${reason}`,at,'escalation');return true;
  }
  const closure=state.closure;
  if(closure?.id!==ticketId||closure.revision!==revision||!closureRoles(state).includes(role))return false;
  escalateClosure(closure,`The ${role} seat ended without a handoff: ${reason}`);return true;
}

/* ------------------------------------------------------------ PM progress */

/**
 * A work seat's question under PM integration: the ticket waits in `Asking`, with no seat and no call on Main, and
 * the decision item is written verbatim to its issue as a comment ending with an `ask` marker keyed by the asking session.
 * The work state it was asked from is kept, so an answer returns the ticket there.
 */
function askTicket(state:Agenda,ticket:Ticket,ask:{question:string;tier:Tier;session:string;file:string}):void {
  const from=ticket.state;
  ticket.revision++;ticket.gates={};ticket.state=ASKING;ticket.ask={...ask,comment:null,from,agenda:null};
  const marker=formatMarker({kind:'ask',json:{v:1,tier:ask.tier,session:ask.session}});
  enqueue(state,ticket.id,{kind:'comment',issue:ticket.issue,body:`${ask.question}\n\n${marker}`,marker:{kind:'ask',key:ask.session}},{state:ASKING,revision:ticket.revision});
}
/**
 * The work state a question was asked from. A question recorded before Dispatch kept that state names it through
 * its asking session: the work state of the role whose latest session is that file, when the role has only one.
 */
function askedFrom(state:Agenda,ticket:Ticket,ask:NonNullable<Ticket['ask']>):string|null {
  if(ask.from!==null)return ask.from;
  const role=Object.entries(ticket.sessions).find(([,file])=>file===ask.file)?.[0];
  const states=Object.entries(state.workflow.ticket.states).filter(([,definition])=>definition.kind==='work'&&definition.role===role);
  return states.length===1?states[0]![0]:null;
}
/**
 * Settles the question an `Asking` ticket waits on from the markers its issue shows. A `reply` returns the ticket to
 * the work state it asked from, with the answer kept for the work seat that forks the asking session; a `replaced`
 * ends it in `Replaced`, with no seat, PR or close; an `escalated` records the council agenda and keeps it waiting.
 * A settlement marker naming another ask changes nothing and is noted once.
 */
function settleAsk(state:Agenda,ticket:Ticket,facts:Facts,at:number):void {
  const ask=ticket.ask;
  if(ticket.state!==ASKING||!ask||ask.comment===null)return;
  const markers=facts.issues.find(issue=>sameRef(issue.ref,ticket.issue))?.pm?.markers;
  if(!markers)return;
  const read=settlement(ask.comment,markers);
  for(const ignored of read.ignored){
    const text=`ignored settlement ${ignored.commentId} for ask ${ignored.ask??'none'}`;
    if(!ticket.notes.some(item=>item.text===text))note(ticket,SYSTEM,'sourceChange',text,at);
  }
  const settled=read.settlement;
  if(!settled)return;
  switch(settled.kind){
    case 'escalated':
      if(ask.agenda===settled.agenda)return;
      ask.agenda=settled.agenda;
      note(ticket,SYSTEM,'sourceChange',`ask ${ask.comment} was escalated to the council agenda ${settled.agenda} in comment ${settled.commentId}`,at);
      return;
    case 'replaced':
      ticket.revision++;ticket.gates={};ticket.state=REPLACED;ticket.ask=null;ticket.resumeMessage=null;
      ticket.terminal={kind:'replaced',by:settled.by,comment:settled.commentId,at};
      note(ticket,SYSTEM,'sourceChange',`ask ${ask.comment} was settled by replacing the issue with ${settled.by} in comment ${settled.commentId}`,at);
      return;
    case 'reply':{
      const from=askedFrom(state,ticket,ask);
      if(from===null){escalateTicket(ticket,`Ask ${ask.comment} was answered in comment ${settled.commentId}, but the work state it was asked from is unknown.`,at,'escalation');return;}
      note(ticket,SYSTEM,'sourceChange',`ask ${ask.comment} was answered in comment ${settled.commentId}`,at);
      ticket.resumeMessage=settled.text;
      enterTicket(state,ticket,from,facts,at);
      return;
    }
  }
}

/**
 * A work seat's native session has started on its ticket: its implementation issue gets an `impl` marker keyed by
 * that session, and its Project Status moves to in progress unless the source already shows it. The effects belong
 * to no state entry, so a seat that hands off before they run does not cancel them.
 */
export function workerStarted(state:Agenda,started:WorkerStarted,pm:PmContext,facts:Facts):Result<Agenda,DomainError> {
  const next=structuredClone(state),ticket=next.tickets.find(ticket=>ticket.id===started.ticketId);
  if(!ticket)return reject('notFound','Unknown ticket');
  if(ticket.revision!==started.revision)return reject('staleRevision','The seat revision has been superseded');
  const definition=ticketDefinition(next.workflow,ticket);
  if(definition?.kind!=='work'||definition.role!==started.role)return reject('invalidTransition','Only the ticket\u2019s work seat starts its implementation');
  const marker=formatMarker({kind:'impl',json:{v:1,host:pm.host,pid:pm.pid,agenda:next.id,session:started.sessionId,file:started.sessionFile}});
  enqueue(next,ticket.id,{kind:'comment',issue:ticket.issue,body:`工人会话 ${started.sessionId} 开始实现本 issue。\n\n${marker}`,marker:{kind:'impl',key:started.sessionId}},null);
  if(facts.issues.find(issue=>sameRef(issue.ref,ticket.issue))?.pm?.item?.status!==pm.status.inProgress)
    enqueue(next,ticket.id,{kind:'setProjectField',issue:ticket.issue,field:'status',option:pm.status.inProgress},null);
  // The answer to its question, if any, has now reached this seat.
  ticket.resumeMessage=null;
  next.version++;return {ok:true,value:next};
}
/** Every ticket that `next` newly entered into the final state `Done` gets its Project Status set to done. */
export function statusOnDone(previous:Agenda,next:Agenda,pm:PmContext):void {
  if(previous.id!==next.id)return;
  for(const ticket of next.tickets){
    if(ticket.state!=='Done'||ticketDefinition(next.workflow,ticket)?.kind!=='final')continue;
    const before=previous.tickets.find(item=>item.id===ticket.id);
    if((ticket.visits.Done??0)>(before?.visits.Done??0))enqueue(next,ticket.id,{kind:'setProjectField',issue:ticket.issue,field:'status',option:pm.status.done},null);
  }
}

/* ------------------------------------------------------------ operations */

/** Main's resolve may queue only effects outside the delivery flow; the workflow's action states own the rest. */
const RESOLVE_ACTIONS:readonly Action['kind'][]=['replaceBody','createIssue','attachChild','rerunChecks'];
/** Settle the failed or uncertain effects a resolution names; none of the owner's effects may stay unsettled. */
function settleEffects(next:Agenda,operation:Extract<PortInput,{op:'resolve'}>,facts:Facts,at:number):Result<null,DomainError> {
  for(const resolution of operation.effects??[]){
    const effect=next.effects.find(effect=>effect.id===resolution.effectId&&effect.ticketId===operation.ticketId);
    if(!effect||effect.state.kind!=='uncertain'&&effect.state.kind!=='failed')return reject('invalidTransition','Only this ticket’s failed or uncertain effects can be resolved');
    const result=satisfiedResult(next,effect,facts);
    switch(resolution.disposition){
      case 'cancel':effect.state={kind:'cancelled',reason:operation.ruling};break;
      case 'adopt':if(!result)return reject('sourceChanged','Source does not confirm the effect');confirmEffect(next,effect,result,facts,at);break;
      // A source-confirmed effect is adopted. Otherwise a PM record or a guardians request is queued again under its id
      // and intent, and any other effect is cancelled: resolving to its action state requests it afresh.
      case 'retry':
        if(result)confirmEffect(next,effect,result,facts,at);
        else effect.state=RETRY_RESENDS[effect.action.kind]?{kind:'ready'}:{kind:'cancelled',reason:`Main requested a retry: ${operation.ruling}`};
        break;
    }
  }
  if(next.effects.some(effect=>effect.ticketId===operation.ticketId&&(effect.state.kind==='failed'||effect.state.kind==='uncertain'||effect.state.kind==='executing')))return reject('invalidTransition','Resolve every failed or uncertain effect before reopening work on this ticket');
  return {ok:true,value:null};
}
function resolveClosure(next:Agenda,closure:ClosureGate,operation:Extract<PortInput,{op:'resolve'}>,facts:Facts,at:number):Result<null,DomainError> {
  if(operation.add||operation.remove||operation.dependsOn||operation.target||operation.adoptPr!==undefined||operation.noCode||operation.actions)return reject('invalidTransition','Closure resolution accepts only a ruling, a target state and effect dispositions; edit topology on a delivery ticket');
  if(!(operation.to in next.workflow.parent.states))return reject('invalidTransition',`${operation.to} is not a state of the parent workflow`);
  closure.rulings.push({at,summary:operation.ruling});
  const stamp=parentStamp(next,facts);if(!stamp)return reject('sourceChanged','Children are not complete at source');
  closure.stamp=stamp;closure.gates={};
  const settled=settleEffects(next,operation,facts,at);if(!settled.ok)return settled;
  enterParent(next,closure,operation.to,facts,at);
  return closure.state===ESCALATED?reject('invalidTransition',closure.notes.at(-1)??'The parent closure could not enter that state'):{ok:true,value:null};
}
function resolveTicket(next:Agenda,ticket:Ticket,operation:Extract<PortInput,{op:'resolve'}>,facts:Facts,at:number):Result<null,DomainError> {
  // Main may keep an Asking ticket waiting on the guardians, typically to retry its failed request; no other ticket can
  // enter Asking, because only a worker's question carries one.
  const staysAsking=operation.to===ASKING;
  if(staysAsking&&ticket.state!==ASKING)return reject('invalidTransition',`Only a ticket already in ${ASKING} can be resolved to ${ASKING}`);
  const target=staysAsking?null:next.workflow.ticket.states[operation.to];
  if(!staysAsking&&!target)return reject('invalidTransition',`${operation.to} is not a state of the ticket workflow`);
  if(operation.noCode&&!(target?.kind==='final'||target?.kind==='action'&&target.action.kind==='closeIssue'))return reject('invalidTransition','noCode resolves to a closeIssue action state or a final state');
  if(operation.actions?.some(action=>!RESOLVE_ACTIONS.includes(action.kind)))return reject('invalidTransition',`resolve actions are limited to ${RESOLVE_ACTIONS.join(', ')}; the workflow owns publishing, merging and closing`);
  if(operation.add)for(const entry of operation.add){const added=ticketFrom(next,entry,facts,at);if(!added.ok)return added;next.tickets.push(added.value);}
  if(operation.remove){
    for(const id of operation.remove)if(next.effects.some(effect=>effect.ticketId===id&&effect.state.kind!=='confirmed'&&effect.state.kind!=='cancelled'))return reject('invalidTransition','Cannot remove a ticket with unsettled effects');
    next.tickets=next.tickets.filter(item=>!operation.remove!.includes(item.id));
    next.effects=next.effects.filter(effect=>!operation.remove!.includes(effect.ticketId));
    if(!next.tickets.includes(ticket))return reject('invalidTransition','Resolution cannot remove its own ticket');
  }
  if(next.parent){
    const parent=facts.issues.find(issue=>sameRef(issue.ref,next.parent!));
    if(!parent||parent.children.some(child=>!next.tickets.some(item=>sameRef(item.issue,child)))||next.tickets.some(item=>sameRef(item.issue,next.parent!)))return reject('invalidTopology','Every attached child must retain a ticket, and the parent cannot be a delivery ticket');
  }
  const source=facts.issues.find(issue=>sameRef(issue.ref,ticket.issue));if(!source)return reject('sourceUnavailable','Issue contract is unavailable');
  if(source.bodyHash!==ticket.contract.bodyHash)ticket.contract={revision:ticket.contract.revision+1,bodyHash:source.bodyHash,body:source.body};
  ticket.rulings.push({at,summary:operation.ruling});note(ticket,MAIN,'ruling',operation.ruling,at);ticket.gates={};
  if(operation.dependsOn)ticket.dependsOn=operation.dependsOn;
  // A new target needs a checkout of it; a work session forked from the old target would keep the old checkout.
  if(operation.target){if(!sameTarget(operation.target,ticket.target))ticket.sessions={};ticket.target=operation.target;}
  if(operation.adoptPr===null){ticket.pr=null;ticket.terminal=null;}
  else if(operation.adoptPr){
    const pr=facts.prs.find(pr=>sameRef(pr.ref,operation.adoptPr!));
    if(!pr||!sameTarget(pr.target,ticket.target)||pr.closes.length!==1||!sameRef(pr.closes[0]!,ticket.issue))return reject('sourceChanged','Adopted PR does not close this issue at the target');
    ticket.pr={ref:pr.ref,headRepo:pr.headRepo,branch:pr.headBranch,head:pr.head,title:pr.title,body:pr.body};
    ticket.terminal=pr.state.kind==='merged'?{kind:'merged',pr:pr.ref,mergeSha:pr.state.sha,at:pr.state.at}:null;
  }else if(ticket.pr?.ref){
    const pr=sourcePr(ticket,facts);if(pr&&pr.state.kind==='open')ticket.pr={ref:pr.ref,headRepo:pr.headRepo,branch:pr.headBranch,head:pr.head,title:pr.title,body:pr.body};
  }
  if(operation.noCode)ticket.terminal={kind:'noCode',bodyHash:source.bodyHash,reason:operation.noCode,at};
  // A noCode ruling or a replacement holds only where it put the ticket; resolving elsewhere drops it.
  else if(ticket.terminal?.kind==='noCode'||ticket.terminal?.kind==='replaced')ticket.terminal=null;
  const settled=settleEffects(next,operation,facts,at);if(!settled.ok)return settled;
  // Staying in Asking is no new state entry: the revision, the question and the effects it requested stay current.
  if(!staysAsking)enterTicket(next,ticket,operation.to,facts,at);
  if(ticket.state===ESCALATED)return reject('invalidTransition',ticket.notes.at(-1)?.text??'The ticket could not enter that state');
  const landed=ticketDefinition(next.workflow,ticket);
  if(operation.noCode&&!(landed?.kind==='final'||landed?.kind==='action'&&landed.action.kind==='closeIssue'))return reject('invalidTransition',`noCode must land in a closeIssue action state or a final state; the entry condition led to ${ticket.state}`);
  for(const action of operation.actions??[])enqueue(next,operation.ticketId,action,null);
  const topology=validateTopology(next);if(topology)return reject('invalidTopology',topology);
  return {ok:true,value:null};
}

/** `ask` is null while PM integration is off; with it on, a work seat's question waits on the intent guardians instead of Main. */
export function applyOperation(state:Agenda,operation:PortInput,caller:Caller,facts:Facts,at:number,ask:PmAsk|null):Result<Agenda,DomainError> {
  const next=structuredClone(state);
  if(next.lifecycle!=='active')return reject('invalidTransition','Agenda has completed');
  const main=caller.kind==='main'&&next.run.kind==='attached'&&caller.agentId===next.run.mainAgentId&&caller.sessionId===next.run.mainSessionId;
  if(operation.op==='finish'){
    if(!main)return reject('unauthorized','Only the attached Main may finish');
    reconcile(next,facts,at);
    const closure=next.closure,closed=closure?parentDefinition(next.workflow,closure)?.kind==='final':false;
    if(next.tickets.some(ticket=>!delivered(next,ticket))||next.parent&&!closed||next.effects.some(effect=>effect.state.kind!=='confirmed'&&effect.state.kind!=='cancelled'))return reject('invalidTransition','All tickets, effects, and parent closure must be complete');
    next.summary=operation.summary;next.lifecycle='completed';next.version++;return {ok:true,value:next};
  }
  if(!('ticketId' in operation))return reject('invalidTransition','Operation is not a ticket transition');
  const ticket=next.tickets.find(ticket=>ticket.id===operation.ticketId),closure=next.closure?.id===operation.ticketId?next.closure:null;
  if(!ticket&&!closure)return reject('notFound','Unknown ticket');
  if(operation.op==='launch'){
    if(!main)return reject('unauthorized','Only the attached Main launches a ticket');
    if(!ticket)return reject('invalidTransition','The parent closure seats are relayed automatically once every ticket is delivered');
    if(ticket.started)return reject('invalidTransition','This ticket is already launched; Dispatch relays its seats until it is delivered or Escalated');
    const definition=ticketDefinition(next.workflow,ticket);
    if(!definition||definition.kind==='final')return reject('invalidTransition','Resolve an Escalated ticket before launching it; a delivered ticket needs no seat');
    if(!dependenciesDone(next,ticket))return reject('invalidTransition','Every dependency must be delivered before this ticket is launched');
    // The optional role only names a seat the ticket's current state already offers; every such seat starts either way.
    if(operation.role&&!availableRoles(next,ticket).includes(operation.role))return reject('invalidTransition',`This ticket's current state does not offer a ${operation.role} seat`);
    ticket.started=true;next.version++;return {ok:true,value:next};
  }
  if(!('revision' in operation)||operation.revision!==(ticket?.revision??closure?.revision))return reject('staleRevision',caller.kind==='seat'?'This seat revision has been superseded. Exit; Dispatch relays a fresh seat.':'Read the current ticket revision');
  const seat=caller.kind==='seat'&&caller.ticketId===operation.ticketId&&caller.revision===operation.revision;
  if(operation.op==='resolve'){
    if(!main)return reject('unauthorized','Only the attached Main may resolve');
    const resolved=closure?resolveClosure(next,closure,operation,facts,at):resolveTicket(next,ticket!,operation,facts,at);
    if(!resolved.ok)return resolved;
  }else if(operation.op==='submit'){
    const definition=ticket?ticketDefinition(next.workflow,ticket):null;
    if(!seat||caller.kind!=='seat'||!ticket||definition?.kind!=='work'||definition.role!==caller.role||!dependenciesDone(next,ticket))return reject('unauthorized','Only the active runnable work seat may submit');
    if(facts.issues.find(issue=>sameRef(issue.ref,ticket.issue))?.bodyHash!==ticket.contract.bodyHash)return reject('sourceChanged','Issue contract changed');
    if(!exactClosingBody(operation.body,ticket.issue,ticket.target.repo))return reject('invalidTransition','PR body must contain exactly one closing keyword for this issue');
    ticket.pr={ref:ticket.pr?.ref??null,headRepo:ticket.pr?.headRepo??ticket.target.repo,branch:operation.branch,head:operation.head,title:operation.title,body:operation.body};
    ticket.sessions[caller.role]=caller.sessionFile;
    enterTicket(next,ticket,routeTarget(definition.on.submitted,ticketHolds(ticket,facts)),facts,at);
  }else if(operation.op==='escalate'){
    if(!seat||caller.kind!=='seat')return reject('unauthorized','Only the active ticket seat may escalate');
    if(ticket){
      const definition=ticketDefinition(next.workflow,ticket);
      if(!definition||!availableRoles(next,ticket).includes(caller.role))return reject('invalidTransition','Seat is no longer actionable');
      note(ticket,{kind:'seat',role:caller.role},'escalation',`${operation.kind}: ${operation.reason}`,at);
      if(definition.kind==='work'){
        ticket.sessions[caller.role]=caller.sessionFile;
        if(ask&&operation.kind==='question')askTicket(next,ticket,{question:operation.reason,tier:operation.tier??ask.defaultTier,session:caller.sessionId,file:caller.sessionFile});
        else enterTicket(next,ticket,routeTarget(definition.on.escalated,ticketHolds(ticket,facts)),facts,at);
      }
      else if(definition.kind==='judge'){delete ticket.gates[ticket.state];enterTicket(next,ticket,routeTarget(definition.on.escalated,ticketHolds(ticket,facts)),facts,at);}
    }else if(closure&&closureRoles(next).includes(caller.role)){
      const definition=parentDefinition(next.workflow,closure);
      closure.notes.push(`${caller.role} ${operation.kind}: ${operation.reason}`);
      if(definition?.kind==='judge'){delete closure.gates[closure.state];enterParent(next,closure,routeTarget(definition.on.escalated,parentHolds(closure)),facts,at);}
    }else return reject('unauthorized','Seat does not own the closure');
  }else if(operation.op==='verdict'){
    if(!seat||caller.kind!=='seat'||caller.role!==operation.role)return reject('unauthorized','Only the active gate may submit its own verdict');
    if(closure){
      const definition=parentDefinition(next.workflow,closure),gate=closure.gates[closure.state],stamp=parentStamp(next,facts);
      const verdict=gate?.verdicts.find(item=>item.role===operation.role);
      if(definition?.kind!=='judge'||!gate||verdict?.status!=='pending'||!stamp||canonical(stamp)!==canonical(gate.stamp))return reject('sourceChanged','Closure stamp changed or this judge is no longer pending');
      verdict.status=operation.ok?'passed':'failed';verdict.note=operation.note;
      if(!operation.ok){closure.notes.push(operation.note);delete closure.gates[closure.state];enterParent(next,closure,routeTarget(definition.on.rejected,parentHolds(closure)),facts,at);}
      else if(stagePassed(definition.judges,gate.verdicts))enterParent(next,closure,routeTarget(definition.on.passed,parentHolds(closure)),facts,at);
    }else if(ticket){
      const definition=ticketDefinition(next.workflow,ticket),gate=ticket.gates[ticket.state];
      const stamp=definition?.kind!=='judge'?null:definition.subject==='pullRequest'?pullRequestStamp(ticket,facts):mergeCommitStamp(ticket,facts);
      const verdict=gate?.verdicts.find(item=>item.role===operation.role);
      if(definition?.kind!=='judge'||!availableRoles(next,ticket).includes(operation.role)||!gate||verdict?.status!=='pending'||!stamp||canonical(stamp)!==canonical(gate.stamp))return reject('sourceChanged','Gate stamp changed or gate is no longer pending');
      verdict.status=operation.ok?'passed':'failed';verdict.note=operation.note;
      note(ticket,{kind:'seat',role:operation.role},'finding',operation.note,at);
      // Only a passed judge state keeps its approval; a rejected one leaves nothing a later merge or close could use.
      if(!operation.ok){delete ticket.gates[ticket.state];enterTicket(next,ticket,routeTarget(definition.on.rejected,ticketHolds(ticket,facts)),facts,at);}
      else if(stagePassed(definition.judges,gate.verdicts))enterTicket(next,ticket,routeTarget(definition.on.passed,ticketHolds(ticket,facts)),facts,at);
    }
  }else return reject('invalidTransition','Operation does not change a ticket');
  reconcile(next,facts,at);next.version++;return {ok:true,value:next};
}
