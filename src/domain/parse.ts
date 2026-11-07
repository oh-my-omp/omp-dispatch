import type {ZodLikeSchema} from '@oh-my-pi/omptype/zod';
import {agendaSchema,toolParametersSchema,type Agenda,type ParseError,type Result,type ToolParameters} from './model.ts';
import {ASKING,ESCALATED,REPLACED,encodeWorkflow,parseWorkflow,verdictsMatch} from './workflow.ts';
import {sameRef} from './identity.ts';

function parse<T>(schema:ZodLikeSchema<T>,value:unknown):Result<T,ParseError> {
  const parsed=schema.safeParse(value);
  if(parsed.success)return {ok:true,value:parsed.data};
  const first=parsed.error.issues[0];
  return {ok:false,error:{path:first?.path.join('.')??'',reason:first?.message??'Invalid input'}};
}
export function parseToolParameters(value:unknown):Result<ToolParameters,ParseError>{return parse(toolParametersSchema,value);}

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
