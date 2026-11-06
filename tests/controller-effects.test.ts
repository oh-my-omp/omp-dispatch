import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Caller,Facts,PortError,Result} from '../src/domain/model.ts';
import type {GitHubPort,HostPort} from '../src/ports/contracts.ts';
import {createAgendaFiles} from '../src/ports/state.ts';
import {DispatchController} from '../src/runtime/controller.ts';
import {bodyHash} from '../src/domain/identity.ts';
import {YAML} from 'bun';
import {parseWorkflow} from '../src/domain/workflow.ts';
import {parseToolParameters} from '../src/domain/parse.ts';
import {ProcessTable} from './process-fixture.ts';

const parsedWorkflow=parseWorkflow(YAML.parse(await Bun.file(new URL('../src/default-workflow.yml',import.meta.url)).text()));
if(!parsedWorkflow.ok)throw new Error(parsedWorkflow.error.reason);
const defaultWorkflow=parsedWorkflow.value;
const workflow=async()=>({ok:true as const,value:defaultWorkflow});

const repository={owner:'test',name:'dispatch'};
const issue={repo:repository,number:1};
const head='1'.repeat(40),base='2'.repeat(40);
const facts:Facts={viewer:'test',issues:[{ref:issue,body:'Deliver the ticket.',bodyHash:bodyHash('Deliver the ticket.'),updatedAt:1,state:'open',lastClose:null,lastReopen:null,children:[],pm:null}],prs:[],links:[],repos:[{repo:repository,defaultBranch:'main',defaultHead:base,bases:[{name:'main',state:{kind:'present',head:base,isDefault:true,rules:{required:[],strict:false,constraints:[]}}}]}],branches:[{repo:repository,name:'feature',state:{kind:'present',head}}],maintenance:[],commits:[],checkAttempts:[],createdIssues:[]};
function unexpected():never {throw new Error('Unexpected port call');}
const host:HostPort={agents:async()=>({ok:true,value:null}),bind:unexpected,launch:unexpected,active:()=>false,seated:()=>false,finish:async()=>({ok:true,value:null}),dispose:async()=>{}};
function success<T>(value:T):Result<T,PortError>{return {ok:true,value};}

