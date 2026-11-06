import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Caller,Facts,PortError,PrSnapshot,Result,Role,Workflow} from '../src/domain/model.ts';
import type {GitHubPort,HostPort,PrWrite,SeatLaunch} from '../src/ports/contracts.ts';
import {createAgendaFiles} from '../src/ports/state.ts';
import {DispatchController} from '../src/runtime/controller.ts';
import {Attention} from '../src/runtime/attention.ts';
import {bodyHash} from '../src/domain/identity.ts';
import {YAML} from 'bun';
import {parseWorkflow} from '../src/domain/workflow.ts';
import {ProcessTable} from './process-fixture.ts';

const parsedWorkflow=parseWorkflow(YAML.parse(await Bun.file(new URL('../src/default-workflow.yml',import.meta.url)).text()));
if(!parsedWorkflow.ok)throw new Error(parsedWorkflow.error.reason);
const defaultWorkflow=parsedWorkflow.value;

// A fake host and a mutable GitHub source drive the real controller, so these tests observe which seats the
// relay starts, at which exact commit, and when Main is woken. Native sessions and git live in the host port.

const repository={owner:'test',name:'dispatch'};
const target={repo:repository,base:'main'};
const BASE='a'.repeat(40),HEAD='b'.repeat(40),REWORK='c'.repeat(40),MERGE='d'.repeat(40);
const issueA={repo:repository,number:1},issueB={repo:repository,number:2};
const prRef={repo:repository,number:10};
const closes=(number:number)=>`Closes test/dispatch#${number}`;
function success<T>(value:T):Result<T,PortError>{return {ok:true,value};}
function unexpected():never {throw new Error('Unexpected port call');}

