import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {YAML} from 'bun';
import type {Agenda,Caller,Facts,MeerkatContext,PortError,Result} from '../src/domain/model.ts';
import type {AskRequest,GitHubPort,GuardiansPort,HostPort,SeatLaunch} from '../src/ports/contracts.ts';
import {applyOperation,createAgenda} from '../src/domain/engine.ts';
import {checkedReconcile as reconcile} from './reconcile-check.ts';
import {bodyHash} from '../src/domain/identity.ts';
import {parseAgenda,parseToolParameters,encodeAgenda} from '../src/domain/parse.ts';
import {parseWorkflow} from '../src/domain/workflow.ts';
import {parseMarker} from '../src/meerkat/markers.ts';
import {createAgendaFiles} from '../src/ports/state.ts';
import {createGuardiansPort} from '../src/ports/guardians.ts';
import {Attention} from '../src/runtime/attention.ts';
import {DispatchController,type AgendaView} from '../src/runtime/controller.ts';
import {ProcessTable} from './process-fixture.ts';

const parsedWorkflow=parseWorkflow(YAML.parse(await Bun.file(new URL('../src/default-workflow.yml',import.meta.url)).text()));
if(!parsedWorkflow.ok)throw new Error(parsedWorkflow.error.reason);
const workflow=parsedWorkflow.value;
const repository={owner:'test',name:'dispatch'},issue={repo:repository,number:1},base='2'.repeat(40);
const MEERKAT:MeerkatContext={host:'test-host',pid:4242,status:{inProgress:'In Progress',done:'Done'},ask:{defaultTier:'simple',tierHelp:'simple is one detail; complex crosses modules.',resumePrompt:'Your question was answered:'}};
const QUESTION='Should the cache key include the tenant id?';
function source():Facts {
  return {viewer:'test',issues:[{ref:issue,body:'Deliver.',bodyHash:bodyHash('Deliver.'),updatedAt:1,state:'open',lastClose:null,lastReopen:null,children:[],meerkat:{markers:[],item:{id:'item',status:'Todo'}}}],prs:[],links:[],
    repos:[{repo:repository,defaultBranch:'main',defaultHead:base,bases:[{name:'main',state:{kind:'present',head:base,isDefault:true,rules:{required:[],strict:false,constraints:[]}}}]}],
    branches:[],maintenance:[],commits:[],checkAttempts:[],createdIssues:[]};
}
function success<T>(value:T):Result<T,PortError>{return {ok:true,value};}
function unexpected():never {throw new Error('Unexpected port call');}
const owner=(revision:number):Caller=>({kind:'seat',agentId:'owner-1',sessionId:'session-1',sessionFile:'/data/session-1.jsonl',ticketId:'one',revision,role:'owner'});

/** An attached agenda whose Owner is seated in Coding. */
function seated(facts:Facts):Agenda {
  const created=createAgenda({op:'convene',parent:null,tickets:[{id:'one',issue,target:{repo:repository,base:'main'},dependsOn:[],adoptPr:null}]},workflow,facts,1,'00000000-0000-4000-8000-000000000002');
  if(!created.ok)throw new Error(created.error.message);
  const agenda=created.value;agenda.tickets[0]!.started=true;
  agenda.run={kind:'attached',id:'run',mainAgentId:'Main',mainSessionId:'main',pid:101,startedAt:'Sat Nov 7 06:00:00 2026'};
  return agenda;
}
function applied(result:Result<Agenda,{message:string}>):Agenda {if(!result.ok)throw new Error(result.error.message);return result.value;}

test('only a question carries a tier',()=>{
  const escalate={op:'escalate',ticketId:'one',revision:1,reason:'Which?'};
  expect(parseToolParameters({input:{...escalate,kind:'question',tier:'complex'}}).ok).toBe(true);
  expect(parseToolParameters({input:{...escalate,kind:'question'}}).ok).toBe(true);
  expect(parseToolParameters({input:{...escalate,kind:'question',tier:'urgent'}}).ok).toBe(false);
  for(const kind of ['blocked','split','noCode'])expect(parseToolParameters({input:{...escalate,kind,tier:'simple'}}).ok).toBe(false);
});

