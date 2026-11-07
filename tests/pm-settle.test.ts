import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {YAML} from 'bun';
import {draftAgenda,type Agenda,type Caller,type Facts,type PmContext,type PortError,type Result} from '../src/domain/model.ts';
import type {GitHubPort,HostPort,SeatLaunch} from '../src/ports/contracts.ts';
import {encodeAgenda,parseAgenda} from '../src/domain/parse.ts';
import {encodeWorkflow,parseWorkflow} from '../src/domain/workflow.ts';
import {bodyHash} from '../src/domain/identity.ts';
import {parseMarker,type MarkerFact} from '../src/pm/markers.ts';
import {settlement} from '../src/pm/settlement.ts';
import {createAgendaFiles} from '../src/ports/state.ts';
import {Attention} from '../src/runtime/attention.ts';
import {DispatchController,type AgendaView} from '../src/runtime/controller.ts';
import {ProcessTable} from './process-fixture.ts';

const parsedWorkflow=parseWorkflow(YAML.parse(await Bun.file(new URL('../src/default-workflow.yml',import.meta.url)).text()));
if(!parsedWorkflow.ok)throw new Error(parsedWorkflow.error.reason);
const workflow=parsedWorkflow.value;
const repository={owner:'test',name:'dispatch'},issue={repo:repository,number:1},base='2'.repeat(40);
const PM:PmContext={host:'test-host',pid:4242,status:{inProgress:'In Progress',done:'Done'},ask:{defaultTier:'simple',tierHelp:'simple is one detail; complex crosses modules.',resumePrompt:'Your question was answered:'}};
const QUESTION='Should the export be JSON or CSV?',ANSWER='Use JSON, one object per note.';
const MAIN:Extract<Caller,{kind:'main'}>={kind:'main',agentId:'Main',sessionId:'main',sessionFile:null};
function success<T>(value:T):Result<T,PortError>{return {ok:true,value};}
function unexpected():never {throw new Error('Unexpected port call');}
function source():Facts {
  return {viewer:'test',issues:[{ref:issue,body:'Deliver.',bodyHash:bodyHash('Deliver.'),updatedAt:1,state:'open',lastClose:null,lastReopen:null,children:[],pm:{markers:[],item:{id:'item',status:'Todo'}}}],prs:[],links:[],
    repos:[{repo:repository,defaultBranch:'main',defaultHead:base,bases:[{name:'main',state:{kind:'present',head:base,isDefault:true,rules:{required:[],strict:false,constraints:[]}}}]}],
    branches:[],maintenance:[],commits:[],checkAttempts:[],createdIssues:[]};
}
const fact=(id:number,body:string):MarkerFact=>{const read=parseMarker(id,body);if(read.kind!=='marker')throw new Error(`comment ${id} holds no marker`);return read.fact;};
const reply=(id:number,ask:number,text:string)=>fact(id,`${text}\n\n<!-- pm:reply {"v":1,"ask":${ask},"decision":null} -->`);
const replaced=(id:number,ask:number,by:string)=>fact(id,`Replaced by ${by}.\n\n<!-- pm:replaced {"v":1,"ask":${ask},"by":"${by}"} -->`);
const escalated=(id:number,ask:number,agenda:string)=>fact(id,`Taken to the council.\n\n<!-- pm:escalated {"v":1,"ask":${ask},"agenda":"${agenda}"} -->`);

