import {expect,test} from 'bun:test';
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {YAML} from 'bun';
import type {Agenda,Caller,Facts,PmContext,PortError,Result} from '../src/domain/model.ts';
import type {GitHubPort,HostPort,SeatLaunch} from '../src/ports/contracts.ts';
import {createAgenda,satisfiedResult,statusOnDone,workerStarted} from '../src/domain/engine.ts';
import {bodyHash} from '../src/domain/identity.ts';
import {parseWorkflow} from '../src/domain/workflow.ts';
import {loadPmConfig} from '../src/pm/config.ts';
import {formatMarker,parseMarker} from '../src/pm/markers.ts';
import {createAgendaFiles} from '../src/ports/state.ts';
import {Attention} from '../src/runtime/attention.ts';
import {DispatchController} from '../src/runtime/controller.ts';
import {ProcessTable} from './process-fixture.ts';

const SIM_CONFIG=new URL('./sim/pm-config',import.meta.url).pathname;
const parsedWorkflow=parseWorkflow(YAML.parse(await Bun.file(new URL('../src/default-workflow.yml',import.meta.url)).text()));
if(!parsedWorkflow.ok)throw new Error(parsedWorkflow.error.reason);
const workflow=parsedWorkflow.value;
const repository={owner:'test',name:'dispatch'},issue={repo:repository,number:1},base='2'.repeat(40);
const PM:PmContext={host:'test-host',pid:4242,status:{inProgress:'In Progress',done:'Done'}};
function facts(pm:Facts['issues'][number]['pm']):Facts {
  return {viewer:'test',issues:[{ref:issue,body:'Deliver.',bodyHash:bodyHash('Deliver.'),updatedAt:1,state:'open',lastClose:null,lastReopen:null,children:[],pm}],prs:[],links:[],
    repos:[{repo:repository,defaultBranch:'main',defaultHead:base,bases:[{name:'main',state:{kind:'present',head:base,isDefault:true,rules:{required:[],strict:false,constraints:[]}}}]}],
    branches:[],maintenance:[],commits:[],checkAttempts:[],createdIssues:[]};
}
function agenda(source:Facts):Agenda {
  const created=createAgenda({op:'convene',parent:null,tickets:[{id:'one',issue,target:{repo:repository,base:'main'},dependsOn:[],adoptPr:null}]},workflow,source,1,'00000000-0000-4000-8000-000000000001');
  if(!created.ok)throw new Error(created.error.message);
  return created.value;
}

test('a marker line round-trips; a malformed or incomplete one is invalid and plain text has none',()=>{
  const line=formatMarker({kind:'impl',json:{v:1,host:'h',pid:7,agenda:'a',session:'s',file:'/f.jsonl'}});
  expect(line).toBe('<!-- pm:impl {"v":1,"host":"h","pid":7,"agenda":"a","session":"s","file":"/f.jsonl"} -->');
  expect(parseMarker(9,`Started.\n\n${line}\n`)).toEqual({kind:'marker',fact:{id:9,kind:'impl',json:{v:1,host:'h',pid:7,agenda:'a',session:'s',file:'/f.jsonl'}}});
  expect(parseMarker(9,'Just a comment.')).toEqual({kind:'none'});
  expect(parseMarker(9,`${line}\nA later line hides it.`)).toEqual({kind:'none'});
  expect(parseMarker(9,'<!-- pm:impl {"v":1,"host":"h"} -->').kind).toBe('invalid');
  expect(parseMarker(9,'<!-- pm:impl {"v":2,"host":"h","pid":7,"agenda":"a","session":"s","file":"f"} -->').kind).toBe('invalid');
  expect(parseMarker(9,'<!-- pm:vote {"v":1} -->').kind).toBe('invalid');
  expect(parseMarker(9,'<!-- pm:reply {"v":1,"ask":12,"decision":null} -->')).toEqual({kind:'marker',fact:{id:9,kind:'reply',json:{v:1,ask:12,decision:null}}});
});

test('the PM configuration loads strictly and names the file and key path of every problem',async()=>{
  const loaded=await loadPmConfig(SIM_CONFIG);
  expect(loaded.ok&&loaded.value.project.fields.status.options.inProgress).toBe('In Progress');
  const root=await mkdtemp(join(tmpdir(),'dispatch-pm-config-'));
  try {
    await cp(SIM_CONFIG,root,{recursive:true});
    const project=YAML.parse(await readFile(join(root,'shared/project.yaml'),'utf8')) as {fields:Record<string,unknown>};
    delete project.fields.status;
    await writeFile(join(root,'shared/project.yaml'),JSON.stringify(project));
    await writeFile(join(root,'dispatch/delivery.yaml'),'guardiansURL: http://127.0.0.1:7410\ndefaultTier: urgent\ntierHelp: x\nresumePrompt: y\nextra: 1\n');
    const refused=await loadPmConfig(root);
    expect(refused.ok).toBe(false);
    if(refused.ok)return;
    expect(refused.error).toContain(`${join(root,'shared/project.yaml')}: fields.status:`);
    expect(refused.error).toContain(`${join(root,'dispatch/delivery.yaml')}: defaultTier:`);
    expect(refused.error).toContain(`${join(root,'dispatch/delivery.yaml')}: extra: must be removed`);
  }finally {await rm(root,{recursive:true,force:true});}
});

