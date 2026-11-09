import type {ZodLikeSchema} from '@oh-my-pi/omptype/zod';
import type {z} from '@oh-my-pi/omptype/zod';
import {agendaSchema,actionSchema,portInputSchema,seatToolParametersSchema,toolParametersSchema,type Action,type Agenda,type Entry,type IssueRef,type ParseError,type PortInput,type Repo,type Result,type Target,type ToolParameters} from './model.ts';
import {ASKING,ESCALATED,REPLACED,encodeWorkflow,parseWorkflow,verdictsMatch} from './workflow.ts';
import {parseIssueReference,parseRepoReference,parseTargetReference,sameRef} from './identity.ts';

type MainInput = z.infer<typeof toolParametersSchema>['input'];
type SeatInput = z.infer<typeof seatToolParametersSchema>['input'];
type WireEntry = MainInput['tickets'] extends readonly (infer Item)[]|undefined ? Item : never;
type WireAction = NonNullable<MainInput['actions']>[number];
type ActionKind = Action['kind'];

function parse<T>(schema:ZodLikeSchema<T>,value:unknown,path=''):Result<T,ParseError> {
  const parsed=schema.safeParse(value);
  if(parsed.success)return {ok:true,value:parsed.data};
  const first=parsed.error.issues[0];
  const at=first?.path.join('.')??'';
  return {ok:false,error:{path:[path,at].filter(part=>part.length>0).join('.'),reason:first?.message??'Invalid input'}};
}

function failure<T>(path:string,reason:string):Result<T,ParseError>{return {ok:false,error:{path,reason}};}
/** Drops fields the caller did not supply, so the domain schemas report a missing required field by name. */
function compact(fields:Record<string,unknown>):Record<string,unknown> {return Object.fromEntries(Object.entries(fields).filter(([,value])=>value!==undefined));}

function issueRef(value:string|undefined,field:string):Result<IssueRef,ParseError> {
  if(value===undefined)return failure(field,`${field} is required`);
  const parsed=parseIssueReference(value);
  return parsed.ok?{ok:true,value:parsed.value}:failure(field,parsed.error);
}
function repoRef(value:string|undefined,field:string):Result<Repo,ParseError> {
  if(value===undefined)return failure(field,`${field} is required`);
  const parsed=parseRepoReference(value);
  return parsed.ok?{ok:true,value:parsed.value}:failure(field,parsed.error);
}
function targetRef(value:string|undefined,field:string):Result<Target,ParseError> {
  if(value===undefined)return failure(field,`${field} is required`);
  const parsed=parseTargetReference(value);
  return parsed.ok?{ok:true,value:parsed.value}:failure(field,parsed.error);
}

/** Fields each operation accepts, so a field borrowed from another operation is refused here rather than by the domain union. */
const MAIN_FIELDS:{
  convene:readonly string[];resume:readonly string[];tickets:readonly string[];status:readonly string[];
  read:readonly string[];launch:readonly string[];resolve:readonly string[];finish:readonly string[];
}={convene:['parent','tickets'],resume:['agenda'],tickets:[],status:[],read:['ticketId'],launch:['ticketId','role'],
  resolve:['ticketId','revision','ruling','to','dependsOn','target','adoptPr','clearAdoptPr','noCode','add','remove','effects','actions'],
  finish:['summary']};
const SEAT_FIELDS:{read:readonly string[];submit:readonly string[];verdict:readonly string[];escalate:readonly string[]}=
  {read:['ticketId'],submit:['ticketId','revision','branch','head','title','body'],verdict:['ticketId','revision','role','ok','note'],
    escalate:['ticketId','revision','kind','reason','tier']};
const ACTION_FIELDS:Record<ActionKind,readonly string[]>={
  publishPr:['issue','headRepo','branch','head','target','pr','expectedBodyHash','title','body'],
  merge:['issue','pr','head','target','stampHash'],
  setIssueState:['issue','open','bodyHash','afterEvent'],
  replaceBody:['issue','expectedHash','body'],
  createIssue:['repo','title','body'],
  attachChild:['parent','child'],
  rerunChecks:['pr','repo','workflowRunId','previousAttempt','head'],
  comment:['issue','body','markerKind','markerKey'],
  setProjectField:['issue','field','option'],
  requestAnswer:['issue','comment','question','tier'],
};