test('only markers naming the waited ask settle it; reply or replaced wins over an earlier escalated, and others are ignored',()=>{
  expect(settlement(10,[fact(9,'<!-- pm:ask {"v":1,"tier":"simple","session":"s"} -->')])).toEqual({settlement:null,ignored:[]});
  expect(settlement(10,[escalated(11,10,'o/agenda#3'),reply(12,10,ANSWER)])).toEqual({settlement:{kind:'reply',text:ANSWER,commentId:12},ignored:[]});
  expect(settlement(10,[escalated(11,10,'o/agenda#3')])).toEqual({settlement:{kind:'escalated',agenda:'o/agenda#3',commentId:11},ignored:[]});
  expect(settlement(10,[escalated(11,10,'o/agenda#3'),replaced(12,10,'o/r#9'),reply(13,10,ANSWER)])).toEqual({settlement:{kind:'replaced',by:'o/r#9',commentId:12},ignored:[]});
  expect(settlement(10,[reply(11,7,'Old answer.'),reply(12,10,ANSWER),escalated(13,10,'o/agenda#3')])).toEqual({settlement:{kind:'reply',text:ANSWER,commentId:12},ignored:[{commentId:11,ask:7}]});
  expect(settlement(10,[fact(14,'<!-- pm:replaced {"v":1,"ask":null,"by":"o/r#9"} -->')])).toEqual({settlement:null,ignored:[{commentId:14,ask:null}]});
  // Comments up to the ask settled earlier asks of the issue: they neither settle this one nor count as ignored.
  expect(settlement(10,[reply(8,7,'Old answer.'),replaced(9,10,'o/r#9'),reply(11,7,'Late answer.')])).toEqual({settlement:null,ignored:[{commentId:11,ask:7}]});
});

type Harness={controller:DispatchController;launches:SeatLaunch[];errors:unknown[];host:HostPort};
/** A PM-on controller over a fake GitHub whose comments become markers, and guardians that accept every request. */
function harness(root:string,facts:Facts,pid:number):Harness {
  let next=5000;
  const pm=():NonNullable<Facts['issues'][number]['pm']>=>facts.issues[0]!.pm!;
  const github:GitHubPort={
    facts:async()=>success(structuredClone(facts)),openPrsByHead:async()=>success([]),contains:async()=>success('contains'),
    comment:async(_issue,body)=>{const id=++next;const read=parseMarker(id,body);if(read.kind==='marker')pm().markers.push(read.fact);return success(id);},
    setProjectField:async(_issue,_field,option)=>{pm().item={id:'item',status:option};return success(null);},
    branchHead:unexpected,issue:unexpected,pr:unexpected,issuesCreatedSince:unexpected,checkAttempt:unexpected,createIssue:unexpected,addSubIssue:unexpected,
    editIssueBody:unexpected,setIssueOpen:unexpected,createPr:unexpected,editPr:unexpected,mergePr:unexpected,rerunCheck:unexpected,
  };
  const launches:SeatLaunch[]=[],errors:unknown[]=[];
  const host:HostPort={agents:async()=>success(null),bind:unexpected,finish:async()=>success(null),dispose:async()=>{},active:()=>false,
    seated:(ticketId,role,revision)=>launches.some(seat=>seat.ticketId===ticketId&&seat.role===role&&seat.revision===revision),
    launch:async input=>{launches.push(input);return success({agentId:`owner-${launches.length}`,sessionId:`session-${launches.length}`,sessionFile:`/data/session-${launches.length}.jsonl`,jobId:`job-${launches.length}`});}};
  const controller=new DispatchController({issue,files:createAgendaFiles(root),github,host,process:new ProcessTable().spawn(pid,`start-${pid}`),cwd:root,workflow:async()=>({ok:true,value:workflow}),
    intervalSeconds:3600,pm:{context:PM,guardians:{requestAnswer:async()=>success(202)}},onChange:()=>{},onError:error=>errors.push(error)});
  controller.setMain(MAIN);
  return {controller,launches,errors,host};
}
const drain=async(controller:DispatchController):Promise<void>=>{for(let round=0;round<6;round++)await controller.run();};
/** The ticket's Owner asked; its ask comment is on the issue and the guardians accepted the request. Returns the ask comment id. */
async function asked(h:Harness,facts:Facts):Promise<number> {
  expect((await h.controller.execute(MAIN,{op:'convene',parent:null,tickets:[{id:'one',issue,target:{repo:repository,base:'main'},dependsOn:[],adoptPr:null}]})).ok).toBe(true);
  expect((await h.controller.execute(MAIN,{op:'launch',ticketId:'one'})).ok).toBe(true);
  await drain(h.controller);
  const revision=h.controller.snapshot()!.tickets[0]!.revision,first=h.launches[0]!;
  const caller:Caller={kind:'seat',agentId:'owner-1',sessionId:'session-1',sessionFile:'/data/session-1.jsonl',ticketId:'one',revision,role:'owner'};
  expect(first.workspace.kind).toBe('base');
  expect((await h.controller.execute(caller,{op:'escalate',ticketId:'one',revision,kind:'question',reason:QUESTION})).ok).toBe(true);
  await drain(h.controller);
  const state=h.controller.snapshot()!;
  expect(state.effects.find(effect=>effect.action.kind==='requestAnswer')?.state.kind).toBe('confirmed');
  return facts.issues[0]!.pm!.markers.find(marker=>marker.kind==='ask')!.id;
}
const impls=(facts:Facts)=>facts.issues[0]!.pm!.markers.flatMap(marker=>marker.kind==='impl'?[marker.json.session]:[]);