for(const operation of ['publishPr','merge'] as const)test(`an unknown ${operation} is durable before dispatch and is not resent on refresh or resume`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-effect-'));
  const files=createAgendaFiles(root),source=structuredClone(facts);
  const prRef={repo:repository,number:2};
  if(operation==='merge')source.prs.push({ref:prRef,headRepo:repository,headBranch:'feature',head,target:{repo:repository,base:'main'},title:'Deliver one',body:'Closes test/dispatch#1',bodyHash:bodyHash('Closes test/dispatch#1'),updatedAt:1,state:{kind:'open'},closes:[issue],mergeable:'yes',checks:{kind:'passing',required:[]}});
  let calls=0,executingOnDisk=false;
  let controller:DispatchController;
  async function unknownWrite():Promise<Result<never,PortError>> {
    calls++;
    const snapshot=controller.snapshot();if(!snapshot)throw new Error('Agenda disappeared before dispatch');
    const durable=await files.load(snapshot.id);if(!durable.ok)throw new Error(durable.error.message);
    executingOnDisk=durable.value.effects.some(effect=>effect.action.kind===operation&&effect.state.kind==='executing');
    return {ok:false,error:{kind:'uncertainOutcome',message:'Connection ended without an outcome'}};
  }
  const github:GitHubPort={
    facts:async()=>success(structuredClone(source)),openPrsByHead:async()=>success([]),
    contains:unexpected,branchHead:unexpected,issue:unexpected,pr:unexpected,issuesCreatedSince:unexpected,checkAttempt:unexpected,
    createIssue:unexpected,addSubIssue:unexpected,editIssueBody:unexpected,setIssueOpen:unexpected,editPr:unexpected,rerunCheck:unexpected,comment:unexpected,setProjectField:unexpected,
    createPr:operation==='publishPr'?unknownWrite:unexpected,mergePr:operation==='merge'?unknownWrite:unexpected,
  };
  const errors:unknown[]=[];
  const processes=new ProcessTable();
  controller=new DispatchController({files,github,host,process:processes.spawn(101,'Sat Nov 7 06:00:00 2026'),cwd:root,workflow,intervalSeconds:3600,pm:null,onChange:()=>{},onError:error=>errors.push(error)});
  const main:Caller={kind:'main',agentId:'Main',sessionId:'first-main',sessionFile:null};controller.setMain(main);
  try {
    const convened=await controller.execute(main,{op:'convene',parent:null,tickets:[{id:'one',issue,target:{repo:repository,base:'main'},dependsOn:[],adoptPr:operation==='merge'?prRef:null}]});
    expect(convened.ok).toBe(true);
    const owner:Caller={kind:'seat',agentId:'Owner',sessionId:'first-owner',sessionFile:join(root,'owner.jsonl'),ticketId:'one',revision:1,role:'owner'};
    if(operation==='publishPr')expect((await controller.execute(owner,{op:'submit',ticketId:'one',revision:1,branch:'feature',head,title:'Deliver one',body:'Closes test/dispatch#1'})).ok).toBe(true);
    else for(const role of ['review','accept'] as const){
      const revision=controller.snapshot()!.tickets[0]!.revision;
      const gate:Caller={kind:'seat',agentId:role,sessionId:role,sessionFile:join(root,`${role}.jsonl`),ticketId:'one',revision,role};
      expect((await controller.execute(gate,{op:'verdict',ticketId:'one',revision,role,ok:true,note:'Verified the exact contract and head.'})).ok).toBe(true);
    }
    if(operation==='merge'){
      source.prs[0]!.mergeable='unknown';
      await controller.run();
      expect(calls).toBe(0);
      expect(controller.snapshot()?.effects[0]?.state.kind).toBe('ready');
      expect(controller.snapshot()?.tickets[0]?.state).toBe('Merging');
      source.prs[0]!.mergeable='yes';
    }
    await controller.run();await controller.run();
    const failed=controller.snapshot();if(!failed)throw new Error('Missing agenda');
    expect(executingOnDisk).toBe(true);
    expect(calls).toBe(1);
    expect(failed.effects[0]?.state.kind).toBe('uncertain');
    expect(failed.tickets[0]?.state).toBe('Escalated');
    if(operation==='publishPr')expect(failed.tickets[0]?.sessions.owner).toBe(owner.sessionFile);
    await controller.shutdown();
    controller=new DispatchController({files,github,host,process:processes.spawn(102,'Sat Nov 7 06:05:00 2026'),cwd:root,workflow:async()=>{throw new Error('Resume must use the frozen workflow');},intervalSeconds:3600,pm:null,onChange:()=>{},onError:error=>errors.push(error)});
    const successor:Caller={kind:'main',agentId:'Main',sessionId:'second-main',sessionFile:null};controller.setMain(successor);
    expect((await controller.execute(successor,{op:'resume',agenda:failed.id})).ok).toBe(true);
    await controller.run();await controller.run();
    expect(calls).toBe(1);
    expect(controller.snapshot()?.effects[0]?.state.kind).toBe('uncertain');
    if(operation==='publishPr')expect(controller.snapshot()?.tickets[0]?.sessions.owner).toBe(owner.sessionFile);
    expect(errors).toEqual([]);
  }finally {await controller.shutdown();await rm(root,{recursive:true,force:true});}
});

test('Main can adopt a source-confirmed external merge below the target head in one resolution',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-adopt-'));
  const source=structuredClone(facts),merge='3'.repeat(40),prRef={repo:repository,number:7};
  source.issues[0]!.state='closed';source.issues[0]!.lastClose={id:'closed',at:3};
  source.prs.push({ref:prRef,headRepo:repository,headBranch:'feature',head,target:{repo:repository,base:'main'},title:'Externally merged',body:'Closes test/dispatch#1',bodyHash:bodyHash('Closes test/dispatch#1'),updatedAt:3,state:{kind:'merged',sha:merge,at:3},closes:[issue],mergeable:'unknown',checks:{kind:'passing',required:[]}});
  const comparisons:string[]=[];
  const github:GitHubPort={
    facts:async scope=>success({...structuredClone(source),prs:source.prs.filter(pr=>scope.prs.some(wanted=>wanted.number===pr.ref.number))}),
    contains:async(_repo,ancestor,descendant)=>{comparisons.push(`${ancestor}:${descendant}`);return success('contains');},
    openPrsByHead:async()=>success([]),branchHead:unexpected,issue:unexpected,pr:unexpected,issuesCreatedSince:unexpected,checkAttempt:unexpected,createIssue:unexpected,addSubIssue:unexpected,editIssueBody:unexpected,setIssueOpen:unexpected,editPr:unexpected,rerunCheck:unexpected,createPr:unexpected,mergePr:unexpected,comment:unexpected,setProjectField:unexpected,
  };
  const controller=new DispatchController({files:createAgendaFiles(root),github,host,process:new ProcessTable().spawn(101,'Sat Nov 7 06:00:00 2026'),cwd:root,workflow,intervalSeconds:3600,pm:null,onChange:()=>{},onError:unexpected});
  const main:Caller={kind:'main',agentId:'Main',sessionId:'external-main',sessionFile:null};controller.setMain(main);
  try {
    expect((await controller.execute(main,{op:'convene',parent:null,tickets:[{id:'one',issue,target:{repo:repository,base:'main'},dependsOn:[],adoptPr:null}]})).ok).toBe(true);
    const adopted=await controller.execute(main,{op:'resolve',ticketId:'one',revision:controller.snapshot()!.tickets[0]!.revision,ruling:'The author merged this change externally; verify the contained merge.',to:'Verifying',adoptPr:prRef});
    expect(adopted).toMatchObject({ok:true});
    expect(comparisons).toContain(`${merge}:${base}`);
    expect(controller.snapshot()?.tickets[0]).toMatchObject({state:'Verifying',terminal:{kind:'merged',mergeSha:merge}});
  }finally {await controller.shutdown();await rm(root,{recursive:true,force:true});}
});

