/**
 * The #218 §7 load: a real DispatchController on fixture ports and real agenda files, holding a large agenda
 * (20 tickets × 200 notes, 100 settled effects per ticket). It runs N unchanged `run()` ticks, N `status` and
 * N `read` calls, up to 20 ticks that each escalate one ticket, and N Main resolutions that each persist the agenda, and prints one JSON line of metrics per
 * phase. The tool texts and agenda files it writes to `<out>` are normalized (agenda id, run id, data root) so
 * runs on different commits diff byte for byte.
 *
 *   bun tests/bench/agenda-load.ts <out-dir> [N]
 */
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {heapStats} from 'bun:jsc';
import {YAML} from 'bun';
import type {Caller,Facts,PortError,Result} from '../../src/domain/model.ts';
import type {AgendaFiles,GitHubPort,HostPort,ProcessPort} from '../../src/ports/contracts.ts';
import {createAgendaFiles} from '../../src/ports/state.ts';
import {DispatchController} from '../../src/runtime/controller.ts';
import {bodyHash} from '../../src/domain/identity.ts';
import {parseWorkflow} from '../../src/domain/workflow.ts';

const out=process.argv[2];
if(!out)throw new Error('usage: bun tests/bench/agenda-load.ts <out-dir> [N]');
const N=Number(process.argv[3]??50);
const TICKETS=20,NOTES=200,EFFECTS=100;

// Every timestamp the controller records comes from this clock, so two runs write the same bytes.
let clock=1_800_000_000_000;
Date.now=()=>++clock;

const parsedWorkflow=parseWorkflow(YAML.parse(await Bun.file(new URL('../../src/default-workflow.yml',import.meta.url)).text()));
if(!parsedWorkflow.ok)throw new Error(parsedWorkflow.error.reason);
const workflow=parsedWorkflow.value;
const repository={owner:'bench',name:'dispatch'},target={repo:repository,base:'main'},BASE='a'.repeat(40);
const issues=Array.from({length:TICKETS},(_,index)=>({repo:repository,number:index+1}));
function success<T>(value:T):Result<T,PortError>{return {ok:true,value};}
function unexpected():never {throw new Error('Unexpected port call');}

const source:Facts={viewer:'bench',prs:[],links:[],maintenance:[],commits:[],checkAttempts:[],createdIssues:[],branches:[],
  issues:issues.map(ref=>({ref,body:`Deliver ${ref.number}.`,bodyHash:bodyHash(`Deliver ${ref.number}.`),updatedAt:1,state:'open' as const,lastClose:null,lastReopen:null,children:[],pm:null})),
  repos:[{repo:repository,defaultBranch:'main',defaultHead:BASE,bases:[{name:'main',state:{kind:'present',head:BASE,isDefault:true,rules:{required:[],strict:false,constraints:[]}}}]}]};
// The fixture's own copies are not agenda copies, so they bypass the clone counter below.
const realClone=globalThis.structuredClone;
const github:GitHubPort={facts:async()=>success(realClone(source)),openPrsByHead:async()=>success([]),contains:async()=>success('contains'),
  branchHead:unexpected,issue:unexpected,pr:unexpected,issuesCreatedSince:unexpected,checkAttempt:unexpected,createIssue:unexpected,addSubIssue:unexpected,editIssueBody:unexpected,
  setIssueOpen:unexpected,editPr:unexpected,rerunCheck:unexpected,createPr:unexpected,mergePr:unexpected,comment:unexpected,setProjectField:unexpected};
const host:HostPort={agents:async()=>success(null),bind:unexpected,finish:async()=>success(null),dispose:async()=>{},active:()=>false,seated:()=>false,launch:unexpected};
const running=new Map<number,string>();
function processPort(pid:number):ProcessPort {
  running.set(pid,`start-${pid}`);
  return {current:async()=>success({pid,startedAt:`start-${pid}`}),start:async target=>{const found=running.get(target);return success(found===undefined?{kind:'absent'}:{kind:'running',startedAt:found});}};
}
const main:Extract<Caller,{kind:'main'}>={kind:'main',agentId:'Main',sessionId:'main',sessionFile:null};

const root=await mkdtemp(join(tmpdir(),'dispatch-bench-'));
const counters={saves:0,changes:0};
function controller(pid:number,files:AgendaFiles):DispatchController {
  const counted:AgendaFiles={load:id=>files.load(id),list:()=>files.list(),save:(expected,state)=>{counters.saves++;return files.save(expected,state);}};
  const dispatch=new DispatchController({issue:issues[0]!,files:counted,github,host,process:processPort(pid),cwd:root,workflow:async()=>({ok:true,value:workflow}),intervalSeconds:3600,pm:null,
    onChange:()=>{counters.changes++;},onError:error=>{throw new Error(`Dispatch runtime error: ${JSON.stringify(error)}`);}});
  dispatch.setMain(main);return dispatch;
}
function must<T>(result:Result<T,unknown>):T {if(!result.ok)throw new Error(JSON.stringify(result.error));return result.value;}

