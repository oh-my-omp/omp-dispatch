import {describe,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import type {Agenda,Caller,DomainError,Effect,Facts,IssueRef,IssueSnapshot,MaintenanceObservation,PrSnapshot,Repo,RepoSnapshot,Result,Role,Target,Ticket,Workflow} from '../src/domain/model.ts';
import {applyOperation,availableRoles,closureRoles,confirmEffect,createAgenda,effectPrecondition,failEffect,reconcile,satisfiedResult} from '../src/domain/engine.ts';
import {YAML} from 'bun';
import {encodeAgenda,parseAgenda} from '../src/domain/parse.ts';
import {encodeWorkflow,parseWorkflow,type TicketState} from '../src/domain/workflow.ts';

const defaultWorkflow=unwrap(parseWorkflow(YAML.parse(await Bun.file(new URL('../src/default-workflow.yml',import.meta.url)).text())),'default workflow');

// These typed in-memory source snapshots exercise domain transitions only.
// GitHub subprocess pagination and real TUI delivery have separate integration coverage.

const REPO:Repo={owner:'RiriAgent',name:'dispatch-lifecycle'};
const ISSUE:IssueRef={repo:REPO,number:189};
const PR:IssueRef={repo:REPO,number:99};
const TARGET:Target={repo:REPO,base:'main'};
const TICKET='T1';
const BRANCH='feature/189';
const CONTRACT='Deliver the ticket-state-machine regression.\n';
const DRIFTED_CONTRACT='Rewritten contract after approval.\n';
const PR_TITLE='Ticket lifecycle regression';
const PR_BODY='Closes #189';
const HEAD='1'.repeat(40);
const DRIFTED_HEAD='2'.repeat(40);
const MERGE='3'.repeat(40);
const BASE='4'.repeat(40);
const AT=1_000;
const MERGED_AT=3_000;
const CLOSED_AT=4_000;
const OWNER_SESSION='/tmp/dispatch/T1-owner.json';
const REVIEW_SESSION='/tmp/dispatch/T1-review.json';
const ACCEPT_SESSION='/tmp/dispatch/T1-accept.json';
const POST_MERGE_SESSION='/tmp/dispatch/T1-postmerge.json';

function sha256(value:string):string{return createHash('sha256').update(value).digest('hex');}

function unwrap<T,E>(result:Result<T,E>,label:string):T {
  if(!result.ok)throw new Error(`${label} failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

function ticketOf(state:Agenda,id=TICKET):Ticket {
  const ticket=state.tickets.find(item=>item.id===id);
  if(!ticket)throw new Error(`ticket ${id} is missing`);
  return ticket;
}

function effectOf(state:Agenda,match:(effect:Effect)=>boolean):Effect {
  const effect=state.effects.find(match);
  if(!effect)throw new Error('effect is missing');
  return effect;
}

function seat(role:Role,sessionFile:string,revision:number):Extract<Caller,{kind:'seat'}> {
  return {agentId:`${role}-agent`,sessionId:`${role}-session`,sessionFile,kind:'seat',ticketId:TICKET,role,revision};
}

function buildFacts(input:{
  issues:Facts['issues'];
  prs?:Facts['prs'];
  repos?:Facts['repos'];
  branches?:Facts['branches'];
  maintenance?:Facts['maintenance'];
}):Facts {
  return {
    viewer:'RiriAgent',
    issues:input.issues,
    prs:input.prs??[],
    links:[],
    repos:input.repos??[],
    branches:input.branches??[],
    maintenance:input.maintenance??[],
    commits:[],
    checkAttempts:[],
    createdIssues:[],
  };
}

function issueSnapshot(state:'open'|'closed',lastClose:IssueSnapshot['lastClose'],body=CONTRACT):IssueSnapshot {
  return {ref:ISSUE,body,bodyHash:sha256(body),updatedAt:1_000,state,lastClose,lastReopen:null,children:[]};
}

function repoSnapshot(head:string):RepoSnapshot {
  return {repo:REPO,defaultBranch:'main',defaultHead:head,bases:[{name:'main',state:{kind:'present',head,isDefault:true,rules:{required:[],strict:true,constraints:[]}}}]};
}

function branch(head:string):Facts['branches'][number] {
  return {repo:REPO,name:BRANCH,state:{kind:'present',head}};
}

const OPEN_STATE:PrSnapshot['state']={kind:'open'};
const MERGED_STATE:PrSnapshot['state']={kind:'merged',sha:MERGE,at:MERGED_AT};

const MAINTAINABLE:MaintenanceObservation={pr:PR,result:{kind:'maintainable',basis:{headRepo:REPO,headBranch:BRANCH,viewerPermission:'ADMIN',author:'RiriAgent',maintainerCanModify:true,authorization:{kind:'actorIsAuthor',actor:'RiriAgent'}}}};

/** Facts before the Owner opens a PR: only issue, target base, and branch exist. */
function openSource():Facts {
  return buildFacts({issues:[issueSnapshot('open',null)],repos:[repoSnapshot(BASE)],branches:[branch(HEAD)]});
}

/** Facts for a submitted or published ticket, with an observed PR at the given head. */
function scenario(options:{
  prHead:string;
  baseHead:string;
  prState:PrSnapshot['state'];
  issueState:'open'|'closed';
  lastClose?:IssueSnapshot['lastClose'];
  prBody?:string;
  contractBody?:string;
}):Facts {
  return buildFacts({
    issues:[issueSnapshot(options.issueState,options.lastClose??null,options.contractBody??CONTRACT)],
    repos:[repoSnapshot(options.baseHead)],
    branches:[branch(options.prHead)],
    prs:[{ref:PR,headRepo:REPO,headBranch:BRANCH,head:options.prHead,target:TARGET,title:PR_TITLE,body:options.prBody??PR_BODY,bodyHash:sha256(options.prBody??PR_BODY),updatedAt:2_000,state:options.prState,closes:[ISSUE],mergeable:'yes',checks:{kind:'passing',required:[]}}],
    maintenance:[MAINTAINABLE],
  });
}

function conveneTicket(workflow:Workflow=defaultWorkflow):Agenda {
  return unwrap(createAgenda({op:'convene',parent:null,tickets:[{id:TICKET,issue:ISSUE,target:TARGET,dependsOn:[],adoptPr:null}]},workflow,openSource(),AT,'agenda-1'),'convene');
}

/** Drive convene → Owner submit → source-confirmed publication (Reviewing with both gates pending). */
function publishTicket(workflow:Workflow=defaultWorkflow):{agenda:Agenda;facts:Facts} {
  const publishing=unwrap(applyOperation(conveneTicket(workflow),{op:'submit',ticketId:TICKET,revision:1,branch:BRANCH,head:HEAD,title:PR_TITLE,body:PR_BODY},seat('owner',OWNER_SESSION,1),openSource(),AT),'owner submit');
  const effect=effectOf(publishing,item=>item.action.kind==='publishPr');
  const facts=scenario({prHead:HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open'});
  const result=satisfiedResult(publishing,effect,facts);
  if(!result)throw new Error('publication was not source-confirmed');
  confirmEffect(publishing,effect,result,facts,AT);
  return {agenda:publishing,facts};
}

/** Drive publication → both gate approvals, which reconcile the ticket into Merging. */
function driveToMerging():{agenda:Agenda;facts:Facts} {
  const {agenda,facts}=publishTicket();
  const reviewed=unwrap(verdict(agenda,facts,'review'),'review verdict');
  const accepted=unwrap(verdict(reviewed,facts,'accept'),'accept verdict');
  return {agenda:accepted,facts};
}

describe('ticket delivery lifecycle',()=>{
  test('an Owner submission is published into the dual-gate review',()=>{
    const convened=conveneTicket();
    const coding=ticketOf(convened);
    expect(coding.state).toBe('Coding');
    expect(coding.sessions.owner).toBeUndefined();

    const submitted=unwrap(applyOperation(convened,{op:'submit',ticketId:TICKET,revision:coding.revision,branch:BRANCH,head:HEAD,title:PR_TITLE,body:PR_BODY},seat('owner',OWNER_SESSION,coding.revision),openSource(),AT),'owner submit');
    const publishing=ticketOf(submitted);
    expect(publishing.state).toBe('Publishing');
    expect(publishing.sessions.owner).toBe(OWNER_SESSION);

    const effect=effectOf(submitted,item=>item.action.kind==='publishPr');
    const facts=scenario({prHead:HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open'});
    expect(effect.state.kind).toBe('ready');
    expect(effectPrecondition(submitted,effect,facts)).toBeNull();

    const confirmed=satisfiedResult(submitted,effect,facts);
    if(!confirmed)throw new Error('publication was not source-confirmed');
    confirmEffect(submitted,effect,confirmed,facts,AT);

    const published=ticketOf(submitted);
    expect(published.state).toBe('Reviewing');
    expect(published.pr?.ref).toEqual(PR);
    expect(published.gates.Reviewing?.verdicts).toEqual([{role:'review',status:'pending',note:''},{role:'accept',status:'pending',note:''}]);
    expect(availableRoles(submitted,published)).toEqual(['review','accept']);
  });

  test('a rejecting review returns the ticket to Coding with its finding and owner session',()=>{
    const {agenda,facts}=publishTicket();
    const before=ticketOf(agenda);
    const rejecting=unwrap(applyOperation(agenda,{op:'verdict',ticketId:TICKET,revision:before.revision,role:'review',ok:false,note:'Missing regression for the drift check.'},seat('review',REVIEW_SESSION,before.revision),facts,AT),'review verdict');

    const after=ticketOf(rejecting);
    expect(after.state).toBe('Coding');
    expect(after.revision).toBe(before.revision+1);
    expect(after.gates.Reviewing).toBeUndefined();
    expect(after.gates.Verifying).toBeUndefined();
    expect(after.sessions.owner).toBe(OWNER_SESSION);
    const finding=after.notes.find(note=>note.author.kind==='seat'&&note.author.role==='review'&&note.kind==='finding');
    expect(finding?.text).toBe('Missing regression for the drift check.');
    expect(rejecting.effects.some(item=>item.action.kind==='merge')).toBe(false);
  });

  test('an accept rejection after a passing review resets both gates and returns to Coding',()=>{
    const {agenda,facts}=publishTicket();
    const revision=ticketOf(agenda).revision;
    const reviewed=unwrap(applyOperation(agenda,{op:'verdict',ticketId:TICKET,revision,role:'review',ok:true,note:'Review approves.'},seat('review',REVIEW_SESSION,revision),facts,AT),'review verdict');
    expect(ticketOf(reviewed).gates.Reviewing?.verdicts.find(verdict=>verdict.role==='review')?.status).toBe('passed');

    const rejected=unwrap(applyOperation(reviewed,{op:'verdict',ticketId:TICKET,revision,role:'accept',ok:false,note:'Accept demands a regression.'},seat('accept',ACCEPT_SESSION,revision),facts,AT),'accept verdict');
    const ticket=ticketOf(rejected);
    expect(ticket.state).toBe('Coding');
    expect(ticket.revision).toBe(revision+1);
    expect(ticket.gates.Reviewing).toBeUndefined();
    expect(ticket.gates.Verifying).toBeUndefined();
    expect(rejected.effects.some(item=>item.action.kind==='merge')).toBe(false);
  });

  test('both gate approvals merge and postMerge complete the ticket',()=>{
    const {agenda,facts}=driveToMerging();
    expect(ticketOf(agenda).state).toBe('Merging');
    const mergeEffect=effectOf(agenda,item=>item.action.kind==='merge');
    expect(effectPrecondition(agenda,mergeEffect,facts)).toBeNull();

    const mergedFacts=scenario({prHead:HEAD,baseHead:MERGE,prState:MERGED_STATE,issueState:'open'});
    const merged=satisfiedResult(agenda,mergeEffect,mergedFacts);
    if(!merged)throw new Error('merge was not source-confirmed');
    confirmEffect(agenda,mergeEffect,merged,mergedFacts,AT);

    const verifying=ticketOf(agenda);
    expect(verifying.state).toBe('Verifying');
    expect(verifying.terminal).toEqual({kind:'merged',pr:PR,mergeSha:MERGE,at:MERGED_AT});
    expect(verifying.gates.Verifying?.verdicts).toEqual([{role:'postMerge',status:'pending',note:''}]);

    const postMerged=unwrap(applyOperation(agenda,{op:'verdict',ticketId:TICKET,revision:verifying.revision,role:'postMerge',ok:true,note:'Post-merge verified.'},seat('postMerge',POST_MERGE_SESSION,verifying.revision),mergedFacts,AT),'postMerge verdict');
    expect(ticketOf(postMerged).gates.Verifying?.verdicts).toEqual([{role:'postMerge',status:'passed',note:'Post-merge verified.'}]);

    const closingEffect=effectOf(postMerged,item=>item.action.kind==='setIssueState'&&item.state.kind==='ready');
    const closedFacts=scenario({prHead:HEAD,baseHead:MERGE,prState:MERGED_STATE,issueState:'closed',lastClose:{id:'close-1',at:CLOSED_AT}});
    const closed=satisfiedResult(postMerged,closingEffect,closedFacts);
    if(!closed)throw new Error('issue closure was not source-confirmed');
    confirmEffect(postMerged,closingEffect,closed,closedFacts,AT);

    const done=ticketOf(postMerged);
    expect(done.state).toBe('Done');
    expect(availableRoles(postMerged,done)).toEqual([]);

    const terminal=structuredClone(postMerged);
    reconcile(postMerged,closedFacts,AT+100);
    expect(postMerged).toEqual(terminal);
    const reVerdict=applyOperation(postMerged,{op:'verdict',ticketId:TICKET,revision:done.revision,role:'postMerge',ok:true,note:'Post-merge again.'},seat('postMerge',POST_MERGE_SESSION,done.revision),closedFacts,AT);
    expect(reVerdict.ok).toBe(false);
    expect(postMerged).toEqual(terminal);
  });

  test('a drifted PR head after both approvals cancels the merge and escalates',()=>{
    const {agenda,facts}=driveToMerging();
    const mergeEffect=effectOf(agenda,item=>item.action.kind==='merge');
    const revision=ticketOf(agenda).revision;
    expect(effectPrecondition(agenda,mergeEffect,facts)).toBeNull();

    const drifted=scenario({prHead:DRIFTED_HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open'});
    reconcile(agenda,drifted,AT+100);
    const ticket=ticketOf(agenda);
    expect(ticket.state).toBe('Escalated');
    expect(ticket.revision).toBe(revision+1);
    expect(ticket.gates.Reviewing).toBeUndefined();
    expect(ticket.gates.Verifying).toBeUndefined();
    expect(effectPrecondition(agenda,mergeEffect,drifted)).not.toBeNull();

    const escalated=structuredClone(agenda);
    reconcile(agenda,drifted,AT+200);
    expect(agenda).toEqual(escalated);
  });

  test('review and accept open only once the PR is mergeable with passing required checks',()=>{
    const submitted=unwrap(applyOperation(conveneTicket(),{op:'submit',ticketId:TICKET,revision:1,branch:BRANCH,head:HEAD,title:PR_TITLE,body:PR_BODY},seat('owner',OWNER_SESSION,1),openSource(),AT),'owner submit');
    const effect=effectOf(submitted,item=>item.action.kind==='publishPr');
    const facts=scenario({prHead:HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open'});
    const pr=facts.prs[0]!;pr.mergeable='unknown';
    const published=satisfiedResult(submitted,effect,facts);
    if(!published)throw new Error('publication was not source-confirmed');
    confirmEffect(submitted,effect,published,facts,AT);
    expect(ticketOf(submitted).state).toBe('AwaitingChecks');
    expect(availableRoles(submitted,ticketOf(submitted))).toEqual([]);

    pr.mergeable='yes';pr.checks={kind:'pending',required:[{identity:{name:'ci',source:{kind:'any'}},head:HEAD}]};
    reconcile(submitted,facts,AT+1);
    expect(availableRoles(submitted,ticketOf(submitted))).toEqual([]);

    pr.checks={kind:'passing',required:[]};
    reconcile(submitted,facts,AT+2);
    expect(availableRoles(submitted,ticketOf(submitted))).toEqual(['review','accept']);
  });

  test('a new head on the open PR restarts both gates on its fingerprint instead of escalating',()=>{
    const {agenda,facts}=publishTicket();
    const revision=ticketOf(agenda).revision;
    const reviewed=unwrap(verdict(agenda,facts,'review'),'review verdict');
    reconcile(reviewed,scenario({prHead:DRIFTED_HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open'}),AT+1);
    const ticket=ticketOf(reviewed);
    expect(ticket.state).toBe('Reviewing');
    expect(ticket.revision).toBe(revision+2);
    expect(ticket.pr?.head).toBe(DRIFTED_HEAD);
    expect(ticket.gates.Reviewing).toMatchObject({stamp:{head:DRIFTED_HEAD},verdicts:[{role:'review',status:'pending'},{role:'accept',status:'pending'}]});
  });

  test('a contract body change after both approvals escalates without an authorized merge',()=>{
    const {agenda,facts}=driveToMerging();
    const mergeEffect=effectOf(agenda,item=>item.action.kind==='merge');
    expect(effectPrecondition(agenda,mergeEffect,facts)).toBeNull();

    const drifted=scenario({prHead:HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open',contractBody:DRIFTED_CONTRACT});
    reconcile(agenda,drifted,AT+100);
    expect(ticketOf(agenda).state).toBe('Escalated');
    expect(effectPrecondition(agenda,mergeEffect,drifted)).not.toBeNull();
  });

  test('a removed closing keyword after both approvals escalates without an authorized merge',()=>{
    const {agenda,facts}=driveToMerging();
    const mergeEffect=effectOf(agenda,item=>item.action.kind==='merge');
    expect(effectPrecondition(agenda,mergeEffect,facts)).toBeNull();

    const drifted=scenario({prHead:HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open',prBody:'Relates to #189'});
    reconcile(agenda,drifted,AT+100);
    expect(ticketOf(agenda).state).toBe('Escalated');
    expect(effectPrecondition(agenda,mergeEffect,drifted)).not.toBeNull();
  });

  test('reconcile and effect confirmation are idempotent while review is pending',()=>{
    const {agenda,facts}=publishTicket();
    const unpublished=structuredClone(agenda);
    reconcile(agenda,facts,AT);
    expect(agenda).toEqual(unpublished);

    const publishEffect=effectOf(agenda,item=>item.action.kind==='publishPr'&&item.state.kind==='confirmed');
    if(publishEffect.state.kind!=='confirmed')throw new Error('publishPr effect did not confirm');
    const confirmed=structuredClone(agenda);
    confirmEffect(agenda,publishEffect,publishEffect.state.result,facts,AT);
    expect(agenda).toEqual(confirmed);

    const {agenda:merging,facts:mergeFacts}=driveToMerging();
    const mergingSnapshot=structuredClone(merging);
    reconcile(merging,mergeFacts,AT);
    expect(merging).toEqual(mergingSnapshot);
    expect(merging.effects.filter(item=>item.action.kind==='merge').length).toBe(1);
  });
});

test('independent tickets are runnable while a dependent waits for source-confirmed noCode closure',()=>{
  const source=openSource();
  const second={repo:REPO,number:190},third={repo:REPO,number:191};
  source.issues.push({...issueSnapshot('open',null),ref:second},{...issueSnapshot('open',null),ref:third});
  let agenda=unwrap(createAgenda({op:'convene',parent:null,tickets:[
    {id:TICKET,issue:ISSUE,target:TARGET,dependsOn:[],adoptPr:null},
    {id:'B',issue:second,target:TARGET,dependsOn:[],adoptPr:null},
    {id:'C',issue:third,target:TARGET,dependsOn:[TICKET],adoptPr:null},
  ]},defaultWorkflow,source,AT,'agenda-parallel'),'convene parallel graph');
  const main:Caller={kind:'main',agentId:'Main',sessionId:'coordinator',sessionFile:null};
  agenda.run={kind:'attached',id:'run',mainAgentId:main.agentId,mainSessionId:main.sessionId,pid:101,startedAt:'Sat Nov 7 06:00:00 2026'};
  expect(availableRoles(agenda,ticketOf(agenda))).toEqual(['owner']);
  expect(availableRoles(agenda,ticketOf(agenda,'B'))).toEqual(['owner']);
  expect(availableRoles(agenda,ticketOf(agenda,'C'))).toEqual([]);
  agenda=unwrap(applyOperation(agenda,{op:'escalate',ticketId:TICKET,revision:1,kind:'noCode',reason:'The required behavior already exists.'},seat('owner',OWNER_SESSION,1),source,AT),'noCode escalation');
  agenda=unwrap(applyOperation(agenda,{op:'resolve',ticketId:TICKET,revision:ticketOf(agenda).revision,ruling:'Verified the existing behavior.',to:'Closing',noCode:'Already satisfied at source.'},main,source,AT),'noCode ruling');
  expect(ticketOf(agenda).state).not.toBe('Done');
  expect(availableRoles(agenda,ticketOf(agenda,'C'))).toEqual([]);
  source.issues[0]!.state='closed';
  source.issues[0]!.lastClose={id:'no-code-close',at:AT+1};
  const effect=effectOf(agenda,item=>item.action.kind==='setIssueState');
  const result=satisfiedResult(agenda,effect,source);
  if(!result)throw new Error('Closure was not observed');
  confirmEffect(agenda,effect,result,source,AT+1);
  expect(ticketOf(agenda).terminal?.kind).toBe('noCode');
  expect(ticketOf(agenda).state).toBe('Done');
  expect(availableRoles(agenda,ticketOf(agenda,'C'))).toEqual(['owner']);
});

test('a cyclic dependency graph is rejected before an agenda can run',()=>{
  const source=openSource(),other={repo:REPO,number:190};
  source.issues.push({...issueSnapshot('open',null),ref:other});
  const result=createAgenda({op:'convene',parent:null,tickets:[
    {id:'A',issue:ISSUE,target:TARGET,dependsOn:['B'],adoptPr:null},
    {id:'B',issue:other,target:TARGET,dependsOn:['A'],adoptPr:null},
  ]},defaultWorkflow,source,AT,'agenda-cycle');
  expect(result).toMatchObject({ok:false,error:{kind:'invalidTopology'}});
});

test('parent membership remains valid after a topology ruling and closure rejects ticket-only fields',()=>{
  const parent={repo:REPO,number:1},other={repo:REPO,number:190};
  const facts=openSource();
  facts.issues.push({...issueSnapshot('open',null),ref:other},{...issueSnapshot('open',null),ref:parent,children:[ISSUE,other]});
  const agenda=unwrap(createAgenda({op:'convene',parent,tickets:[
    {id:TICKET,issue:ISSUE,target:TARGET,dependsOn:[],adoptPr:null},
    {id:'other',issue:other,target:TARGET,dependsOn:[],adoptPr:null},
  ]},defaultWorkflow,facts,AT,'parent-agenda'),'parent convene');
  const main:Caller={kind:'main',agentId:'Main',sessionId:'parent-main',sessionFile:null};
  agenda.run={kind:'attached',id:'run',mainAgentId:main.agentId,mainSessionId:main.sessionId,pid:101,startedAt:'Sat Nov 7 06:00:00 2026'};
  expect(applyOperation(agenda,{op:'resolve',ticketId:TICKET,revision:1,to:'Coding',ruling:'Remove still attached child.',remove:['other']},main,facts,AT)).toMatchObject({ok:false,error:{kind:'invalidTopology'}});
  expect(applyOperation(agenda,{op:'resolve',ticketId:TICKET,revision:1,to:'Coding',ruling:'Add parent as child.',add:[{id:'parent',issue:parent,target:TARGET,dependsOn:[],adoptPr:null}]},main,facts,AT)).toMatchObject({ok:false,error:{kind:'invalidTopology'}});
  for(const ticket of agenda.tickets){ticket.state='Done';ticket.terminal={kind:'noCode',bodyHash:ticket.contract.bodyHash,reason:'Already satisfied',at:AT};}
  for(const issue of facts.issues)if(issue.ref.number!==parent.number)issue.state='closed';
  reconcile(agenda,facts,AT);
  const closure=agenda.closure;if(!closure)throw new Error('Expected closure');
  expect(applyOperation(agenda,{op:'resolve',ticketId:closure.id,revision:closure.revision,to:'Reviewing',ruling:'Invalid closure topology edit.',remove:['other']},main,facts,AT)).toMatchObject({ok:false,error:{kind:'invalidTransition'}});
});

test('GitHub draft and behind observations cannot authorize a merge or masquerade as a conflict',()=>{
  for(const status of ['behind','draft'] as const){
    const {agenda,facts}=driveToMerging();facts.prs[0]!.mergeable=status;
    reconcile(agenda,facts,AT);
    const ticket=ticketOf(agenda);
    expect(ticket.state).toBe(status==='behind'?'Coding':'Escalated');
    expect(ticket.gates.Reviewing).toBeUndefined();
    expect(ticket.notes.at(-1)?.text).not.toBe('PR conflicts with the target.');
    expect(effectPrecondition(agenda,effectOf(agenda,effect=>effect.action.kind==='merge'),facts)).not.toBeNull();
  }
});

test('Main revoking noCode cancels its queued close before coding resumes',()=>{
  const facts=openSource();
  let agenda=conveneTicket();
  const main:Caller={kind:'main',agentId:'Main',sessionId:'revocation-main',sessionFile:null};
  agenda.run={kind:'attached',id:'run',mainAgentId:main.agentId,mainSessionId:main.sessionId,pid:101,startedAt:'Sat Nov 7 06:00:00 2026'};
  agenda=unwrap(applyOperation(agenda,{op:'resolve',ticketId:TICKET,revision:1,to:'Closing',noCode:'Already satisfied.',ruling:'First inspection.'},main,facts,AT),'noCode');
  const close=effectOf(agenda,effect=>effect.action.kind==='setIssueState');
  expect(close.state.kind).toBe('ready');
  agenda=unwrap(applyOperation(agenda,{op:'resolve',ticketId:TICKET,revision:ticketOf(agenda).revision,to:'Coding',ruling:'New evidence requires code before closure.'},main,facts,AT+1),'revoke noCode');
  expect(ticketOf(agenda).state).toBe('Coding');
  expect(ticketOf(agenda).terminal).toBeNull();
  expect(effectOf(agenda,effect=>effect.action.kind==='setIssueState').state.kind).toBe('cancelled');
  expect(effectPrecondition(agenda,close,facts)).not.toBeNull();
});

test('postMerge keeps its merge anchor across independent target advances but rejects lost ancestry',()=>{
  const {agenda}=driveToMerging();
  const mergedFacts=scenario({prHead:HEAD,baseHead:MERGE,prState:MERGED_STATE,issueState:'closed',lastClose:{id:'merge-close',at:MERGED_AT}});
  const effect=effectOf(agenda,item=>item.action.kind==='merge');
  const result=satisfiedResult(agenda,effect,mergedFacts);
  if(!result)throw new Error('Merge was not source-confirmed');
  confirmEffect(agenda,effect,result,mergedFacts,AT);
  const revision=ticketOf(agenda).revision,stamp=structuredClone(ticketOf(agenda).gates.Verifying?.stamp);
  const advanced=scenario({prHead:HEAD,baseHead:DRIFTED_HEAD,prState:MERGED_STATE,issueState:'closed',lastClose:{id:'merge-close',at:MERGED_AT}});
  advanced.commits.push({repo:REPO,ancestor:MERGE,descendant:DRIFTED_HEAD,result:'contains'});
  reconcile(agenda,advanced,AT+1);
  expect(ticketOf(agenda).revision).toBe(revision);
  expect(ticketOf(agenda).gates.Verifying?.stamp).toEqual(stamp);
  const lost=structuredClone(agenda),rewritten=structuredClone(advanced);
  rewritten.commits[0]!.result='notContained';
  reconcile(lost,rewritten,AT+2);
  expect(ticketOf(lost).state).toBe('Escalated');
  expect(ticketOf(lost).gates.Verifying).toBeUndefined();
  const passed=unwrap(applyOperation(agenda,{op:'verdict',ticketId:TICKET,revision,role:'postMerge',ok:true,note:'Target still contains the exact merge after an independent delivery.'},seat('postMerge',POST_MERGE_SESSION,revision),advanced,AT+3),'stable postMerge');
  confirmSourceEffects(passed,advanced);
  expect(ticketOf(passed).state).toBe('Done');
});

test('closure fingerprints survive unrelated forward merges but reject lost child ancestry',()=>{
  const parent={repo:REPO,number:1};
  const source=scenario({prHead:HEAD,baseHead:MERGE,prState:MERGED_STATE,issueState:'closed',lastClose:{id:'child-close',at:MERGED_AT}});
  source.issues.push({...issueSnapshot('open',null),ref:parent,children:[ISSUE]});
  let agenda=unwrap(createAgenda({op:'convene',parent,tickets:[{id:TICKET,issue:ISSUE,target:TARGET,dependsOn:[],adoptPr:PR}]},defaultWorkflow,source,AT,'closure-anchor'),'adopt merged child');
  agenda=unwrap(verdict(agenda,source,'postMerge'),'postMerge');
  confirmSourceEffects(agenda,source);
  const closure=agenda.closure;if(!closure)throw new Error('Expected closure after child Done');
  const original=structuredClone(closure.gates.Reviewing!.stamp),revision=closure.revision;
  const advanced=structuredClone(source);
  const base=advanced.repos[0]!.bases[0]!;
  if(base.state.kind!=='present')throw new Error('Expected target');
  base.state.head=DRIFTED_HEAD;advanced.repos[0]!.defaultHead=DRIFTED_HEAD;
  advanced.commits.push({repo:REPO,ancestor:MERGE,descendant:DRIFTED_HEAD,result:'contains'});
  reconcile(agenda,advanced,AT+1);
  expect(agenda.closure?.revision).toBe(revision);
  expect(agenda.closure?.gates.Reviewing?.stamp).toEqual(original);
  const lost=structuredClone(agenda),rewritten=structuredClone(advanced);
  rewritten.commits[0]!.result='notContained';
  reconcile(lost,rewritten,AT+2);
  expect(lost.closure?.state).toBe('Escalated');
  const caller:Caller={kind:'seat',agentId:'closure',sessionId:'closure',sessionFile:'/tmp/closure.jsonl',ticketId:closure.id,revision,role:'closure'};
  const passed=unwrap(applyOperation(agenda,{op:'verdict',ticketId:closure.id,revision,role:'closure',ok:true,note:'Every terminal remains contained in the current target.'},caller,advanced,AT+3),'stable closure');
  expect(passed.closure?.gates.Reviewing?.verdicts).toEqual([{role:'closure',status:'passed',note:'Every terminal remains contained in the current target.'}]);
});

function ticketJudge(workflow:Workflow,name:string):Extract<TicketState,{kind:'judge'}> {
  const state=workflow.ticket.states[name];if(state?.kind!=='judge')throw new Error(`Expected judge ${name}`);return state;
}
function parentJudge(workflow:Workflow) {
  const state=workflow.parent.states.Reviewing!;if(state.kind!=='judge')throw new Error('Expected parent judge');return state;
}
function configured(change:(workflow:Workflow)=>void):Workflow {
  const workflow=structuredClone(defaultWorkflow);change(workflow);
  return unwrap(parseWorkflow(encodeWorkflow(workflow)),'custom workflow');
}
const customWorkflow=configured(workflow=>{
  ticketJudge(workflow,'Reviewing').judges=[{role:'security',agent:'task:mid',brief:'Audit the change.'},{role:'usability',agent:'task:mid',brief:'Check user behavior.'}];
  ticketJudge(workflow,'Verifying').judges=[{role:'deployment',agent:'task:mid',brief:'Verify the merged delivery.'}];
  parentJudge(workflow).judges=[{role:'product',agent:'task:mid',brief:'Check all child outcomes.'},{role:'operations',agent:'task:mid',brief:'Confirm readiness.'}];
});
function verdict(agenda:Agenda,facts:Facts,role:Role,ok=true,ticketId=TICKET):Result<Agenda,DomainError> {
  const revision=ticketId===agenda.closure?.id?agenda.closure.revision:ticketOf(agenda,ticketId).revision;
  return applyOperation(agenda,{op:'verdict',ticketId,revision,role,ok,note:`${role} ${ok?'approves':'rejects'} the delivery.`},{...seat(role,`/tmp/${role}.jsonl`,revision),ticketId},facts,AT);
}
function confirmSourceEffects(agenda:Agenda,facts:Facts):void {
  for(const effect of agenda.effects)if(effect.state.kind==='ready'){
    const result=satisfiedResult(agenda,effect,facts);if(result)confirmEffect(agenda,effect,result,facts,AT);
  }
}
function adoptMerged(workflow:Workflow,parent:IssueRef|null=null):{agenda:Agenda;facts:Facts} {
  const facts=scenario({prHead:HEAD,baseHead:MERGE,prState:MERGED_STATE,issueState:parent?'closed':'open',lastClose:parent?{id:'child-closed',at:CLOSED_AT}:null});
  if(parent)facts.issues.push({...issueSnapshot('open',null),ref:parent,children:[ISSUE]});
  const agenda=unwrap(createAgenda({op:'convene',parent,tickets:[{id:TICKET,issue:ISSUE,target:TARGET,dependsOn:[],adoptPr:PR}]},workflow,facts,AT,'aaaabbbb-1111-4111-8111-111111111111'),'adopt merged');
  if(parent)confirmSourceEffects(agenda,facts);
  return {agenda,facts};
}

test('a custom pullRequest roster requires both named judges before enqueuing merge',()=>{
  const {agenda,facts}=publishTicket(customWorkflow);
  expect(availableRoles(agenda,ticketOf(agenda))).toEqual(['security','usability']);
  const first=unwrap(verdict(agenda,facts,'security'),'first custom verdict');
  expect(ticketOf(first).state).toBe('Reviewing');
  expect(availableRoles(first,ticketOf(first))).toEqual(['usability']);
  expect(first.effects.filter(effect=>effect.action.kind==='merge')).toEqual([]);
  const second=unwrap(verdict(first,facts,'usability'),'second custom verdict');
  expect(ticketOf(second).state).toBe('Merging');
  expect(second.effects.filter(effect=>effect.action.kind==='merge')).toHaveLength(1);
});

test('either custom pullRequest judge can reject the delivery back to Coding',()=>{
  for(const role of ['security','usability']){
    const {agenda,facts}=publishTicket(customWorkflow);
    const other=role==='security'?'usability':'security';
    const approved=unwrap(verdict(agenda,facts,other),'other judge approval');
    const rejected=unwrap(verdict(approved,facts,role,false),'custom rejection');
    expect(ticketOf(rejected)).toMatchObject({state:'Coding',revision:ticketOf(approved).revision+1,gates:{}});
    expect(rejected.effects.some(effect=>effect.action.kind==='merge')).toBe(false);
    expect(ticketOf(rejected).notes.at(-1)).toMatchObject({author:{kind:'seat',role},kind:'finding',text:`${role} rejects the delivery.`});
  }
});

test('a verdict from another stage or an unknown role cannot approve a pullRequest',()=>{
  const {agenda,facts}=publishTicket(customWorkflow),before=structuredClone(agenda);
  for(const role of ['deployment','product','stranger'])expect(verdict(agenda,facts,role).ok).toBe(false);
  expect(agenda).toEqual(before);
  expect(availableRoles(agenda,ticketOf(agenda))).toEqual(['security','usability']);
});

test('an empty pullRequest roster still waits for mergeability and checks then merges without verdicts',()=>{
  const workflow=structuredClone(customWorkflow);ticketJudge(workflow,'Reviewing').judges=[];
  const facts=scenario({prHead:HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open'});
  facts.prs[0]!.mergeable='unknown';
  const agenda=unwrap(createAgenda({op:'convene',parent:null,tickets:[{id:TICKET,issue:ISSUE,target:TARGET,dependsOn:[],adoptPr:PR}]},workflow,facts,AT,'empty-review'),'adopt PR');
  expect(ticketOf(agenda)).toMatchObject({state:'AwaitingChecks',gates:{}});
  expect(agenda.effects).toEqual([]);
  facts.prs[0]!.mergeable='yes';facts.prs[0]!.checks={kind:'pending',required:[{identity:{name:'ci',source:{kind:'any'}},head:HEAD}]};
  reconcile(agenda,facts,AT+1);
  expect(ticketOf(agenda).state).toBe('AwaitingChecks');
  expect(agenda.effects).toEqual([]);
  facts.prs[0]!.checks={kind:'passing',required:[]};
  reconcile(agenda,facts,AT+2);
  expect(ticketOf(agenda)).toMatchObject({state:'Merging',gates:{Reviewing:{verdicts:[]}}});
  expect(availableRoles(agenda,ticketOf(agenda))).toEqual([]);
  expect(effectPrecondition(agenda,effectOf(agenda,effect=>effect.action.kind==='merge'),facts)).toBeNull();
});

test('an empty mergeCommit roster queues issue closure after merge confirmation and reaches Done',()=>{
  const workflow=structuredClone(customWorkflow);ticketJudge(workflow,'Reviewing').judges=[];ticketJudge(workflow,'Verifying').judges=[];
  const {agenda}=publishTicket(workflow);
  const facts=scenario({prHead:HEAD,baseHead:MERGE,prState:MERGED_STATE,issueState:'open'});
  const merge=effectOf(agenda,effect=>effect.action.kind==='merge');
  const merged=satisfiedResult(agenda,merge,facts);if(!merged)throw new Error('Expected merged source');
  confirmEffect(agenda,merge,merged,facts,AT);
  expect(ticketOf(agenda)).toMatchObject({state:'Closing',gates:{Verifying:{verdicts:[]}}});
  expect(availableRoles(agenda,ticketOf(agenda))).toEqual([]);
  const close=effectOf(agenda,effect=>effect.action.kind==='setIssueState');
  expect(close.action).toMatchObject({issue:ISSUE,open:false});
  expect(effectPrecondition(agenda,close,facts)).toBeNull();
  facts.issues[0]!.state='closed';facts.issues[0]!.lastClose={id:'closed',at:CLOSED_AT};
  const closed=satisfiedResult(agenda,close,facts);if(!closed)throw new Error('Expected issue closure');
  confirmEffect(agenda,close,closed,facts,AT);
  expect(ticketOf(agenda).state).toBe('Done');
});

test('a custom mergeCommit judge rejection escalates instead of returning to Coding',()=>{
  const {agenda,facts}=adoptMerged(customWorkflow);
  expect(availableRoles(agenda,ticketOf(agenda))).toEqual(['deployment']);
  const rejected=unwrap(verdict(agenda,facts,'deployment',false),'merged rejection');
  expect(ticketOf(rejected)).toMatchObject({state:'Escalated',revision:ticketOf(agenda).revision+1});
  expect(rejected.effects.some(effect=>effect.action.kind==='setIssueState')).toBe(false);
});

test('parent closure needs both custom judges and one failure escalates it',()=>{
  const parent={repo:REPO,number:1},workflow=structuredClone(customWorkflow);ticketJudge(workflow,'Verifying').judges=[];
  const {agenda,facts}=adoptMerged(workflow,parent),id=agenda.closure!.id;
  expect(closureRoles(agenda)).toEqual(['product','operations']);
  expect(agenda.effects.filter(effect=>effect.ticketId===id)).toEqual([]);
  const first=unwrap(verdict(agenda,facts,'product',true,id),'first parent verdict');
  expect(first.closure?.state).toBe('Reviewing');
  expect(closureRoles(first)).toEqual(['operations']);
  expect(first.effects.filter(effect=>effect.ticketId===id)).toEqual([]);
  const failed=unwrap(verdict(first,facts,'operations',false,id),'failed parent verdict');
  expect(failed.closure).toMatchObject({state:'Escalated',revision:2});
  expect(closureRoles(failed)).toEqual([]);
  expect(failed.effects.filter(effect=>effect.ticketId===id)).toEqual([]);
  const passed=unwrap(verdict(first,facts,'operations',true,id),'second parent verdict');
  const close=effectOf(passed,effect=>effect.ticketId===id&&effect.action.kind==='setIssueState');
  expect(effectPrecondition(passed,close,facts)).toBeNull();
  expect(close.action).toMatchObject({issue:parent,open:false});
  facts.issues.find(issue=>issue.ref.number===parent.number)!.state='closed';
  const closed=satisfiedResult(passed,close,facts);if(!closed)throw new Error('Expected parent closure');
  confirmEffect(passed,close,closed,facts,AT);
  expect(passed.closure?.state).toBe('Done');
});

test('an empty parent roster closes the parent without offering a seat',()=>{
  const parent={repo:REPO,number:1},workflow=structuredClone(customWorkflow);ticketJudge(workflow,'Verifying').judges=[];parentJudge(workflow).judges=[];
  const {agenda,facts}=adoptMerged(workflow,parent);
  expect(agenda.closure).toMatchObject({state:'Closing',gates:{Reviewing:{verdicts:[]}}});
  expect(closureRoles(agenda)).toEqual([]);
  const close=effectOf(agenda,effect=>effect.ticketId===agenda.closure!.id&&effect.action.kind==='setIssueState');
  expect(effectPrecondition(agenda,close,facts)).toBeNull();
  facts.issues.find(issue=>issue.ref.number===parent.number)!.state='closed';
  const closed=satisfiedResult(agenda,close,facts);if(!closed)throw new Error('Expected parent closure');
  confirmEffect(agenda,close,closed,facts,AT);
  expect(agenda.closure?.state).toBe('Done');
});

test('parseAgenda rejects missing, extra, reordered or wrong-stage pullRequest verdict roles',()=>{
  const {agenda}=publishTicket(customWorkflow);agenda.id='aaaabbbb-1111-4111-8111-111111111111';
  expect(parseAgenda(encodeAgenda(agenda)).ok).toBe(true);
  const original=ticketOf(agenda).gates.Reviewing!.verdicts;
  for(const roles of [['security'],['security','usability','extra'],['usability','security'],['security','deployment']]){
    const invalid=structuredClone(agenda);
    ticketOf(invalid).gates.Reviewing!.verdicts=roles.map(role=>({role,status:'pending',note:''}));
    expect(parseAgenda(encodeAgenda(invalid))).toMatchObject({ok:false,error:{path:'tickets'}});
  }
  expect(ticketOf(agenda).gates.Reviewing!.verdicts).toEqual(original);
});

test('parseAgenda rejects mergeCommit and parent verdicts outside their frozen rosters',()=>{
  const {agenda}=adoptMerged(customWorkflow);
  expect(parseAgenda(encodeAgenda(agenda)).ok).toBe(true);
  ticketOf(agenda).gates.Verifying!.verdicts[0]!.role='security';
  expect(parseAgenda(encodeAgenda(agenda))).toMatchObject({ok:false,error:{path:'tickets'}});
  const workflow=structuredClone(customWorkflow);ticketJudge(workflow,'Verifying').judges=[];
  const {agenda:parent}=adoptMerged(workflow,{repo:REPO,number:1});
  expect(parseAgenda(encodeAgenda(parent)).ok).toBe(true);
  parent.closure!.gates.Reviewing!.verdicts.reverse();
  expect(parseAgenda(encodeAgenda(parent))).toMatchObject({ok:false,error:{path:'closure'}});
});

function attachedMain(agenda:Agenda):Extract<Caller,{kind:'main'}> {
  const main:Extract<Caller,{kind:'main'}>={kind:'main',agentId:'Main',sessionId:'state-machine-main',sessionFile:null};
  agenda.run={kind:'attached',id:'run',mainAgentId:main.agentId,mainSessionId:main.sessionId,pid:101,startedAt:'Sat Nov 7 06:00:00 2026'};return main;
}
function submitAgain(agenda:Agenda,facts:Facts):Agenda {
  const revision=ticketOf(agenda).revision;
  const next=unwrap(applyOperation(agenda,{op:'submit',ticketId:TICKET,revision,branch:BRANCH,head:HEAD,title:PR_TITLE,body:PR_BODY},seat('owner',OWNER_SESSION,revision),facts,AT),'submit again');
  confirmSourceEffects(next,facts);return next;
}
function adoptOpen(workflow:Workflow,facts:Facts):Agenda {
  return unwrap(createAgenda({op:'convene',parent:null,tickets:[{id:TICKET,issue:ISSUE,target:TARGET,dependsOn:[],adoptPr:PR}]},workflow,facts,AT,'aaaabbbb-1111-4111-8111-111111111111'),'adopt open');
}

test('added pullRequest judge states are visited in their configured order',()=>{
  const workflow=configured(workflow=>{
    const reviewing=ticketJudge(workflow,'Reviewing');
    workflow.ticket.states.Security={...structuredClone(reviewing),judges:[{role:'security',agent:'task:mid',brief:'Inspect security.'}],on:{...reviewing.on,passed:{branches:[],otherwise:'Experience'}}};
    workflow.ticket.states.Experience={...structuredClone(reviewing),judges:[{role:'experience',agent:'task:mid',brief:'Inspect user behavior.'}]};
    reviewing.on.passed={branches:[],otherwise:'Security'};
    const merging=workflow.ticket.states.Merging!;
    if(merging.kind==='action'&&merging.action.kind==='merge')merging.action.requires=['Reviewing','Security','Experience'];
  });
  let {agenda,facts}=publishTicket(workflow);
  const seen=[ticketOf(agenda).state];
  agenda=unwrap(verdict(agenda,facts,'review'),'review');agenda=unwrap(verdict(agenda,facts,'accept'),'accept');
  seen.push(ticketOf(agenda).state);
  expect(availableRoles(agenda,ticketOf(agenda))).toEqual(['security']);
  expect(agenda.effects.some(effect=>effect.action.kind==='merge')).toBe(false);
  agenda=unwrap(verdict(agenda,facts,'security'),'security');seen.push(ticketOf(agenda).state);
  expect(availableRoles(agenda,ticketOf(agenda))).toEqual(['experience']);
  agenda=unwrap(verdict(agenda,facts,'experience'),'experience');seen.push(ticketOf(agenda).state);
  expect(seen).toEqual(['Reviewing','Security','Experience','Merging']);
  expect(ticketOf(agenda).visits).toMatchObject({Reviewing:1,Security:1,Experience:1,Merging:1});
  expect(agenda.effects.filter(effect=>effect.action.kind==='merge')).toHaveLength(1);
});

test('the same judge rejection follows Coding or Escalated according to its configured outcome',()=>{
  for(const [route,expected] of [['Coding','Coding'],['escalate','Escalated']] as const){
    const workflow=configured(workflow=>{ticketJudge(workflow,'Reviewing').on.rejected={branches:[],otherwise:route};});
    const {agenda,facts}=publishTicket(workflow);
    const rejected=unwrap(verdict(agenda,facts,'review',false),'configured rejection');
    expect(ticketOf(rejected).state).toBe(expected);
    expect(ticketOf(rejected).gates.Reviewing).toBeUndefined();
    expect(rejected.effects.some(effect=>effect.action.kind==='merge')).toBe(false);
  }
});

test('entry guards route false entries without seating judges and permit true entries',()=>{
  for(const atLeast of [2,1]){
    const workflow=configured(workflow=>{
      ticketJudge(workflow,'Reviewing').guard={when:{kind:'visits',state:'Coding',atLeast},otherwise:'Coding'};
    });
    const {agenda,facts}=publishTicket(workflow);
    if(atLeast===2){
      expect(ticketOf(agenda).state).toBe('Coding');
      expect(ticketOf(agenda).visits.Reviewing).toBeUndefined();
      expect(ticketOf(agenda).gates.Reviewing).toBeUndefined();
      expect(availableRoles(agenda,ticketOf(agenda))).toEqual(['owner']);
      const entered=submitAgain(agenda,facts);
      expect(ticketOf(entered).state).toBe('Reviewing');
      expect(ticketOf(entered).visits.Coding).toBe(2);
      expect(availableRoles(entered,ticketOf(entered))).toEqual(['review','accept']);
    }else{
      expect(ticketOf(agenda).state).toBe('Reviewing');
      expect(availableRoles(agenda,ticketOf(agenda))).toEqual(['review','accept']);
    }
  }
});

test('configured action X reruns each distinct failing actions run, while closeIssue at X closes the issue',()=>{
  for(const action of ['rerunChecks','closeIssue'] as const){
    const workflow=configured(workflow=>{
      const awaiting=workflow.ticket.states.AwaitingChecks!;if(awaiting.kind!=='decision')throw new Error('Expected decision');
      awaiting.observe.checksFailed='X';
      workflow.ticket.states.X={kind:'action',guard:null,action:action==='rerunChecks'?{kind:action}:{kind:action,requires:[]},on:{done:{branches:[],otherwise:'Coding'}}};
    });
    const facts=scenario({prHead:HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open'});
    if(action==='rerunChecks'){
      facts.prs[0]!.checks={kind:'failing',required:[
        ...[10,10,20].map((workflowRunId,index)=>({kind:'actions' as const,identity:{name:`job-${index}`,source:{kind:'any' as const}},checkRunId:index+1,workflowRunId,jobId:index+1,runAttempt:2,head:HEAD})),
        {kind:'status',identity:{name:'external',source:{kind:'any'}},context:'external',sha:HEAD},
      ]};
      const agenda=adoptOpen(workflow,facts);
      expect(ticketOf(agenda).state).toBe('X');
      expect(agenda.effects.map(effect=>effect.action)).toEqual([10,20].map(workflowRunId=>({kind:'rerunChecks',pr:PR,repo:REPO,workflowRunId,previousAttempt:2,head:HEAD})));
      expect(agenda.effects.every(effect=>effect.origin?.state==='X'&&effect.origin.revision===ticketOf(agenda).revision)).toBe(true);
    }else{
      const agenda=adoptOpen(workflow,facts),main=attachedMain(agenda);
      const closed=unwrap(applyOperation(agenda,{op:'resolve',ticketId:TICKET,revision:ticketOf(agenda).revision,to:'X',ruling:'No code is required.',noCode:'Already delivered.'},main,facts,AT),'configured close');
      expect(ticketOf(closed).state).toBe('X');
      expect(closed.effects.map(effect=>effect.action)).toEqual([{kind:'setIssueState',issue:ISSUE,open:false,bodyHash:facts.issues[0]!.bodyHash,afterEvent:null}]);
    }
  }
});

test('conditional outcomes use first-match order, fallback and visits across re-entries',()=>{
  const workflow=configured(workflow=>{
    const coding=workflow.ticket.states.Coding!;if(coding.kind!=='work')throw new Error('Expected work');
    workflow.ticket.states.Fallback=structuredClone(coding);
    ticketJudge(workflow,'Reviewing').on.rejected={branches:[
      {when:{kind:'visits',state:'Reviewing',atLeast:2},to:'escalate'},
      {when:{kind:'checks',is:'passing'},to:'Coding'},
    ],otherwise:'Fallback'};
  });
  const {agenda,facts}=publishTicket(workflow);
  const first=unwrap(verdict(agenda,facts,'review',false),'first rejection');
  expect(ticketOf(first).state).toBe('Coding');
  const second=submitAgain(first,facts);
  expect(ticketOf(second).visits).toMatchObject({Coding:2,Publishing:2,AwaitingChecks:2,Reviewing:2});
  const rejected=unwrap(verdict(second,facts,'review',false),'second rejection');
  expect(ticketOf(rejected).state).toBe('Escalated');
  const pending=structuredClone(facts);
  pending.prs[0]!.checks={kind:'pending',required:[{identity:{name:'ci',source:{kind:'any'}},head:HEAD}]};
  const fallback=unwrap(verdict(agenda,pending,'review',false),'fallback rejection');
  expect(ticketOf(fallback).state).toBe('Fallback');
  expect(availableRoles(fallback,ticketOf(fallback))).toEqual(['owner']);
});

test('Main cannot resolve directly to merge without a passed Reviewing gate',()=>{
  const {agenda,facts}=publishTicket(),main=attachedMain(agenda),before=structuredClone(agenda);
  const result=applyOperation(agenda,{op:'resolve',ticketId:TICKET,revision:ticketOf(agenda).revision,to:'Merging',ruling:'Attempt to bypass review.'},main,facts,AT);
  expect(result).toMatchObject({ok:false,error:{kind:'invalidTransition',message:expect.stringContaining('Reviewing has not approved')}});
  expect(agenda).toEqual(before);
  expect(agenda.effects.some(effect=>effect.action.kind==='merge')).toBe(false);
});

test('merge waits without an effect while checks are pending and resumes when they pass',()=>{
  const {agenda,facts}=publishTicket();
  const reviewed=unwrap(verdict(agenda,facts,'review'),'review');
  facts.prs[0]!.checks={kind:'pending',required:[{identity:{name:'ci',source:{kind:'any'}},head:HEAD}]};
  const merging=unwrap(verdict(reviewed,facts,'accept'),'accept while pending');
  expect(ticketOf(merging).state).toBe('Merging');
  expect(merging.effects.some(effect=>effect.action.kind==='merge')).toBe(false);
  reconcile(merging,facts,AT+1);
  expect(merging.effects.some(effect=>effect.action.kind==='merge')).toBe(false);
  facts.prs[0]!.checks={kind:'passing',required:[]};reconcile(merging,facts,AT+2);
  expect(merging.effects.filter(effect=>effect.action.kind==='merge')).toHaveLength(1);
});

test('merge waits without an effect until its dependency is delivered',()=>{
  const workflow=configured(workflow=>{
    workflow.ticket.adopted.pullRequest='Merging';
    const merging=workflow.ticket.states.Merging!;
    if(merging.kind==='action'&&merging.action.kind==='merge')merging.action.requires=[];
  });
  const facts=scenario({prHead:HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open'}),other={repo:REPO,number:190};
  facts.issues.push({...issueSnapshot('open',null),ref:other});
  let agenda=unwrap(createAgenda({op:'convene',parent:null,tickets:[
    {id:'dependency',issue:other,target:TARGET,dependsOn:[],adoptPr:null},
    {id:TICKET,issue:ISSUE,target:TARGET,dependsOn:['dependency'],adoptPr:PR},
  ]},workflow,facts,AT,'dependency-merge'),'convene dependent merge');
  expect(ticketOf(agenda).state).toBe('Merging');
  expect(agenda.effects).toEqual([]);
  const main=attachedMain(agenda);
  agenda=unwrap(applyOperation(agenda,{op:'resolve',ticketId:'dependency',revision:1,to:'Closing',ruling:'The dependency already exists.',noCode:'Already delivered.'},main,facts,AT),'close dependency');
  expect(agenda.effects.some(effect=>effect.action.kind==='merge')).toBe(false);
  facts.issues[1]!.state='closed';facts.issues[1]!.lastClose={id:'dependency-close',at:AT+1};
  confirmSourceEffects(agenda,facts);
  expect(ticketOf(agenda,'dependency').state).toBe('Done');
  expect(agenda.effects.filter(effect=>effect.action.kind==='merge')).toHaveLength(1);
});

test('leaving an action entry cancels its ready effects and a late confirmation does not advance the newer entry',()=>{
  let agenda=unwrap(applyOperation(conveneTicket(),{op:'submit',ticketId:TICKET,revision:1,branch:BRANCH,head:HEAD,title:PR_TITLE,body:PR_BODY},seat('owner',OWNER_SESSION,1),openSource(),AT),'submit');
  const origin=structuredClone(agenda.effects[0]!.origin),main=attachedMain(agenda);
  agenda=unwrap(applyOperation(agenda,{op:'resolve',ticketId:TICKET,revision:ticketOf(agenda).revision,to:'Coding',ruling:'Return to implementation before publishing.'},main,openSource(),AT),'leave publication');
  const effect=agenda.effects[0]!;
  expect(effect.state.kind).toBe('cancelled');
  expect(origin).toEqual({state:'Publishing',revision:2});
  const revision=ticketOf(agenda).revision;
  const facts=scenario({prHead:HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open'});
  const result=satisfiedResult(agenda,effect,facts);if(!result)throw new Error('Expected late source publication');
  confirmEffect(agenda,effect,result,facts,AT+1);
  expect(effect.state.kind).toBe('confirmed');
  expect(ticketOf(agenda)).toMatchObject({state:'Coding',revision});
  expect(ticketOf(agenda).visits.AwaitingChecks).toBeUndefined();
  expect(availableRoles(agenda,ticketOf(agenda))).toEqual(['owner']);
});

test('reopening a Done issue escalates the final-state invariant',()=>{
  let agenda=conveneTicket();const facts=openSource(),main=attachedMain(agenda);
  agenda=unwrap(applyOperation(agenda,{op:'resolve',ticketId:TICKET,revision:1,to:'Closing',ruling:'Already delivered.',noCode:'No code needed.'},main,facts,AT),'noCode');
  facts.issues[0]!.state='closed';facts.issues[0]!.lastClose={id:'closed',at:AT+1};confirmSourceEffects(agenda,facts);
  expect(ticketOf(agenda).state).toBe('Done');
  facts.issues[0]!.state='open';facts.issues[0]!.lastReopen={id:'reopened',at:AT+2};reconcile(agenda,facts,AT+2);
  expect(ticketOf(agenda).state).toBe('Escalated');
  expect(ticketOf(agenda).notes.at(-1)?.text).toContain('reopened');
});

test('decision states wait when no branch matches and move on a later source observation',()=>{
  const facts=scenario({prHead:HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open'});
  facts.prs[0]!.checks={kind:'pending',required:[{identity:{name:'ci',source:{kind:'any'}},head:HEAD}]};
  const agenda=adoptOpen(defaultWorkflow,facts),revision=ticketOf(agenda).revision;
  expect(ticketOf(agenda).state).toBe('AwaitingChecks');reconcile(agenda,facts,AT+1);
  expect(ticketOf(agenda).revision).toBe(revision);
  expect(availableRoles(agenda,ticketOf(agenda))).toEqual([]);
  expect(agenda.effects).toEqual([]);
  facts.prs[0]!.checks={kind:'passing',required:[]};reconcile(agenda,facts,AT+2);
  expect(ticketOf(agenda)).toMatchObject({state:'Reviewing',revision:revision+1});
  expect(availableRoles(agenda,ticketOf(agenda))).toEqual(['review','accept']);
});

test('an unconditional decision loop reaches the hop limit and escalates instead of hanging',()=>{
  const workflow=configured(workflow=>{
    const awaiting=workflow.ticket.states.AwaitingChecks!;if(awaiting.kind!=='decision')throw new Error('Expected decision');
    awaiting.branches=[{when:{kind:'checks',is:'passing'},to:'Loop'}];awaiting.otherwise='Reviewing';
    workflow.ticket.states.Loop={kind:'decision',guard:null,observe:structuredClone(awaiting.observe),branches:[],otherwise:'AwaitingChecks'};
  });
  const facts=scenario({prHead:HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open'}),agenda=adoptOpen(workflow,facts);
  expect(ticketOf(agenda).state).toBe('Escalated');
  expect(ticketOf(agenda).notes.at(-1)?.text).toContain('64 states without waiting');
  expect(ticketOf(agenda).visits.Loop).toBe(32);
  expect(agenda.effects).toEqual([]);
});

describe('review regressions',()=>{
  const parent={repo:REPO,number:1};
  function closedParent(){
    const workflow=structuredClone(customWorkflow);ticketJudge(workflow,'Verifying').judges=[];parentJudge(workflow).judges=[];
    const {agenda,facts}=adoptMerged(workflow,parent),id=agenda.closure!.id;
    const close=effectOf(agenda,effect=>effect.ticketId===id&&effect.action.kind==='setIssueState');
    facts.issues.find(issue=>issue.ref.number===parent.number)!.state='closed';
    confirmEffect(agenda,close,satisfiedResult(agenda,close,facts)!,facts,AT);
    return {agenda,facts,close};
  }
  test('a delivered parent escalates when its issue is reopened, and finish is refused',()=>{
    const {agenda,facts}=closedParent();
    expect(agenda.closure?.state).toBe('Done');
    facts.issues.find(issue=>issue.ref.number===parent.number)!.state='open';
    reconcile(agenda,facts,AT+1);
    expect(agenda.closure?.state).toBe('Escalated');
    expect(applyOperation(agenda,{op:'finish',summary:'Delivered.'},attachedMain(agenda),facts,AT+2)).toMatchObject({ok:false,error:{kind:'invalidTransition'}});
  });
  test('a parent machine whose initial state is final does not deliver an open parent',()=>{
    const workflow=configured(workflow=>{workflow.parent={initial:'Done',states:{Done:{kind:'final',guard:null}}};ticketJudge(workflow,'Verifying').judges=[];});
    const {agenda}=adoptMerged(workflow,parent);
    expect(agenda.closure?.state).toBe('Escalated');
    expect(agenda.closure?.notes.at(-1)).toContain('the parent issue is not closed');
  });
  test('a failed parent close can be cancelled through resolve and the parent re-reviewed',()=>{
    const workflow=structuredClone(customWorkflow);ticketJudge(workflow,'Verifying').judges=[];parentJudge(workflow).judges=[];
    const {agenda,facts}=adoptMerged(workflow,parent),id=agenda.closure!.id;
    const close=effectOf(agenda,effect=>effect.ticketId===id&&effect.action.kind==='setIssueState');
    failEffect(agenda,close,{kind:'permission',message:'Forbidden'},false,AT);
    expect(agenda.closure?.state).toBe('Escalated');
    const resolved=unwrap(applyOperation(agenda,{op:'resolve',ticketId:id,revision:agenda.closure!.revision,ruling:'Permission fixed; close again.',to:'Reviewing',effects:[{effectId:close.id,disposition:'cancel'}]},attachedMain(agenda),facts,AT),'closure resolve');
    expect(resolved.effects.find(effect=>effect.id===close.id)?.state.kind).toBe('cancelled');
    expect(resolved.effects.filter(effect=>effect.ticketId===id&&effect.state.kind==='ready')).toHaveLength(1);
    expect(resolved.closure?.state).toBe('Closing');
  });
  test('a noCode ruling whose entry condition redirects away from closing is refused',()=>{
    const workflow=configured(workflow=>{workflow.ticket.states.Done={kind:'final',guard:{when:{kind:'visits',state:'Coding',atLeast:3},otherwise:'Coding'}};});
    const agenda=conveneTicket(workflow);
    const result=applyOperation(agenda,{op:'resolve',ticketId:TICKET,revision:1,ruling:'Already satisfied.',to:'Done',noCode:'Nothing to change.'},attachedMain(agenda),openSource(),AT);
    expect(result).toMatchObject({ok:false,error:{kind:'invalidTransition',message:expect.stringContaining('noCode must land')}});
  });
  test('an adopted ticket has not visited the initial work state',()=>{
    const agenda=adoptOpen(defaultWorkflow,scenario({prHead:HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open'}));
    expect(ticketOf(agenda).visits.Coding).toBeUndefined();
    expect(ticketOf(agenda).visits.AwaitingChecks).toBe(1);
  });
  test('changing the target drops work sessions so the next work seat checks out the new target',()=>{
    const {agenda,facts}=publishTicket();
    expect(ticketOf(agenda).sessions).toEqual({owner:OWNER_SESSION});
    const moved=unwrap(applyOperation(agenda,{op:'resolve',ticketId:TICKET,revision:ticketOf(agenda).revision,ruling:'Deliver on release instead.',to:'Coding',target:{repo:REPO,base:'release'}},attachedMain(agenda),facts,AT),'retarget');
    expect(ticketOf(moved)).toMatchObject({state:'Coding',target:{repo:REPO,base:'release'},sessions:{}});
  });
  test('a state that waits on the 64th entry is entered rather than escalated as a loop',()=>{
    const workflow=configured(workflow=>{
      for(let index=1;index<=63;index++)workflow.ticket.states[`D${index}`]={kind:'decision',guard:null,observe:structuredClone((workflow.ticket.states.AwaitingChecks as Extract<TicketState,{kind:'decision'}>).observe),branches:[],otherwise:index===63?'Reviewing':`D${index+1}`};
      workflow.ticket.adopted.pullRequest='D1';
    });
    const agenda=adoptOpen(workflow,scenario({prHead:HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open'}));
    expect(ticketOf(agenda).state).toBe('Reviewing');
    expect(availableRoles(agenda,ticketOf(agenda))).toEqual(['review','accept']);
  });
});