function harness(root:string,workflow:Workflow=defaultWorkflow) {
  const source:Facts={viewer:'test',prs:[],links:[],maintenance:[],commits:[],checkAttempts:[],createdIssues:[],
    issues:[issueA,issueB].map(ref=>({ref,body:`Deliver ${ref.number}.`,bodyHash:bodyHash(`Deliver ${ref.number}.`),updatedAt:1,state:'open' as const,lastClose:null,lastReopen:null,children:[],pm:null})),
    repos:[{repo:repository,defaultBranch:'main',defaultHead:BASE,bases:[{name:'main',state:{kind:'present',head:BASE,isDefault:true,rules:{required:[],strict:false,constraints:[]}}}]}],
    branches:[{repo:repository,name:'feature-1',state:{kind:'present',head:HEAD}}]};
  function setBase(head:string):void {
    const base=source.repos[0]!.bases[0]!;
    if(base.state.kind!=='present')throw new Error('Target must exist');
    base.state.head=head;source.repos[0]!.defaultHead=head;
  }
  function publish(input:PrWrite):PrSnapshot {
    return {ref:prRef,headRepo:input.headRepo,headBranch:input.branch,head:input.head,target:input.target,title:input.title,body:input.body,bodyHash:bodyHash(input.body),updatedAt:2,state:{kind:'open'},closes:[issueA],mergeable:'unknown',checks:{kind:'pending',required:[{identity:{name:'ci',source:{kind:'any'}},head:input.head}]}};
  }
  const github:GitHubPort={
    facts:async()=>success(structuredClone(source)),contains:async()=>success('contains'),openPrsByHead:async()=>success([]),
    createPr:async input=>{
      source.prs.push(publish(input));
      source.maintenance.push({pr:prRef,result:{kind:'maintainable',basis:{headRepo:repository,headBranch:input.branch,viewerPermission:'ADMIN',author:'test',maintainerCanModify:true,authorization:{kind:'actorIsAuthor',actor:'test'}}}});
      return success(prRef);
    },
    editPr:async(_pr,input)=>{source.prs[0]=publish(input);return success(null);},
    mergePr:async()=>{source.prs[0]!.state={kind:'merged',sha:MERGE,at:3};setBase(MERGE);return success(null);},
    setIssueOpen:async(ref,open)=>{
      const issue=source.issues.find(item=>item.ref.number===ref.number)!;
      issue.state=open?'open':'closed';issue.lastClose=open?issue.lastClose:{id:`close-${ref.number}`,at:4};
      return success(null);
    },
    branchHead:unexpected,issue:unexpected,pr:unexpected,issuesCreatedSince:unexpected,checkAttempt:unexpected,createIssue:unexpected,addSubIssue:unexpected,editIssueBody:unexpected,rerunCheck:unexpected,comment:unexpected,setProjectField:unexpected,
  };
  const live=new Map<string,SeatLaunch>(),launches:SeatLaunch[]=[];
  const host:HostPort={agents:async()=>success(null),bind:unexpected,finish:async()=>success(null),dispose:async()=>{},
    active:(ticketId,role)=>live.has(`${ticketId}/${role}`),
    seated:(ticketId,role,revision)=>launches.some(seat=>seat.ticketId===ticketId&&seat.role===role&&seat.revision===revision),
    launch:async input=>{launches.push(input);live.set(`${input.ticketId}/${input.role}`,input);return success({agentId:`${input.role}-${launches.length}`,sessionId:`session-${launches.length}`,sessionFile:join(root,`${input.role}-${launches.length}.jsonl`),jobId:`job-${launches.length}`});},
  };
  const attention=new Attention(),wakes:string[][]=[],errors:unknown[]=[];
  let controller:DispatchController|null=null;
  // Mirrors ProcessRuntime.changed: every durable change and every Main call is observed.
  function observe():void {
    const agenda=controller?.snapshot();if(!agenda)return;
    const fresh=attention.observe(agenda,host.active);if(fresh.length)wakes.push(fresh);
  }
  const processes=new ProcessTable();
  controller=new DispatchController({files:createAgendaFiles(root),github,host,process:processes.spawn(101,'Sat Nov 7 06:00:00 2026'),cwd:root,workflow:async()=>({ok:true,value:workflow}),intervalSeconds:3600,pm:null,onChange:observe,onError:error=>errors.push(error)});
  const dispatch=controller;
  const main:Caller={kind:'main',agentId:'Main',sessionId:'main',sessionFile:null};dispatch.setMain(main);
  // run() is the entry the kick timer uses; calling it directly drains effects and relays deterministically.
  async function drain():Promise<void> {for(let round=0;round<4;round++)await dispatch.run();}
  return {
    source,setBase,launches,wakes,errors,github,host,processes,controller:dispatch,
    async asMain(input:Parameters<DispatchController['execute']>[1]) {const result=await dispatch.execute(main,input);observe();return result;},
    async asSeat(ticketId:string,role:Role,input:Parameters<DispatchController['execute']>[1]) {
      const seat=live.get(`${ticketId}/${role}`);if(!seat)throw new Error(`No live ${role} seat for ${ticketId}`);
      const caller:Caller={kind:'seat',agentId:`${role}-agent`,sessionId:`${role}-session`,sessionFile:join(root,`${ticketId}-${role}-${seat.revision}.jsonl`),ticketId,role,revision:seat.revision};
      return dispatch.execute(caller,input);
    },
    exit(ticketId:string,role:Role,handedOff:boolean,error:string|null=null):void {
      const seat=live.get(`${ticketId}/${role}`);if(!seat)throw new Error(`No live ${role} seat for ${ticketId}`);
      live.delete(`${ticketId}/${role}`);dispatch.seatExited({ticketId,role,revision:seat.revision},handedOff,error);observe();
    },
    revision(id:string):number {return dispatch.snapshot()!.tickets.find(ticket=>ticket.id===id)!.revision;},
    drain,
  };
}