test('under Meerkat an Owner question waits in Asking with an ask comment; Meerkat off and other kinds still reach Main',()=>{
  const facts=source(),agenda=seated(facts),revision=agenda.tickets[0]!.revision;
  const question={op:'escalate',ticketId:'one',revision,kind:'question',reason:QUESTION} as const;
  const asked=applied(applyOperation(agenda,question,owner(revision),facts,2,MEERKAT.ask));
  const ticket=asked.tickets[0]!;
  expect(ticket).toMatchObject({state:'Asking',revision:revision+1,sessions:{owner:'/data/session-1.jsonl'},
    ask:{question:QUESTION,tier:'simple',session:'session-1',file:'/data/session-1.jsonl',comment:null}});
  expect(ticket.notes.at(-1)).toMatchObject({author:{kind:'seat',role:'owner'},kind:'escalation',text:`question: ${QUESTION}`});
  expect(asked.effects.map(effect=>({action:effect.action,origin:effect.origin}))).toEqual([{origin:{state:'Asking',revision:revision+1},
    action:{kind:'comment',issue,marker:{kind:'ask',key:'session-1'},body:`${QUESTION}\n\n<!-- meerkat:ask {"v":1,"tier":"simple","session":"session-1"} -->`}}]);
  // Asking seats nobody and asks nothing of Main; it survives a save and reload.
  expect(new Attention().observe(asked,()=>false)).toEqual([]);
  expect(parseAgenda(JSON.parse(JSON.stringify(encodeAgenda(asked)))).ok).toBe(true);
  const tiered=applied(applyOperation(agenda,{...question,tier:'complex'},owner(revision),facts,2,MEERKAT.ask));
  expect(tiered.tickets[0]!.ask?.tier).toBe('complex');
  // Result 5: without Meerkat a question, and with Meerkat a blocker, split or noCode, still escalate to Main.
  expect(applied(applyOperation(agenda,question,owner(revision),facts,2,null)).tickets[0]).toMatchObject({state:'Escalated',ask:null});
  for(const kind of ['blocked','split','noCode'] as const)
    expect(applied(applyOperation(agenda,{op:'escalate',ticketId:'one',revision,kind,reason:'r'},owner(revision),facts,2,MEERKAT.ask)).tickets[0]).toMatchObject({state:'Escalated',ask:null});
});

test('a confirmed ask comment records its id and asks the guardians exactly once; Main may still resolve the ticket out of Asking',()=>{
  const facts=source(),agenda=seated(facts),revision=agenda.tickets[0]!.revision;
  const asked=applied(applyOperation(agenda,{op:'escalate',ticketId:'one',revision,kind:'question',reason:QUESTION,tier:'complex'},owner(revision),facts,2,MEERKAT.ask));
  // The comment is not on GitHub yet: nothing chains.
  reconcile(asked,facts,3);
  expect(asked.effects.map(effect=>effect.action.kind)).toEqual(['comment']);
  facts.issues[0]!.meerkat!.markers.push({id:900,kind:'ask',json:{v:1,tier:'complex',session:'session-1'}});
  asked.effects[0]!.state={kind:'confirmed',result:{kind:'commented',issue,comment:900}};
  reconcile(asked,facts,4);reconcile(asked,facts,5);
  expect(asked.tickets[0]!.ask?.comment).toBe(900);
  expect(asked.effects.map(effect=>effect.action)).toEqual([expect.objectContaining({kind:'comment'}),{kind:'requestAnswer',issue,comment:900,question:QUESTION,tier:'complex'}]);
  const ruled=applied(applyOperation(asked,{op:'resolve',ticketId:'one',revision:revision+1,ruling:'Main rules instead.',to:'Coding'},{kind:'main',agentId:'Main',sessionId:'main',sessionFile:null},facts,6,MEERKAT.ask));
  expect(ruled.tickets[0]).toMatchObject({state:'Coding',ask:null});
  expect(ruled.effects[1]!.state).toEqual({kind:'cancelled',reason:'The state that requested this effect has been left'});
});