test('a started work seat queues its impl comment and an in-progress Status, both confirmed only by source',()=>{
  const state=agenda(facts({markers:[],item:null}));
  const started=workerStarted(state,{ticketId:'one',revision:state.tickets[0]!.revision,role:'owner',sessionId:'sess-1',sessionFile:'/data/sessions/sess-1.jsonl'},PM,facts({markers:[],item:null}));
  if(!started.ok)throw new Error(started.error.message);
  const [comment,status]=started.value.effects;
  expect(comment?.action).toEqual({kind:'comment',issue,marker:{kind:'impl',key:'sess-1'},
    body:`工人会话 sess-1 开始实现本 issue。\n\n<!-- pm:impl {"v":1,"host":"test-host","pid":4242,"agenda":"${state.id}","session":"sess-1","file":"/data/sessions/sess-1.jsonl"} -->`});
  expect(status?.action).toEqual({kind:'setProjectField',issue,field:'status',option:'In Progress'});
  expect(comment?.origin).toBeNull();
  expect(satisfiedResult(started.value,comment!,facts({markers:[],item:{id:'item',status:'Todo'}}))).toBeNull();
  const marked=facts({markers:[{id:77,kind:'impl',json:{v:1,host:'other',pid:1,agenda:'a',session:'sess-1',file:'f'}}],item:{id:'item',status:'In Progress'}});
  expect(satisfiedResult(started.value,comment!,marked)).toEqual({kind:'commented',issue,comment:77});
  expect(satisfiedResult(started.value,status!,marked)).toEqual({kind:'projectFieldSet',issue,field:'status',option:'In Progress'});
  // A later session of the same issue needs its own marker; Status already in progress is not written again.
  const again=workerStarted(started.value,{ticketId:'one',revision:started.value.tickets[0]!.revision,role:'owner',sessionId:'sess-2',sessionFile:'/f2'},PM,marked);
  if(!again.ok)throw new Error(again.error.message);
  expect(again.value.effects.slice(2).map(effect=>effect.action.kind)).toEqual(['comment']);
  expect(satisfiedResult(again.value,again.value.effects[2]!,marked)).toBeNull();
  expect(workerStarted(state,{ticketId:'one',revision:state.tickets[0]!.revision+1,role:'owner',sessionId:'x',sessionFile:'/x'},PM,marked)).toMatchObject({ok:false,error:{kind:'staleRevision'}});
  expect(workerStarted(state,{ticketId:'one',revision:state.tickets[0]!.revision,role:'review',sessionId:'x',sessionFile:'/x'},PM,marked)).toMatchObject({ok:false,error:{kind:'invalidTransition'}});
});

test('entering the final Done state queues Status done once per entry',()=>{
  const previous=agenda(facts({markers:[],item:null}));
  const next=structuredClone(previous);
  next.tickets[0]!.state='Done';next.tickets[0]!.visits.Done=1;
  statusOnDone(previous,next,PM);
  expect(next.effects.map(effect=>effect.action)).toEqual([{kind:'setProjectField',issue,field:'status',option:'Done'}]);
  const unchanged=structuredClone(next);
  statusOnDone(next,unchanged,PM);
  expect(unchanged.effects).toHaveLength(1);
});

function success<T>(value:T):Result<T,PortError>{return {ok:true,value};}
function unexpected():never {throw new Error('Unexpected port call');}