test('convene checks every configured agent and refuses the agenda when one cannot host a seat',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-agents-'));
  const custom=structuredClone(defaultWorkflow);
  custom.ticket.states.Coding={...custom.ticket.states.Coding!,kind:'work',role:'owner',guard:null,on:{submitted:{branches:[],otherwise:'Publishing'},escalated:{branches:[],otherwise:'escalate'}},agent:'builder',brief:'Deliver.'};
  custom.ticket.states.Reviewing={kind:'judge',subject:'pullRequest',guard:null,observe:{checksFailed:'Coding',conflict:'Coding',behind:'Coding',drift:'AwaitingChecks'},on:{passed:{branches:[],otherwise:'Merging'},rejected:{branches:[],otherwise:'Coding'},escalated:{branches:[],otherwise:'escalate'}},judges:[{role:'quality',agent:'checker',brief:'Check.'},{role:'security',agent:'missing-agent',brief:'Audit.'}]};
  const verifying=custom.ticket.states.Verifying!,parent=custom.parent.states.Reviewing!;
  if(verifying.kind!=='judge'||parent.kind!=='judge')throw new Error('Expected judge states');
  verifying.judges=[{role:'deploy',agent:'deployer',brief:'Verify.'}];
  parent.judges=[{role:'release',agent:'parent-agent',brief:'Release.'}];
  const checked:string[][]=[];
  const refusing:HostPort={...host,agents:async(_cwd,names)=>{checked.push([...names]);return {ok:false,error:{kind:'precondition',message:'Configured seat agent is unavailable: missing-agent'}};}};
  const github:GitHubPort={facts:unexpected,contains:unexpected,openPrsByHead:unexpected,branchHead:unexpected,issue:unexpected,pr:unexpected,issuesCreatedSince:unexpected,checkAttempt:unexpected,createIssue:unexpected,addSubIssue:unexpected,editIssueBody:unexpected,setIssueOpen:unexpected,editPr:unexpected,rerunCheck:unexpected,createPr:unexpected,mergePr:unexpected,comment:unexpected,setProjectField:unexpected};
  const files=createAgendaFiles(root);
  const controller=new DispatchController({files,github,host:refusing,process:new ProcessTable().spawn(101,'Sat Nov 7 06:00:00 2026'),cwd:root,workflow:async()=>({ok:true,value:custom}),intervalSeconds:3600,pm:null,onChange:()=>{},onError:unexpected});
  const main:Caller={kind:'main',agentId:'Main',sessionId:'agents-main',sessionFile:null};controller.setMain(main);
  try {
    const convened=await controller.execute(main,{op:'convene',parent:null,tickets:[{id:'one',issue,target:{repo:repository,base:'main'},dependsOn:[],adoptPr:null}]});
    expect(convened).toMatchObject({ok:false,error:{kind:'host',error:{kind:'precondition'}}});
    expect(new Set(checked.flat())).toEqual(new Set(['builder','checker','missing-agent','deployer','parent-agent']));
    expect(controller.snapshot()).toBeNull();
    expect(await files.list()).toEqual({ok:true,value:[]});
  }finally {await controller.shutdown();await rm(root,{recursive:true,force:true});}
});

// Resume asks the host's process table whether the recorded coordinator still runs: same pid and same start time.
const quietGithub:GitHubPort={facts:async()=>success(structuredClone(facts)),openPrsByHead:async()=>success([]),contains:unexpected,branchHead:unexpected,issue:unexpected,pr:unexpected,issuesCreatedSince:unexpected,checkAttempt:unexpected,createIssue:unexpected,addSubIssue:unexpected,editIssueBody:unexpected,setIssueOpen:unexpected,editPr:unexpected,rerunCheck:unexpected,createPr:unexpected,mergePr:unexpected,comment:unexpected,setProjectField:unexpected};
const ORIGINAL_START='Sat Nov 7 06:00:00 2026',SUCCESSOR_START='Sat Nov 7 06:05:00 2026';
function coordinator(root:string,processes:ProcessTable,pid:number,startedAt:string):{controller:DispatchController;main:Extract<Caller,{kind:'main'}>} {
  const controller=new DispatchController({files:createAgendaFiles(root),github:quietGithub,host,process:processes.spawn(pid,startedAt),cwd:root,workflow,intervalSeconds:3600,pm:null,onChange:()=>{},onError:unexpected});
  const main={kind:'main' as const,agentId:'Main',sessionId:`main-${pid}`,sessionFile:null};controller.setMain(main);
  return {controller,main};
}
async function convened(root:string,processes:ProcessTable):Promise<{controller:DispatchController;id:string}> {
  const {controller,main}=coordinator(root,processes,201,ORIGINAL_START);
  const result=await controller.execute(main,{op:'convene',parent:null,tickets:[{id:'one',issue,target:{repo:repository,base:'main'},dependsOn:[],adoptPr:null}]});
  if(!result.ok)throw new Error(JSON.stringify(result.error));
  const id=controller.snapshot()!.id;
  expect((await createAgendaFiles(root).load(id))).toMatchObject({ok:true,value:{run:{kind:'attached',pid:201,startedAt:ORIGINAL_START}}});
  return {controller,id};
}