test('a reply returns the ticket to Coding within one recompute and forks the asking session with the answer first',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-pm-settle-reply-'));
  const facts=source(),h=harness(root,facts,101);
  try {
    const ask=await asked(h,facts);
    const before=h.controller.snapshot()!.tickets[0]!;
    facts.issues[0]!.pm!.markers.push(reply(9001,ask,ANSWER));
    await h.controller.run();
    const resumed=h.controller.snapshot()!.tickets[0]!;
    expect(resumed).toMatchObject({state:'Coding',revision:before.revision+1,ask:null,resumeMessage:null,sessions:{owner:'/data/session-1.jsonl'}});
    expect(resumed.notes.at(-1)?.text).toBe(`ask ${ask} was answered in comment 9001`);
    expect(h.launches).toHaveLength(2);
    expect(h.launches[1]).toMatchObject({role:'owner',revision:before.revision+1,workspace:{kind:'fork',sessionFile:'/data/session-1.jsonl'},resume:`${PM.ask.resumePrompt}\n\n${ANSWER}`});
    await drain(h.controller);
    expect(impls(facts)).toEqual(['session-1','session-2']);
    expect(new Attention().observe(h.controller.snapshot()!,h.host.active)).toEqual([]);
    // The answer is consumed: a later work seat of the ticket starts without it.
    expect(h.controller.snapshot()!.tickets[0]!.resumeMessage).toBeNull();
    expect(h.errors).toEqual([]);
  }finally {await h.controller.shutdown();await rm(root,{recursive:true,force:true});}
});

test('a replaced ask ends the ticket in Replaced with no new seat, and Main can finish',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-pm-settle-replaced-'));
  const facts=source(),h=harness(root,facts,101);
  try {
    const ask=await asked(h,facts);
    facts.issues[0]!.pm!.markers.push(replaced(9002,ask,'test/dispatch#7'));
    facts.issues[0]!.state='closed';
    await drain(h.controller);
    const state=h.controller.snapshot()!;
    expect(state.tickets[0]).toMatchObject({state:'Replaced',ask:null,terminal:{kind:'replaced',by:'test/dispatch#7',comment:9002}});
    expect(h.launches).toHaveLength(1);
    expect(state.effects.every(effect=>effect.state.kind==='confirmed'||effect.state.kind==='cancelled')).toBe(true);
    expect(new Attention().observe(state,h.host.active)).toEqual(['finish']);
    expect(parseAgenda(JSON.parse(JSON.stringify(encodeAgenda(draftAgenda(state))))).ok).toBe(true);
    const finished=await h.controller.execute(MAIN,{op:'finish',summary:'The issue was replaced.'});
    expect(finished.ok).toBe(true);
    expect(h.errors).toEqual([]);
  }finally {await h.controller.shutdown();await rm(root,{recursive:true,force:true});}
});

test('an escalated ask keeps waiting with its council agenda in status, then a reply resumes it',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-pm-settle-escalated-'));
  const facts=source(),h=harness(root,facts,101);
  try {
    const ask=await asked(h,facts);
    facts.issues[0]!.pm!.markers.push(escalated(9003,ask,'test/agenda#4'));
    await drain(h.controller);
    const waiting=h.controller.snapshot()!;
    expect(waiting.tickets[0]).toMatchObject({state:'Asking',ask:{comment:ask,agenda:'test/agenda#4'}});
    const status=await h.controller.execute(MAIN,{op:'status'});
    expect(status.ok&&(status.value as AgendaView).asking).toEqual([{ticketId:'one',question:QUESTION,comment:ask,agenda:'test/agenda#4'}]);
    expect(h.launches).toHaveLength(1);
    expect(new Attention().observe(waiting,h.host.active)).toEqual([]);
    facts.issues[0]!.pm!.markers.push(reply(9004,ask,ANSWER));
    await h.controller.run();
    expect(h.controller.snapshot()!.tickets[0]).toMatchObject({state:'Coding',ask:null});
    expect(h.launches[1]).toMatchObject({workspace:{kind:'fork',sessionFile:'/data/session-1.jsonl'},resume:`${PM.ask.resumePrompt}\n\n${ANSWER}`});
  }finally {await h.controller.shutdown();await rm(root,{recursive:true,force:true});}
});