test('a PM record write never escalates its ticket or supersedes the live Owner; the next complete read settles it',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-pm-effect-'));
  const source=facts({markers:[],item:{id:'item',status:'Todo'}});
  const pm=():NonNullable<Facts['issues'][number]['pm']>=>source.issues[0]!.pm!;
  // `land` decides whether a comment POST reaches GitHub; every POST loses its response, and the confirmation
  // read right after it fails, as a read does when a live Owner pushes during it.
  let land=true,failReads=0,posts=0;
  const github:GitHubPort={
    facts:async()=>failReads>0?(failReads--,{ok:false,error:{kind:'unavailable',message:'PR head branch changed within facts read'}}):success(structuredClone(source)),
    openPrsByHead:async()=>success([]),contains:async()=>success('contains'),
    comment:async(_issue,body)=>{
      posts++;failReads=1;
      const parsed=parseMarker(4000+posts,body);
      if(land&&parsed.kind==='marker')pm().markers.push(parsed.fact);
      return {ok:false,error:{kind:'uncertainOutcome',message:'Connection ended without an outcome'}};
    },
    setProjectField:async(_issue,_field,option)=>{pm().item={id:'item',status:option};return success(null);},
    branchHead:unexpected,issue:unexpected,pr:unexpected,issuesCreatedSince:unexpected,checkAttempt:unexpected,createIssue:unexpected,addSubIssue:unexpected,
    editIssueBody:unexpected,setIssueOpen:unexpected,createPr:unexpected,editPr:unexpected,mergePr:unexpected,rerunCheck:unexpected,
  };
  const live=new Map<string,SeatLaunch>(),launches:SeatLaunch[]=[];
  const host:HostPort={agents:async()=>success(null),bind:unexpected,finish:async()=>success(null),dispose:async()=>{},
    active:(ticketId,role)=>live.has(`${ticketId}/${role}`),
    seated:(ticketId,role,revision)=>launches.some(seat=>seat.ticketId===ticketId&&seat.role===role&&seat.revision===revision),
    launch:async input=>{launches.push(input);live.set(`${input.ticketId}/${input.role}`,input);return success({agentId:`owner-${launches.length}`,sessionId:`session-${launches.length}`,sessionFile:join(root,`owner-${launches.length}.jsonl`),jobId:`job-${launches.length}`});},
  };
  const errors:unknown[]=[];
  // Every durable change is observed, since a launch also kicks a background run.
  const seen:{comment:string;ticket:string;revision:number;notes:number;owner:boolean}[]=[];
  let controller:DispatchController|null=null;
  const observe=():void=>{
    const state=controller?.snapshot(),comment=state?.effects.filter(effect=>effect.action.kind==='comment').at(-1);
    if(state&&comment)seen.push({comment:comment.state.kind,ticket:state.tickets[0]!.state,revision:state.tickets[0]!.revision,notes:state.tickets[0]!.notes.length,owner:host.active('one','owner')});
  };
  controller=new DispatchController({files:createAgendaFiles(root),github,host,process:new ProcessTable().spawn(101,'Sat Nov 7 06:00:00 2026'),cwd:root,workflow:async()=>({ok:true,value:workflow}),intervalSeconds:3600,pm:PM,onChange:observe,onError:error=>errors.push(error)});
  const dispatch=controller;
  const main:Caller={kind:'main',agentId:'Main',sessionId:'main',sessionFile:null};dispatch.setMain(main);
  const comments=()=>dispatch.snapshot()!.effects.filter(effect=>effect.action.kind==='comment');
  const drain=async():Promise<void>=>{for(let round=0;round<3;round++)await dispatch.run();};
  try {
    expect((await dispatch.execute(main,{op:'convene',parent:null,tickets:[{id:'one',issue,target:{repo:repository,base:'main'},dependsOn:[],adoptPr:null}]})).ok).toBe(true);
    expect((await dispatch.execute(main,{op:'launch',ticketId:'one'})).ok).toBe(true);
    const revision=dispatch.snapshot()!.tickets[0]!.revision;
    await drain();
    // The comment landed, but neither its response nor the read after it showed that: it was left uncertain while
    // the Owner kept running at its revision, and the next complete read confirmed it without resending.
    expect(seen).toContainEqual({comment:'uncertain',ticket:'Coding',revision,notes:0,owner:true});
    expect(posts).toBe(1);
    expect(comments()[0]?.state).toEqual({kind:'confirmed',result:{kind:'commented',issue,comment:4001}});
    expect(pm().item?.status).toBe('In Progress');
    expect(dispatch.snapshot()!.tickets[0]).toMatchObject({state:'Coding',revision,notes:[]});
    expect(launches).toHaveLength(1);

    // A later session's comment that never reached GitHub turns failed on the next complete read: the Owner keeps
    // running at its revision, and Main is told, instead of `finish`, until it settles the effect.
    land=false;
    live.delete('one/owner');dispatch.seatExited({ticketId:'one',role:'owner',revision},false,'model stopped');
    await drain();
    const escalated=dispatch.snapshot()!.tickets[0]!;
    expect(escalated.state).toBe('Escalated');
    expect((await dispatch.execute(main,{op:'resolve',ticketId:'one',revision:escalated.revision,ruling:'Retry the implementation.',to:'Coding'})).ok).toBe(true);
    await drain();
    expect(launches).toHaveLength(2);
    const failed=comments()[1]!;
    expect(posts).toBe(2);
    expect(failed.state).toMatchObject({kind:'failed',error:{kind:'unavailable',message:'PR head branch changed within facts read'}});
    expect(dispatch.snapshot()!.tickets[0]).toMatchObject({state:'Coding',revision:launches[1]!.revision});
    expect(host.active('one','owner')).toBe(true);
    expect(new Attention().observe(dispatch.snapshot()!,host.active)).toEqual([`failed:one:${failed.id}`]);
    expect(errors).toEqual([]);
  }finally {await dispatch.shutdown();await rm(root,{recursive:true,force:true});}
});