type Harness={controller:DispatchController;launches:SeatLaunch[];asks:AskRequest[];errors:unknown[];host:HostPort};
function harness(root:string,facts:Facts,processes:ProcessTable,pid:number,guardians:(request:AskRequest)=>Promise<Result<200|202,PortError>>):Harness {
  const markers=():NonNullable<Facts['issues'][number]['meerkat']>=>facts.issues[0]!.meerkat!;
  let next=5000;
  const github:GitHubPort={
    facts:async()=>success(structuredClone(facts)),openPrsByHead:async()=>success([]),contains:async()=>success('contains'),
    comment:async(_issue,body)=>{const id=++next;const parsed=parseMarker(id,body);if(parsed.kind==='marker')markers().markers.push(parsed.fact);return success(id);},
    setProjectField:async(_issue,_field,option)=>{markers().item={id:'item',status:option};return success(null);},
    branchHead:unexpected,issue:unexpected,pr:unexpected,issuesCreatedSince:unexpected,checkAttempt:unexpected,createIssue:unexpected,addSubIssue:unexpected,
    editIssueBody:unexpected,setIssueOpen:unexpected,createPr:unexpected,editPr:unexpected,mergePr:unexpected,rerunCheck:unexpected,
  };
  const launches:SeatLaunch[]=[],asks:AskRequest[]=[],errors:unknown[]=[];
  const host:HostPort={agents:async()=>success(null),bind:unexpected,finish:async()=>success(null),dispose:async()=>{},active:()=>false,
    seated:(ticketId,role,revision)=>launches.some(seat=>seat.ticketId===ticketId&&seat.role===role&&seat.revision===revision),
    launch:async input=>{launches.push(input);return success({agentId:`owner-${launches.length}`,sessionId:`session-${launches.length}`,sessionFile:`/data/session-${launches.length}.jsonl`,jobId:`job-${launches.length}`});}};
  const port:GuardiansPort={requestAnswer:request=>{asks.push(request);return guardians(request);}};
  const controller=new DispatchController({issue,files:createAgendaFiles(root),github,host,process:processes.spawn(pid,`start-${pid}`),cwd:root,workflow:async()=>({ok:true,value:workflow}),
    intervalSeconds:3600,meerkat:{context:MEERKAT,guardians:port},onChange:()=>{},onError:error=>errors.push(error)});
  return {controller,launches,asks,errors,host};
}
const MAIN:Caller={kind:'main',agentId:'Main',sessionId:'main',sessionFile:null};