try {
  // Convene the agenda through the controller, then grow its append-only records on disk and resume it.
  const files=createAgendaFiles(root),first=controller(101,files);
  must(await first.execute(main,{op:'convene',parent:null,tickets:issues.map(issue=>({id:`T${issue.number}`,issue,target,dependsOn:[],adoptPr:null}))}));
  const agendaId=first.snapshot()!.id;
  await first.shutdown();running.delete(101);
  const path=join(root,'state',`${agendaId}.json`);
  const envelope=JSON.parse(await readFile(path,'utf8'));
  let effectId=envelope.state.nextId;
  for(const ticket of envelope.state.tickets){
    for(let index=0;index<NOTES;index++)ticket.notes.push({at:++clock,author:{kind:'system'},kind:'sourceChange',text:`Observation ${index} of ${ticket.id}: the source changed and the ticket kept its state while the relay waited.`});
    for(let index=0;index<EFFECTS;index++)envelope.state.effects.push({id:`${agendaId}/effect/${effectId++}`,ticketId:ticket.id,
      action:{kind:'setIssueState',issue:ticket.issue,open:false,bodyHash:ticket.contract.bodyHash,afterEvent:null},origin:null,attempt:1,state:{kind:'cancelled',reason:'The state that requested this effect has been left'}});
  }
  envelope.state.nextId=effectId;
  await writeFile(path,`${JSON.stringify(envelope)}\n`);
  const dispatch=controller(102,files);
  must(await dispatch.execute(main,{op:'resume',agenda:agendaId}));
  // Let the resume's own kick settle before measuring.
  await Bun.sleep(10);await dispatch.run();

  const normalize=(text:string):string=>text.replaceAll(agendaId,'<agenda>').replaceAll(dispatch.runId,'<run>').replaceAll(root,'<root>');
  await mkdir(out,{recursive:true});
  let clones=0;
  function counted<T>(value:T,options?:StructuredSerializeOptions):T {clones++;return realClone(value,options);}
  globalThis.structuredClone=counted;
  async function phase(name:string,work:()=>Promise<void>):Promise<void> {
    const version=dispatch.snapshot()!.version,before={saves:counters.saves,changes:counters.changes};
    Bun.gc(true);const start=process.memoryUsage().heapUsed,objects=heapStats().objectCount;clones=0;
    const began=performance.now();
    await work();
    const ms=performance.now()-began,grown=process.memoryUsage().heapUsed-start,objectsGrown=heapStats().objectCount-objects,cloned=clones;
    Bun.gc(true);const heapDelta=process.memoryUsage().heapUsed-start;
    console.log(JSON.stringify({phase:name,n:N,clones:cloned,saves:counters.saves-before.saves,onChange:counters.changes-before.changes,versionBefore:version,versionAfter:dispatch.snapshot()!.version,
      heapGrowthNoGc:grown,objectGrowthNoGc:objectsGrown,heapDelta,ms:Math.round(ms)}));
  }
  const fileBefore=await readFile(path,'utf8');
  await phase('tick',async()=>{for(let index=0;index<N;index++)await dispatch.run();});
  const fileAfterTicks=await readFile(path,'utf8');
  await writeFile(join(out,'agenda-after-ticks.json'),normalize(fileAfterTicks));
  console.log(JSON.stringify({phase:'tick-file',unchanged:fileAfterTicks===fileBefore}));
  // The tool text is exactly what the dispatch tool returns: JSON.stringify of the controller's result.
  let status='',read='';
  await phase('status',async()=>{for(let index=0;index<N;index++)status=JSON.stringify(await dispatch.execute(main,{op:'status'}));});
  await phase('read',async()=>{for(let index=0;index<N;index++)read=JSON.stringify(await dispatch.execute(main,{op:'read',ticketId:`T${index%TICKETS+1}`}));});
  await writeFile(join(out,'status.json'),normalize(status));
  await writeFile(join(out,'read.json'),normalize(read));
  // Ticks that do change the agenda: each rewrites one ticket's issue body, which escalates that ticket.
  await phase('changed-tick',async()=>{
    for(let index=0;index<Math.min(N,TICKETS);index++){
      const issue=source.issues[index]!;issue.body=`Deliver ${index+1}, rewritten.`;issue.bodyHash=bodyHash(issue.body);
      await dispatch.run();
    }
  });
  await writeFile(join(out,'agenda-after-changes.json'),normalize(await readFile(path,'utf8')));
  let resolved='';
  await phase('resolve',async()=>{
    for(let index=0;index<N;index++){
      const ticketId=`T${index%TICKETS+1}`,revision=dispatch.snapshot()!.tickets.find(ticket=>ticket.id===ticketId)!.revision;
      resolved=JSON.stringify(must(await dispatch.execute(main,{op:'resolve',ticketId,revision,ruling:`Ruling ${index}: keep coding on the current contract.`,to:'Coding'})));
    }
  });
  globalThis.structuredClone=realClone;
  await writeFile(join(out,'resolve.json'),normalize(resolved));
  await writeFile(join(out,'agenda-final.json'),normalize(await readFile(path,'utf8')));
  await dispatch.shutdown();
}finally {await rm(root,{recursive:true,force:true});}