function foreignField(value:Record<string,unknown>,allowed:readonly string[],path:string):ParseError|null {
  for(const key of Object.keys(value))if(key!=='op'&&key!=='kind'&&!allowed.includes(key))return {path:[path,key].filter(part=>part.length>0).join('.'),reason:`${key} does not belong to ${String(value.op??value.kind)}`};
  return null;
}

function entry(value:WireEntry,path:string):Result<Entry,ParseError> {
  const issue=issueRef(value.issue,`${path}.issue`);if(!issue.ok)return issue;
  const target=targetRef(value.target,`${path}.target`);if(!target.ok)return target;
  const adoptPr=value.adoptPr===undefined?null:issueRef(value.adoptPr,`${path}.adoptPr`);
  if(adoptPr!==null&&!adoptPr.ok)return adoptPr;
  return {ok:true,value:{id:value.id,issue:issue.value,target:target.value,dependsOn:value.dependsOn,adoptPr:adoptPr===null?null:adoptPr.value}};
}
function entries(values:readonly WireEntry[],path:string):Result<Entry[],ParseError> {
  const collected:Entry[]=[];
  for(let index=0;index<values.length;index++){
    const item=entry(values[index]!,`${path}.${index}`);
    if(!item.ok)return item;
    collected.push(item.value);
  }
  return {ok:true,value:collected};
}

function action(value:WireAction,path:string):Result<Action,ParseError> {
  const foreign=foreignField(value as unknown as Record<string,unknown>,ACTION_FIELDS[value.kind],path);
  if(foreign)return {ok:false,error:foreign};
  const at=(field:string)=>`${path}.${field}`;
  switch(value.kind){
    case 'publishPr':{
      const issue=issueRef(value.issue,at('issue'));if(!issue.ok)return issue;
      const headRepo=repoRef(value.headRepo,at('headRepo'));if(!headRepo.ok)return headRepo;
      const target=targetRef(value.target,at('target'));if(!target.ok)return target;
      const pr=value.pr===undefined?null:issueRef(value.pr,at('pr'));
      if(pr!==null&&!pr.ok)return pr;
      return parse(actionSchema,compact({kind:'publishPr',issue:issue.value,headRepo:headRepo.value,branch:value.branch,head:value.head,target:target.value,
        pr:pr===null?null:pr.value,expectedBodyHash:value.expectedBodyHash??null,title:value.title,body:value.body}),path);
    }
    case 'merge':{
      const issue=issueRef(value.issue,at('issue'));if(!issue.ok)return issue;
      const pr=issueRef(value.pr,at('pr'));if(!pr.ok)return pr;
      const target=targetRef(value.target,at('target'));if(!target.ok)return target;
      return parse(actionSchema,compact({kind:'merge',issue:issue.value,pr:pr.value,head:value.head,target:target.value,stampHash:value.stampHash}),path);
    }
    case 'setIssueState':{
      const issue=issueRef(value.issue,at('issue'));if(!issue.ok)return issue;
      return parse(actionSchema,compact({kind:'setIssueState',issue:issue.value,open:value.open,bodyHash:value.bodyHash,afterEvent:value.afterEvent??null}),path);
    }
    case 'replaceBody':{
      const issue=issueRef(value.issue,at('issue'));if(!issue.ok)return issue;
      return parse(actionSchema,compact({kind:'replaceBody',issue:issue.value,expectedHash:value.expectedHash,body:value.body}),path);
    }
    case 'createIssue':{
      const repo=repoRef(value.repo,at('repo'));if(!repo.ok)return repo;
      return parse(actionSchema,compact({kind:'createIssue',repo:repo.value,title:value.title,body:value.body}),path);
    }
    case 'attachChild':{
      const parent=issueRef(value.parent,at('parent'));if(!parent.ok)return parent;
      const child=issueRef(value.child,at('child'));if(!child.ok)return child;
      return parse(actionSchema,{kind:'attachChild',parent:parent.value,child:child.value},path);
    }
    case 'rerunChecks':{
      const pr=issueRef(value.pr,at('pr'));if(!pr.ok)return pr;
      const repo=repoRef(value.repo,at('repo'));if(!repo.ok)return repo;
      return parse(actionSchema,compact({kind:'rerunChecks',pr:pr.value,repo:repo.value,workflowRunId:value.workflowRunId,previousAttempt:value.previousAttempt,head:value.head}),path);
    }
    case 'comment':{
      const issue=issueRef(value.issue,at('issue'));if(!issue.ok)return issue;
      return parse(actionSchema,compact({kind:'comment',issue:issue.value,body:value.body,marker:{kind:value.markerKind,key:value.markerKey}}),path);
    }
    case 'setProjectField':{
      const issue=issueRef(value.issue,at('issue'));if(!issue.ok)return issue;
      return parse(actionSchema,compact({kind:'setProjectField',issue:issue.value,field:value.field,option:value.option}),path);
    }
    case 'requestAnswer':{
      const issue=issueRef(value.issue,at('issue'));if(!issue.ok)return issue;
      return parse(actionSchema,compact({kind:'requestAnswer',issue:issue.value,comment:value.comment,question:value.question,tier:value.tier}),path);
    }
  }
}
function actions(values:readonly WireAction[],path:string):Result<Action[],ParseError> {
  const collected:Action[]=[];
  for(let index=0;index<values.length;index++){
    const item=action(values[index]!,`${path}.${index}`);
    if(!item.ok)return item;
    collected.push(item.value);
  }
  return {ok:true,value:collected};
}