test('the guardians receive the ask comment once; a request cut by a restart is sent again and its repeat answers 200',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-meerkat-ask-'));
  const facts=source(),processes=new ProcessTable();
  // The first request reaches the guardians, but its process dies before the answer arrives.
  const lost=Promise.withResolvers<Result<200|202,PortError>>(),reached=Promise.withResolvers<void>();
  const first=harness(root,facts,processes,101,()=>{reached.resolve();return lost.promise;});
  first.controller.setMain(MAIN);
  expect((await first.controller.execute(MAIN,{op:'convene',parent:null,tickets:[{id:'one',issue,target:{repo:repository,base:'main'},dependsOn:[],adoptPr:null}]})).ok).toBe(true);
  expect((await first.controller.execute(MAIN,{op:'launch',ticketId:'one'})).ok).toBe(true);
  for(let round=0;round<3;round++)await first.controller.run();
  const revision=first.controller.snapshot()!.tickets[0]!.revision;
  const escalated=await first.controller.execute(owner(revision),{op:'escalate',ticketId:'one',revision,kind:'question',reason:QUESTION,tier:'complex'});
  expect(escalated.ok&&'ticket' in escalated.value&&escalated.value.ticket.state).toBe('Asking');
  // The request is sent only after its executing intent is durable, so its arrival marks the moment to kill the process.
  const pending=first.controller.run();
  await reached.promise;
  expect(first.controller.snapshot()!.effects.find(effect=>effect.action.kind==='requestAnswer')?.state.kind).toBe('executing');
  const comment=facts.issues[0]!.meerkat!.markers.find(marker=>marker.kind==='ask')!;
  expect(comment.json).toEqual({v:1,tier:'complex',session:'session-1'});
  expect(first.asks).toEqual([{issue,comment:comment.id,question:QUESTION,tier:'complex'}]);
  processes.kill(101);
  try {
    const second=harness(root,facts,processes,102,async()=>success(200));
    second.controller.setMain({...MAIN,sessionId:'successor'});
    const resumed=await second.controller.execute({...MAIN,sessionId:'successor'},{op:'resume',agenda:first.controller.snapshot()!.id});
    expect(resumed.ok).toBe(true);
    for(let round=0;round<3;round++)await second.controller.run();
    const state=second.controller.snapshot()!;
    const request=state.effects.find(effect=>effect.action.kind==='requestAnswer')!;
    expect(request).toMatchObject({attempt:2,state:{kind:'confirmed',result:{kind:'answerRequested',issue,comment:comment.id,status:200}}});
    expect(second.asks).toEqual([{issue,comment:comment.id,question:QUESTION,tier:'complex'}]);
    expect(facts.issues[0]!.meerkat!.markers.filter(marker=>marker.kind==='ask')).toHaveLength(1);
    expect(state.tickets[0]).toMatchObject({state:'Asking',ask:{comment:comment.id}});
    const status=await second.controller.execute({...MAIN,sessionId:'successor'},{op:'status'});
    expect(status.ok&&(status.value as AgendaView).asking).toEqual([{ticketId:'one',question:QUESTION,comment:comment.id,agenda:null}]);
    expect(second.launches).toEqual([]);
    expect(new Attention().observe(state,second.host.active)).toEqual([]);
    expect(second.errors).toEqual([]);
    await second.controller.shutdown();
  }finally {
    lost.resolve({ok:false,error:{kind:'unavailable',message:'process ended'}});await pending;
    await rm(root,{recursive:true,force:true});
  }
});

test('unreachable guardians fail the request with their connection error, wake Main, and leave the ticket Asking',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-meerkat-ask-down-'));
  const facts=source(),processes=new ProcessTable();
  // A port nothing listens on: the bound server is stopped before the request.
  const closed=Bun.serve({port:0,fetch:()=>new Response('')});const port=closed.port;await closed.stop(true);
  const guardians=createGuardiansPort(`http://127.0.0.1:${port}`);
  const h=harness(root,facts,processes,101,request=>guardians.requestAnswer(request));
  h.controller.setMain(MAIN);
  try {
    expect((await h.controller.execute(MAIN,{op:'convene',parent:null,tickets:[{id:'one',issue,target:{repo:repository,base:'main'},dependsOn:[],adoptPr:null}]})).ok).toBe(true);
    expect((await h.controller.execute(MAIN,{op:'launch',ticketId:'one'})).ok).toBe(true);
    for(let round=0;round<3;round++)await h.controller.run();
    const revision=h.controller.snapshot()!.tickets[0]!.revision;
    expect((await h.controller.execute(owner(revision),{op:'escalate',ticketId:'one',revision,kind:'question',reason:QUESTION})).ok).toBe(true);
    for(let round=0;round<3;round++)await h.controller.run();
    const state=h.controller.snapshot()!,request=state.effects.find(effect=>effect.action.kind==='requestAnswer')!;
    expect(request.state.kind).toBe('failed');
    expect(request.state.kind==='failed'&&request.state.error.message).toStartWith(`POST http://127.0.0.1:${port}/v1/asks: `);
    expect(request.attempt).toBe(1);
    expect(state.tickets[0]).toMatchObject({state:'Asking'});
    expect(new Attention().observe(state,h.host.active)).toEqual([`failed:one:${request.id}`]);
    expect(h.launches).toHaveLength(1);
    expect(h.errors).toEqual([]);
  }finally {await h.controller.shutdown();await rm(root,{recursive:true,force:true});}
});