test('an earlier answer on the issue is skipped silently; a later settlement of another ask is noted once, and the right reply still resumes it',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-pm-settle-ignored-'));
  const facts=source(),h=harness(root,facts,101);
  try {
    const ask=await asked(h,facts);
    // The reply to an older ask of this issue, posted before the current ask.
    facts.issues[0]!.pm!.markers.unshift(reply(4000,3999,'An answer to the earlier question.'));
    await drain(h.controller);
    expect(h.controller.snapshot()!.tickets[0]!.notes.filter(note=>note.text.startsWith('ignored settlement'))).toEqual([]);
    facts.issues[0]!.pm!.markers.push(reply(9005,ask+100,'An answer to something else.'));
    await drain(h.controller);
    const waiting=h.controller.snapshot()!.tickets[0]!;
    expect(waiting.state).toBe('Asking');
    expect(waiting.notes.filter(note=>note.text.startsWith('ignored settlement')).map(note=>note.text)).toEqual([`ignored settlement 9005 for ask ${ask+100}`]);
    expect(h.launches).toHaveLength(1);
    facts.issues[0]!.pm!.markers.push(reply(9006,ask,ANSWER));
    await h.controller.run();
    const resumed=h.controller.snapshot()!.tickets[0]!;
    expect(resumed.state).toBe('Coding');
    expect(resumed.notes.filter(note=>note.text.startsWith('ignored settlement'))).toHaveLength(1);
    expect(h.launches[1]?.resume).toBe(`${PM.ask.resumePrompt}\n\n${ANSWER}`);
  }finally {await h.controller.shutdown();await rm(root,{recursive:true,force:true});}
});

test('a question recorded before Dispatch kept its work state loads unchanged and returns to its role\'s work state',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-pm-settle-legacy-'));
  const facts=source(),h=harness(root,facts,101);
  try {
    const ask=await asked(h,facts);
    await h.controller.shutdown();
    // Rewrite the agenda file as an earlier Dispatch wrote it: no work state on the question, no answer on the ticket.
    const saved=await createAgendaFiles(root).list();if(!saved.ok)throw new Error(saved.error.message);
    const agenda=saved.value[0]!;
    const {resumeMessage:_answer,...ticket}=agenda.tickets[0]!,{from:_from,agenda:_council,...question}=ticket.ask!;
    const legacy={...agenda,workflow:encodeWorkflow(agenda.workflow),tickets:[{...ticket,ask:question}]};
    await Bun.write(join(root,'state',`${agenda.id}.json`),`${JSON.stringify({format:9,state:legacy})}\n`);
    const parsed=parseAgenda(JSON.parse(JSON.stringify(legacy)));
    if(!parsed.ok)throw new Error(parsed.error.reason);
    expect(parsed.value.tickets[0]).toMatchObject({state:'Asking',resumeMessage:null,ask:{from:null,agenda:null,comment:ask}});
    const second=harness(root,facts,102);
    try {
      expect((await second.controller.execute(MAIN,{op:'resume',agenda:agenda.id})).ok).toBe(true);
      facts.issues[0]!.pm!.markers.push(reply(9007,ask,ANSWER));
      await second.controller.run();
      expect(second.controller.snapshot()!.tickets[0]).toMatchObject({state:'Coding',ask:null});
      expect(second.launches[0]).toMatchObject({workspace:{kind:'fork',sessionFile:'/data/session-1.jsonl'},resume:`${PM.ask.resumePrompt}\n\n${ANSWER}`});
    }finally {await second.controller.shutdown();}
  }finally {await rm(root,{recursive:true,force:true});}
});