test('one launch per ticket: the relay seats every later stage at its exact commit and wakes Main only for decisions',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-relay-'));
  const h=harness(root);
  try {
    expect((await h.asMain({op:'convene',parent:null,tickets:[
      {id:'A',issue:issueA,target,dependsOn:[],adoptPr:null},
      {id:'B',issue:issueB,target,dependsOn:['A'],adoptPr:null},
    ]})).ok).toBe(true);
    expect(h.wakes).toEqual([['launch:A']]);

    // A named role must be one the ticket's current stage offers; a rejected launch leaves the ticket unlaunched.
    expect(await h.asMain({op:'launch',ticketId:'A',role:'review'})).toMatchObject({ok:false,error:{error:{kind:'invalidTransition'}}});
    expect(h.launches).toHaveLength(0);
    const launched=await h.asMain({op:'launch',ticketId:'A',role:'owner'});
    expect(launched).toMatchObject({ok:true,value:{launched:[{jobId:'job-1'}]}});
    expect(h.launches[0]).toMatchObject({ticketId:'A',role:'owner',workspace:{kind:'base',target}});
    expect(await h.asMain({op:'launch',ticketId:'A'})).toMatchObject({ok:false,error:{error:{kind:'invalidTransition'}}});
    expect(await h.asMain({op:'launch',ticketId:'B'})).toMatchObject({ok:false,error:{error:{kind:'invalidTransition'}}});

    // Publication with CI pending and mergeability unknown seats no gate.
    expect((await h.asSeat('A','owner',{op:'submit',ticketId:'A',revision:1,branch:'feature-1',head:HEAD,title:'Deliver A',body:closes(1)})).ok).toBe(true);
    h.exit('A','owner',true);
    await h.drain();
    expect(h.controller.snapshot()!.tickets[0]).toMatchObject({state:'AwaitingChecks',gates:{}});
    expect(h.launches).toHaveLength(1);

    // A mergeable PR with passing checks seats fresh review and accept at the PR head.
    h.source.prs[0]!.mergeable='yes';h.source.prs[0]!.checks={kind:'passing',required:[]};
    await h.drain();
    expect(h.launches.slice(1).map(seat=>[seat.role,seat.workspace])).toEqual([
      ['review',{kind:'commit',repo:repository,sha:HEAD,pull:10}],
      ['accept',{kind:'commit',repo:repository,sha:HEAD,pull:10}],
    ]);

    // A failed review returns to Coding; the rework Owner waits until every gate seat of the ticket exited.
    expect((await h.asSeat('A','review',{op:'verdict',ticketId:'A',revision:h.revision('A'),role:'review',ok:false,note:'Missing a regression test.'})).ok).toBe(true);
    h.exit('A','review',true);
    await h.drain();
    expect(h.launches).toHaveLength(3);
    h.exit('A','accept',false,'Dispatch seat revision was superseded');
    await h.drain();
    expect(h.launches[3]).toMatchObject({role:'owner',revision:5,workspace:{kind:'fork',sessionFile:join(root,'A-owner-1.jsonl')}});
    expect(h.controller.snapshot()!.tickets[0]!.state).toBe('Coding');

    h.source.branches[0]!.state={kind:'present',head:REWORK};
    expect((await h.asSeat('A','owner',{op:'submit',ticketId:'A',revision:h.revision('A'),branch:'feature-1',head:REWORK,title:'Deliver A',body:closes(1)})).ok).toBe(true);
    h.exit('A','owner',true);
    await h.drain();
    h.source.prs[0]!.mergeable='yes';h.source.prs[0]!.checks={kind:'passing',required:[]};
    await h.drain();
    expect(h.launches.slice(4).map(seat=>[seat.role,seat.workspace])).toEqual([
      ['review',{kind:'commit',repo:repository,sha:REWORK,pull:10}],
      ['accept',{kind:'commit',repo:repository,sha:REWORK,pull:10}],
    ]);

    const revision=h.revision('A');
    for(const role of ['review','accept'] as const){
      expect((await h.asSeat('A',role,{op:'verdict',ticketId:'A',revision,role,ok:true,note:'Verified the exact head.'})).ok).toBe(true);
      h.exit('A',role,true);
    }
    await h.drain();
    expect(h.launches[6]).toMatchObject({role:'postMerge',workspace:{kind:'commit',repo:repository,sha:MERGE,pull:null}});

    expect((await h.asSeat('A','postMerge',{op:'verdict',ticketId:'A',revision:h.revision('A'),role:'postMerge',ok:true,note:'Target contains the merge.'})).ok).toBe(true);
    h.exit('A','postMerge',true);
    await h.drain();
    expect(h.controller.snapshot()!.tickets[0]!.state).toBe('Done');
    expect(h.wakes).toEqual([['launch:A'],['launch:B']]);

    // A noCode ruling queues the closure without waking Main; completion wakes it once to finish.
    expect((await h.asMain({op:'resolve',ticketId:'B',revision:1,ruling:'Already satisfied by A.',to:'Closing',noCode:'A delivered it.'})).ok).toBe(true);
    expect(h.wakes).toEqual([['launch:A'],['launch:B']]);
    await h.drain();
    expect(h.controller.snapshot()!.tickets.map(ticket=>ticket.state)).toEqual(['Done','Done']);
    expect(h.wakes).toEqual([['launch:A'],['launch:B'],['finish']]);
    expect(h.launches).toHaveLength(7);
    expect(h.errors).toEqual([]);
  }finally {await h.controller.shutdown();await rm(root,{recursive:true,force:true});}
});