function mainInput(value:MainInput):Result<PortInput,ParseError> {
  const foreign=foreignField(value as unknown as Record<string,unknown>,MAIN_FIELDS[value.op],'');
  if(foreign)return {ok:false,error:foreign};
  switch(value.op){
    case 'convene':{
      const parent=value.parent===undefined?null:issueRef(value.parent,'parent');
      if(parent!==null&&!parent.ok)return parent;
      const tickets=value.tickets===undefined?undefined:entries(value.tickets,'tickets');
      if(tickets!==undefined&&!tickets.ok)return tickets;
      return parse(portInputSchema,compact({op:'convene',parent:parent===null?null:parent.value,tickets:tickets?.value}),'');
    }
    case 'resume':return parse(portInputSchema,compact({op:'resume',agenda:value.agenda}),'');
    case 'tickets':case 'status':return parse(portInputSchema,{op:value.op},'');
    case 'read':return parse(portInputSchema,compact({op:'read',ticketId:value.ticketId}),'');
    case 'launch':return parse(portInputSchema,compact({op:'launch',ticketId:value.ticketId,role:value.role}),'');
    case 'finish':return parse(portInputSchema,compact({op:'finish',summary:value.summary}),'');
    case 'resolve':{
      const target=value.target===undefined?undefined:targetRef(value.target,'target');
      if(target!==undefined&&!target.ok)return target;
      const adoptPr=value.clearAdoptPr===true
        ?value.adoptPr===undefined?{ok:true as const,value:null}:failure<IssueRef|null>('adoptPr','adoptPr and clearAdoptPr cannot be combined')
        :value.adoptPr===undefined?undefined:issueRef(value.adoptPr,'adoptPr');
      if(adoptPr!==undefined&&!adoptPr.ok)return adoptPr;
      const add=value.add===undefined?undefined:entries(value.add,'add');
      if(add!==undefined&&!add.ok)return add;
      const enqueued=value.actions===undefined?undefined:actions(value.actions,'actions');
      if(enqueued!==undefined&&!enqueued.ok)return enqueued;
      return parse(portInputSchema,compact({op:'resolve',ticketId:value.ticketId,revision:value.revision,ruling:value.ruling,to:value.to,
        dependsOn:value.dependsOn,target:target?.value,adoptPr:adoptPr?.value,noCode:value.noCode,add:add?.value,remove:value.remove,
        effects:value.effects,actions:enqueued?.value}),'');
    }
  }
}

