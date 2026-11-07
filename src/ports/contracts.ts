import type {ExtensionContext} from '@oh-my-pi/pi-coding-agent';
import type {Agenda,AgendaId,Caller,CheckAttempt,ClosureGate,CoordinatorProcess,DeepReadonly,CreatedIssueObservation,Facts,IssueRef,IssueSnapshot,Millis,PortError,PrRef,PrSnapshot,Repo,Result,Role,Sha,SourceScope,Target,Ticket,Tier} from '../domain/model.ts';

export type PrWrite = {headRepo:Repo;branch:string;head:Sha;target:Target;title:string;body:string};
export type IssueWrite = {repo:Repo;title:string;body:string};
/** The Project PM integration reads and writes: its owner login, number, and the name of its Status field. */
export type PmProjectSource = {owner:string;number:number;statusField:string};
export interface GitHubPort {
  facts(scope:SourceScope,cause:string):Promise<Result<Facts,PortError>>;
  contains(repo:Repo,ancestor:Sha,descendant:Sha):Promise<Result<'contains'|'notContained'|'missing',PortError>>;
  branchHead(repo:Repo,branch:string):Promise<Result<{kind:'missing'}|{kind:'present';head:Sha},PortError>>;
  issue(ref:IssueRef):Promise<Result<IssueSnapshot,PortError>>;
  pr(ref:PrRef):Promise<Result<PrSnapshot,PortError>>;
  openPrsByHead(headRepo:Repo,branch:string,target:Target):Promise<Result<readonly PrSnapshot[],PortError>>;
  issuesCreatedSince(repo:Repo,since:Millis):Promise<Result<readonly CreatedIssueObservation[],PortError>>;
  checkAttempt(repo:Repo,runId:number):Promise<Result<CheckAttempt,PortError>>;
  createIssue(input:IssueWrite):Promise<Result<IssueRef,PortError>>;
  addSubIssue(parent:IssueRef,child:IssueRef):Promise<Result<null,PortError>>;
  editIssueBody(issue:IssueRef,expectedHash:string,body:string):Promise<Result<null,PortError>>;
  setIssueOpen(issue:IssueRef,open:boolean):Promise<Result<null,PortError>>;
  createPr(input:PrWrite):Promise<Result<PrRef,PortError>>;
  editPr(pr:PrRef,input:PrWrite):Promise<Result<null,PortError>>;
  mergePr(pr:PrRef,head:Sha):Promise<Result<null,PortError>>;
  rerunCheck(repo:Repo,workflowRunId:number):Promise<Result<null,PortError>>;
  /** Posts a comment and returns its id. */
  comment(issue:IssueRef,body:string):Promise<Result<number,PortError>>;
  /** Selects the configured option name on the issue's item in the configured Project, adding the item first when missing. */
  setProjectField(issue:IssueRef,field:'status',option:string):Promise<Result<null,PortError>>;
}
/** A worker's decision item, as the intent guardians receive it: the implementation issue and the id of its `ask` comment. */
export type AskRequest = {issue:IssueRef;comment:number;question:string;tier:Tier};
/** The intent guardians' HTTP API. */
export interface GuardiansPort {
  /** Asks the guardians to settle `request`; they answer 202 when they accept it and 200 when they already hold that comment. */
  requestAnswer(request:AskRequest):Promise<Result<200|202,PortError>>;
}
export type StateError = {kind:'notFound'|'unsupportedFormat'|'corruptState'|'versionConflict'|'unavailable';message:string};
/** A workflow that cannot be read or parsed; `source` is the file path the reason refers to. */
export type WorkflowError = {source:string;reason:string};
/** One agenda file's indexable head: its id and lifecycle. */
export type AgendaEntry={id:AgendaId;lifecycle:'active'|'completed'};
export interface AgendaFiles {
  load(id:AgendaId):Promise<Result<Agenda,StateError>>;
  /** Indexable facts of each agenda file, without parsing its agenda body. */
  list():Promise<Result<readonly AgendaEntry[],StateError>>;
  /** Exact-target retries repair durability without inventing a new version. */
  save(expectedVersion:number|null,state:Agenda):Promise<Result<null,StateError>>;
}
export type FileMetrics = {replaces:number;unchangedReplaces:number};
/** Where a seat works: an Owner fork reuses its predecessor's checkout; every other seat gets a fresh detached worktree at an exact commit. `pull` names the PR whose head ref carries `sha`. */
export type SeatWorkspace={kind:'fork';sessionFile:string}|{kind:'base';target:Target}|{kind:'commit';repo:Repo;sha:Sha;pull:number|null};
/**
 * `seat` tells the host whether the seat works (writable, its checkout survives for rework forks) or judges (read-only,
 * blank session, disposable checkout). `resume` opens a work seat's first message when it resumes after its question
 * was answered: the configured resume prompt, then the answer.
 */
export type SeatLaunch = {agendaId:string;ticketId:string;revision:number;role:Role;seat:'work'|'judge';agent:string;cwd:string;prompt:string;resume:string|null;ticket:DeepReadonly<Ticket|ClosureGate>;workspace:SeatWorkspace};
export type SeatHandle = {agentId:string;sessionId:string;sessionFile:string;jobId:string};
export type SeatExit = {ticketId:string;role:Role;revision:number};
export interface HostPort {
  bind(ctx:ExtensionContext):Result<Caller,PortError>;
  launch(input:SeatLaunch):Promise<Result<SeatHandle,PortError>>;
  /** Whether every named agent can host a seat in this workspace, checked before a workflow is frozen into an agenda. */
  agents(cwd:string,names:readonly string[]):Promise<Result<null,PortError>>;
  active(ticketId:string,role:Role):boolean;
  /** Whether this host has started a seat for exactly this ticket, role and revision; a seat is one-shot per revision. */
  seated(ticketId:string,role:Role,revision:number):boolean;
  finish(agendaId:string):Promise<Result<null,PortError>>;
  dispose():Promise<void>;
}
/** What this host's OS reports for a pid: no process, or the start time of the process holding it now. */
export type ProcessStart={kind:'absent'}|{kind:'running';startedAt:string};
/** The OS's process table on the host that also holds the agenda state. */
export interface ProcessPort {
  /** The coordinator process this controller runs in. */
  current():Promise<Result<CoordinatorProcess,PortError>>;
  start(pid:number):Promise<Result<ProcessStart,PortError>>;
}