test('Main retries a failed guardians request by resolving to Asking; the request is sent again, the question kept, and no attention remains',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-meerkat-ask-retry-'));
  const facts=source(),processes=new ProcessTable();
  // The first request finds the guardians unreachable; the retried one is accepted.
  const answers:Result<200|202,PortError>[]=[{ok:false,error:{kind:'unavailable',message:'POST http://127.0.0.1:1/v1/asks: ECONNREFUSED'}},success(202)];
  const h=harness(root,facts,processes,101,async()=>answers.shift()!);
  h.controller.setMain(MAIN);
  try {
    expect((await h.controller.execute(MAIN,{op:'convene',parent:null,tickets:[{id:'one',issue,target:{repo:repository,base:'main'},dependsOn:[],adoptPr:null}]})).ok).toBe(true);
    expect((await h.controller.execute(MAIN,{op:'launch',ticketId:'one'})).ok).toBe(true);
    for(let round=0;round<3;round++)await h.controller.run();
    const revision=h.controller.snapshot()!.tickets[0]!.revision;
    // Only a ticket already waiting on a question can stay in Asking.
    const early=await h.controller.execute(MAIN,{op:'resolve',ticketId:'one',revision,ruling:'Wait on the guardians.',to:'Asking'});
    expect(!early.ok&&early.error.kind==='domain'&&early.error.error.kind).toBe('invalidTransition');
    expect((await h.controller.execute(owner(revision),{op:'escalate',ticketId:'one',revision,kind:'question',reason:QUESTION})).ok).toBe(true);
    for(let round=0;round<3;round++)await h.controller.run();
    const failed=h.controller.snapshot()!,request=failed.effects.find(effect=>effect.action.kind==='requestAnswer')!;
    expect(request).toMatchObject({attempt:1,state:{kind:'failed'}});
    expect(new Attention().observe(failed,h.host.active)).toEqual([`failed:one:${request.id}`]);
    const asking=failed.tickets[0]!;
    expect(asking.state).toBe('Asking');
    const resolved=await h.controller.execute(MAIN,{op:'resolve',ticketId:'one',revision:asking.revision,ruling:'The guardians are reachable again; ask them again.',to:'Asking',effects:[{effectId:request.id,disposition:'retry'}]});
    expect(resolved.ok).toBe(true);
    for(let round=0;round<3;round++)await h.controller.run();
    const state=h.controller.snapshot()!,retried=state.effects.find(effect=>effect.id===request.id)!;
    expect(retried).toMatchObject({attempt:2,state:{kind:'confirmed',result:{kind:'answerRequested',issue,comment:asking.ask!.comment,status:202}}});
    expect(state.effects.filter(effect=>effect.action.kind==='requestAnswer')).toHaveLength(1);
    expect(state.tickets[0]).toMatchObject({state:'Asking',revision:asking.revision,ask:asking.ask!});
    expect(h.asks).toEqual([{issue,comment:asking.ask!.comment!,question:QUESTION,tier:'simple'},{issue,comment:asking.ask!.comment!,question:QUESTION,tier:'simple'}]);
    expect(new Attention().observe(state,h.host.active)).toEqual([]);
    expect(h.launches).toHaveLength(1);
    expect(h.errors).toEqual([]);
  }finally {await h.controller.shutdown();await rm(root,{recursive:true,force:true});}
});