function seatInput(value:SeatInput):Result<PortInput,ParseError> {
  const foreign=foreignField(value as unknown as Record<string,unknown>,SEAT_FIELDS[value.op],'');
  if(foreign)return {ok:false,error:foreign};
  switch(value.op){
    case 'read':return parse(portInputSchema,compact({op:'read',ticketId:value.ticketId}),'');
    case 'submit':return parse(portInputSchema,compact({op:'submit',ticketId:value.ticketId,revision:value.revision,branch:value.branch,head:value.head,title:value.title,body:value.body}),'');
    case 'verdict':return parse(portInputSchema,compact({op:'verdict',ticketId:value.ticketId,revision:value.revision,role:value.role,ok:value.ok,note:value.note}),'');
    case 'escalate':return parse(portInputSchema,compact({op:'escalate',ticketId:value.ticketId,revision:value.revision,kind:value.kind,reason:value.reason,tier:value.tier}),'');
  }
}

/** Parse Main's wire parameters into the existing port input. */
export function parseToolParameters(value:unknown):Result<ToolParameters,ParseError> {
  const wire=parse(toolParametersSchema,value);
  if(!wire.ok)return wire;
  const input=mainInput(wire.value.input);
  return input.ok?{ok:true,value:{input:input.value}}:input;
}
/** Parse a seat's wire parameters into the existing port input; the seat definition carries only seat operations. */
export function parseSeatToolParameters(value:unknown):Result<ToolParameters,ParseError> {
  const wire=parse(seatToolParametersSchema,value);
  if(!wire.ok)return wire;
  const input=seatInput(wire.value.input);
  return input.ok?{ok:true,value:{input:input.value}}:input;
}