test('a seat that exits without a handoff escalates its current revision instead of being relaunched',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-abandon-'));
  const h=harness(root);
  try {
    expect((await h.asMain({op:'convene',parent:null,tickets:[{id:'A',issue:issueA,target,dependsOn:[],adoptPr:null}]})).ok).toBe(true);
    expect((await h.asMain({op:'launch',ticketId:'A'})).ok).toBe(true);
    h.exit('A','owner',false,'model stopped');
    await h.drain();
    const ticket=h.controller.snapshot()!.tickets[0]!;
    expect(ticket).toMatchObject({state:'Escalated',revision:2,started:true});
    expect(ticket.notes.at(-1)?.text).toContain('model stopped');
    expect(h.launches).toHaveLength(1);
    expect(h.wakes).toEqual([['launch:A'],['escalated:A:2']]);

    // Main's ruling resumes the relay without another launch.
    expect((await h.asMain({op:'resolve',ticketId:'A',revision:2,ruling:'Retry the implementation.',to:'Coding'})).ok).toBe(true);
    await h.drain();
    expect(h.launches[1]).toMatchObject({role:'owner',revision:3,workspace:{kind:'base',target}});
  }finally {await h.controller.shutdown();await rm(root,{recursive:true,force:true});}
});

test('a seat that ends without a handoff while a refresh is in flight is not re-seated at its revision',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-reseat-'));
  const h=harness(root);
  try {
    expect((await h.asMain({op:'convene',parent:null,tickets:[{id:'A',issue:issueA,target,dependsOn:[],adoptPr:null}]})).ok).toBe(true);
    expect((await h.asMain({op:'launch',ticketId:'A'})).ok).toBe(true);
    // The refresh is already reading the source when the Owner leaves; its escalation queues behind the refresh.
    const refresh=h.controller.run();
    h.exit('A','owner',false,'model stopped');
    await refresh;
    await h.drain();
    expect(h.launches.filter(seat=>seat.ticketId==='A'&&seat.role==='owner').map(seat=>seat.revision)).toEqual([1]);
    expect(h.controller.snapshot()!.tickets[0]).toMatchObject({state:'Escalated',revision:2});
  }finally {await h.controller.shutdown();await rm(root,{recursive:true,force:true});}
});