test('resume takes over an agenda whose coordinator process was killed',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-resume-killed-'));
  const processes=new ProcessTable();
  // A killed process never shuts down, so its agenda stays attached.
  const {id}=await convened(root,processes);processes.kill(201);
  const successor=coordinator(root,processes,202,SUCCESSOR_START);
  try {
    expect((await successor.controller.execute(successor.main,{op:'resume',agenda:id})).ok).toBe(true);
    expect(await createAgendaFiles(root).load(id)).toMatchObject({ok:true,value:{run:{kind:'attached',pid:202,startedAt:SUCCESSOR_START,mainSessionId:'main-202'}}});
  }finally {await successor.controller.shutdown();await rm(root,{recursive:true,force:true});}
});

test('resume refuses with agenda_attached while the coordinator process still runs, and the run stays with it',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-resume-live-'));
  const processes=new ProcessTable();
  const original=await convened(root,processes);
  const rival=coordinator(root,processes,203,SUCCESSOR_START);
  try {
    const refused=await rival.controller.execute(rival.main,{op:'resume',agenda:original.id});
    expect(refused).toMatchObject({ok:false,error:{kind:'domain',error:{kind:'agenda_attached'}}});
    if(refused.ok||refused.error.kind!=='domain')throw new Error('Expected a domain refusal');
    expect(refused.error.error.message).toContain('pid 201');
    expect(refused.error.error.message).toContain(ORIGINAL_START);
    expect(rival.controller.snapshot()).toBeNull();
    expect(await createAgendaFiles(root).load(original.id)).toMatchObject({ok:true,value:{run:{kind:'attached',pid:201,startedAt:ORIGINAL_START}}});
    expect((await original.controller.execute({kind:'main',agentId:'Main',sessionId:'main-201',sessionFile:null},{op:'status'})).ok).toBe(true);
  }finally {await rival.controller.shutdown();await original.controller.shutdown();await rm(root,{recursive:true,force:true});}
});

test('resume takes over when the recorded pid now belongs to a process with another start time',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-resume-reused-'));
  const processes=new ProcessTable();
  const {id}=await convened(root,processes);
  processes.kill(201);processes.spawn(201,'Sat Nov 7 07:00:00 2026');
  const successor=coordinator(root,processes,204,SUCCESSOR_START);
  try {
    expect((await successor.controller.execute(successor.main,{op:'resume',agenda:id})).ok).toBe(true);
    expect(await createAgendaFiles(root).load(id)).toMatchObject({ok:true,value:{run:{kind:'attached',pid:204}}});
  }finally {await successor.controller.shutdown();await rm(root,{recursive:true,force:true});}
});

test('a coordinator that shuts down detaches its agenda, and resume then needs no process lookup of it',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-resume-detached-'));
  const processes=new ProcessTable();
  const original=await convened(root,processes);
  await original.controller.shutdown();
  expect(await createAgendaFiles(root).load(original.id)).toMatchObject({ok:true,value:{run:{kind:'detached'}}});
  // The original process still runs after its session ended; only a detached run lets the successor in.
  const successor=coordinator(root,processes,205,SUCCESSOR_START);
  try {
    expect((await successor.controller.execute(successor.main,{op:'resume',agenda:original.id})).ok).toBe(true);
    expect(await createAgendaFiles(root).load(original.id)).toMatchObject({ok:true,value:{run:{kind:'attached',pid:205}}});
  }finally {await successor.controller.shutdown();await rm(root,{recursive:true,force:true});}
});

test('resume input carries only op and agenda; any other field is refused',()=>{
  const agenda='aaaabbbb-1111-4111-8111-111111111111';
  expect(parseToolParameters({input:{op:'resume',agenda}}).ok).toBe(true);
  expect(parseToolParameters({input:{op:'resume',agenda,confirmed:true}}).ok).toBe(false);
});