/** Validate graph integrity at the file/input boundary, not at each internal read. */
export function validateTopology(state:Pick<Agenda,'tickets'>):string|null {
  const byId=new Map(state.tickets.map(ticket=>[ticket.id,ticket]));
  if(byId.size!==state.tickets.length)return 'Ticket IDs must be unique';
  const issues=new Set<string>();
  for(const ticket of state.tickets){
    const key=`${ticket.issue.repo.owner}/${ticket.issue.repo.name}#${ticket.issue.number}`.toLowerCase();
    if(issues.has(key))return 'Each issue must have exactly one ticket';
    issues.add(key);
    if(new Set(ticket.dependsOn).size!==ticket.dependsOn.length)return `Duplicate dependency on ${ticket.id}`;
    for(const dependency of ticket.dependsOn)if(!byId.has(dependency))return `Unknown dependency ${dependency}`;
  }
  const visited=new Set<string>(),visiting=new Set<string>();
  function visit(id:string):boolean {
    if(visiting.has(id))return false;
    if(visited.has(id))return true;
    visiting.add(id);
    for(const dependency of byId.get(id)?.dependsOn??[])if(!visit(dependency))return false;
    visiting.delete(id);visited.add(id);return true;
  }
  for(const ticket of state.tickets)if(!visit(ticket.id))return 'Ticket dependencies must be acyclic';
  return null;
}
/** The persisted form of an agenda: its frozen workflow in file shape. */
export function encodeAgenda(agenda:Agenda):unknown {return {...agenda,workflow:encodeWorkflow(agenda.workflow)};}
/** Decode a persisted agenda; every recorded state, gate and session must belong to the workflow frozen in it. */
export function parseAgenda(value:unknown):Result<Agenda,ParseError> {
  const parsed=parse(agendaSchema,value);if(!parsed.ok)return parsed;
  const workflow=parseWorkflow(parsed.value.workflow);
  if(!workflow.ok)return {ok:false,error:{path:`workflow.${workflow.error.path}`,reason:workflow.error.reason}};
  const agenda:Agenda={...parsed.value,workflow:workflow.value};
  const topology=validateTopology(agenda);
  if(topology)return {ok:false,error:{path:'tickets',reason:topology}};
  const ids=new Set(agenda.effects.map(effect=>effect.id));
  if(ids.size!==agenda.effects.length)return {ok:false,error:{path:'effects',reason:'Effect IDs must be unique'}};
  for(const effect of agenda.effects){
    const ticket=agenda.tickets.some(ticket=>ticket.id===effect.ticketId),closure=effect.ticketId===agenda.closure?.id;
    if(!ticket&&!closure)return {ok:false,error:{path:'effects',reason:'Effect must belong to a ticket or closure'}};
    // A ticket's question effects are requested by its built-in Asking entry; every other origin is a workflow state.
    const states=ticket?workflow.value.ticket.states:workflow.value.parent.states;
    if(effect.origin&&!(effect.origin.state in states)&&!(ticket&&effect.origin.state===ASKING))return {ok:false,error:{path:'effects',reason:`Effect ${effect.id} was requested by ${effect.origin.state}, which the agenda workflow does not define`}};
  }
  const ticketStates=workflow.value.ticket.states,parentStates=workflow.value.parent.states;
  for(const ticket of agenda.tickets){
    const fail=(reason:string):Result<Agenda,ParseError>=>({ok:false,error:{path:'tickets',reason:`Ticket ${ticket.id} ${reason}`}});
    if(ticket.state!==ESCALATED&&ticket.state!==ASKING&&ticket.state!==REPLACED&&!(ticket.state in ticketStates))return fail(`is in ${ticket.state}, which the agenda workflow does not define`);
    if((ticket.state===ASKING)!==(ticket.ask!==null))return fail(ticket.ask?`records a question outside ${ASKING}`:`is ${ASKING} without its question`);
    if((ticket.state===REPLACED)!==(ticket.terminal?.kind==='replaced'))return fail(ticket.state===REPLACED?`is ${REPLACED} without the replacement`:`records a replacement outside ${REPLACED}`);
    if(ticket.ask&&ticket.ask.from!==null&&ticketStates[ticket.ask.from]?.kind!=='work')return fail(`asked from ${ticket.ask.from}, which is not a work state of the agenda workflow`);
    for(const [name,gate] of Object.entries(ticket.gates)){
      const state=ticketStates[name];
      if(state?.kind!=='judge'||state.subject!==gate.stamp.kind||!verdictsMatch(state.judges,gate.verdicts))return fail(`holds a ${name} gate that does not match the agenda workflow`);
    }
    for(const role of Object.keys(ticket.sessions))if(!Object.values(ticketStates).some(state=>state.kind==='work'&&state.role===role))return fail(`holds a session for ${role}, which is not a work role`);
    for(const name of Object.keys(ticket.visits))if(!(name in ticketStates))return fail(`counts visits to ${name}, which the agenda workflow does not define`);
  }
  const closure=agenda.closure;
  if(closure){
    const fail=(reason:string):Result<Agenda,ParseError>=>({ok:false,error:{path:'closure',reason:`Closure ${reason}`}});
    if(!agenda.parent||!sameRef(closure.stamp.parent,agenda.parent))return fail('belongs to no parent of this agenda');
    if(closure.state!==ESCALATED&&!(closure.state in parentStates))return fail(`is in ${closure.state}, which the agenda workflow does not define`);
    for(const name of Object.keys(closure.visits))if(!(name in parentStates))return fail(`counts visits to ${name}, which the agenda workflow does not define`);
    for(const [name,gate] of Object.entries(closure.gates)){
      const state=parentStates[name];
      if(state?.kind!=='judge'||!verdictsMatch(state.judges,gate.verdicts))return fail(`holds a ${name} gate that does not match the agenda workflow`);
    }
  }
  return {ok:true,value:agenda};
}