test('the relay uses each configured role agent and brief from Owner through parent closure',async()=>{
  const root=await mkdtemp('/tmp/dispatch-custom-relay-');
  const workflow=structuredClone(defaultWorkflow);
  const coding=workflow.ticket.states.Coding!,reviewing=workflow.ticket.states.Reviewing!,verifying=workflow.ticket.states.Verifying!,parent=workflow.parent.states.Reviewing!;
  if(coding.kind!=='work'||reviewing.kind!=='judge'||verifying.kind!=='judge'||parent.kind!=='judge')throw new Error('Expected built-in seats');
  coding.agent='builder';coding.brief='Build the requested customer behavior.';
  reviewing.judges=[{role:'audit',agent:'security-agent',brief:'Audit the security boundary.'},{role:'experience',agent:'ux-agent',brief:'Inspect the user journey.'}];
  verifying.judges=[{role:'deployed',agent:'runtime-agent',brief:'Exercise the merged runtime.'}];
  parent.judges=[{role:'aggregate',agent:'product-agent',brief:'Confirm the combined product outcome.'}];
  const h=harness(root,workflow);
  h.source.issues.find(issue=>issue.ref.number===issueB.number)!.children=[issueA];
  try {
    expect((await h.asMain({op:'convene',parent:issueB,tickets:[{id:'A',issue:issueA,target,dependsOn:[],adoptPr:null}]})).ok).toBe(true);
    expect((await h.asMain({op:'launch',ticketId:'A'})).ok).toBe(true);
    expect((await h.asSeat('A','owner',{op:'submit',ticketId:'A',revision:1,branch:'feature-1',head:HEAD,title:'Deliver A',body:closes(1)})).ok).toBe(true);
    h.exit('A','owner',true);await h.drain();
    h.source.prs[0]!.mergeable='yes';h.source.prs[0]!.checks={kind:'passing',required:[]};
    await h.drain();
    for(const role of ['audit','experience']){
      expect((await h.asSeat('A',role,{op:'verdict',ticketId:'A',revision:h.revision('A'),role,ok:true,note:'The open PR satisfies the contract.'})).ok).toBe(true);
      h.exit('A',role,true);
    }
    await h.drain();
    expect((await h.asSeat('A','deployed',{op:'verdict',ticketId:'A',revision:h.revision('A'),role:'deployed',ok:true,note:'Merged delivery works.'})).ok).toBe(true);
    h.exit('A','deployed',true);await h.drain();
    const closure=h.controller.snapshot()!.closure!;
    expect((await h.asSeat(closure.id,'aggregate',{op:'verdict',ticketId:closure.id,revision:closure.revision,role:'aggregate',ok:true,note:'All outcomes satisfy the parent.'})).ok).toBe(true);
    h.exit(closure.id,'aggregate',true);await h.drain();
    expect(h.controller.snapshot()!.closure?.state).toBe('Done');
    expect(h.launches.map(seat=>[seat.role,seat.agent])).toEqual([
      ['owner','builder'],['audit','security-agent'],['experience','ux-agent'],['deployed','runtime-agent'],['aggregate','product-agent'],
    ]);
    for(const configured of [coding,...reviewing.judges,...verifying.judges,...parent.judges]){
      const launch=h.launches.find(seat=>seat.role===configured.role)!;
      expect(launch.prompt).toContain(configured.brief);
    }
    expect(h.errors).toEqual([]);
  }finally {await h.controller.shutdown();await rm(root,{recursive:true,force:true});}
});

test('resume uses the frozen workflow without calling the current workflow loader',async()=>{
  const root=await mkdtemp('/tmp/dispatch-frozen-resume-');
  const workflow=structuredClone(defaultWorkflow),coding=workflow.ticket.states.Coding!;
  if(coding.kind!=='work')throw new Error('Expected work state');
  coding.agent='original-builder';coding.brief='Use the originally approved implementation brief.';
  const h=harness(root,workflow);
  let resumed:DispatchController|null=null,loads=0;
  try {
    expect((await h.asMain({op:'convene',parent:null,tickets:[{id:'A',issue:issueA,target,dependsOn:[],adoptPr:null}]})).ok).toBe(true);
    const id=h.controller.snapshot()!.id;await h.controller.shutdown();
    resumed=new DispatchController({files:createAgendaFiles(root),github:h.github,host:h.host,process:h.processes.spawn(102,'Sat Nov 7 06:05:00 2026'),cwd:root,workflow:async()=>{loads++;throw new Error('Current workflow is unavailable');},intervalSeconds:3600,pm:null,onChange:()=>{},onError:error=>h.errors.push(error)});
    const main:Caller={kind:'main',agentId:'successor',sessionId:'successor-main',sessionFile:null};resumed.setMain(main);
    expect((await resumed.execute(main,{op:'resume',agenda:id})).ok).toBe(true);
    expect((await resumed.execute(main,{op:'launch',ticketId:'A'})).ok).toBe(true);
    expect(loads).toBe(0);
    expect(h.launches[0]?.agent).toBe('original-builder');
    expect(h.launches[0]?.prompt).toContain('Use the originally approved implementation brief.');
    expect(resumed.snapshot()!.workflow).toEqual(workflow);
    expect(h.errors).toEqual([]);
  }finally {await resumed?.shutdown();await h.controller.shutdown();await rm(root,{recursive:true,force:true});}
});
