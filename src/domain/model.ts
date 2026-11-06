import { z, type ZodLikeSchema } from '@oh-my-pi/omptype/zod';
import { markerFactSchema } from '../pm/markers.ts';
import { buildPublicGrammar } from './public-grammar.ts';

export const {text,ordinal,revision,millisSchema,shaSchema,hashSchema,idSchema,agendaIdSchema,repoSchema,issueRefSchema,prRefSchema,shaRefSchema,targetSchema,roleSchema,tierSchema,entrySchema,conveneSchema,actionSchema,portInputSchema,toolParametersSchema} = buildPublicGrammar(z);
const object = <const S extends Readonly<Record<string,ZodLikeSchema<unknown>>>>(shape:S) => z.object(shape).strict();
export type Result<T,E> = {ok:true;value:T}|{ok:false;error:E};
export type AgendaId = string;
export type TicketId = string;
export type EffectId = string;
export type RunId = string;
export type Millis = number;
export type Sha = string;
export type Hash = string;
export type Repo = z.infer<typeof repoSchema>;
export type IssueRef = z.infer<typeof issueRefSchema>;
export type PrRef = IssueRef;
export type ShaRef = z.infer<typeof shaRefSchema>;
export type Target = z.infer<typeof targetSchema>;
export type Entry = z.infer<typeof entrySchema>;
export type ConveneInput = z.infer<typeof conveneSchema>;
export type PortInput = z.infer<typeof portInputSchema>;
export type ToolParameters = z.infer<typeof toolParametersSchema>;
export type Role = z.infer<typeof roleSchema>;
export type Tier = z.infer<typeof tierSchema>;
import type {Workflow} from './workflow.ts';
export type {Workflow};
export type Action = z.infer<typeof actionSchema>;
export const lifecycleEventSchema = object({ id: text, at: millisSchema });
export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>;
/** What PM integration observes on an issue: its marker comments and its item in the configured Project; null when PM is off. */
export const issuePmSchema = object({ markers: z.array(markerFactSchema), item: object({ id: text, status: text.nullable() }).nullable() });
export type IssuePm = z.infer<typeof issuePmSchema>;
export const issueSnapshotSchema = object({ ref: issueRefSchema, body: z.string(), bodyHash: hashSchema, updatedAt: millisSchema, state: z.enum(['open','closed']), lastClose: lifecycleEventSchema.nullable(), lastReopen: lifecycleEventSchema.nullable(), children: z.array(issueRefSchema), pm: issuePmSchema.nullable() });
export type IssueSnapshot = z.infer<typeof issueSnapshotSchema>;
export const requiredCheckIdentitySchema = object({ name: text, source: z.union([object({kind:z.literal('any')}),object({kind:z.literal('app'),id:revision})]) });
export type RequiredCheckIdentity = z.infer<typeof requiredCheckIdentitySchema>;
export const checkFailureSchema = z.union([
  object({kind:z.literal('actions'), identity:requiredCheckIdentitySchema,checkRunId:revision,workflowRunId:revision,jobId:revision,runAttempt:revision,head:shaSchema}),
  object({kind:z.literal('status'),identity:requiredCheckIdentitySchema,context:text,sha:shaSchema}),
]);
export type CheckFailure = z.infer<typeof checkFailureSchema>;
export const pendingCheckSchema = object({identity:requiredCheckIdentitySchema,head:shaSchema});
export const checksSchema = z.union([
  object({kind:z.literal('passing'),required:z.array(requiredCheckIdentitySchema)}),
  object({kind:z.literal('failing'),required:z.array(checkFailureSchema).min(1)}),
  object({kind:z.literal('pending'),required:z.array(pendingCheckSchema).min(1)}),
  object({kind:z.literal('unknown'),reason:text}),
]);
export type ChecksSnapshot = z.infer<typeof checksSchema>;
export const mergeRequirementsSchema = object({required:z.array(requiredCheckIdentitySchema),strict:z.boolean(),constraints:z.array(text)});
export type MergeRequirements = z.infer<typeof mergeRequirementsSchema>;
export const prStateSchema = z.union([
  object({kind:z.literal('open')}),object({kind:z.literal('closed')}),
  object({kind:z.literal('merged'),sha:shaSchema,at:millisSchema}),
]);
export const prSnapshotSchema = object({ref:prRefSchema,headRepo:repoSchema,headBranch:text,head:shaSchema,target:targetSchema,title:text,body:z.string(),bodyHash:hashSchema,updatedAt:millisSchema,state:prStateSchema,closes:z.array(issueRefSchema),mergeable:z.enum(['yes','no','behind','draft','unknown']),checks:checksSchema});
export type PrSnapshot = z.infer<typeof prSnapshotSchema>;
export const baseSnapshotSchema = object({name:text,state:z.union([
  object({kind:z.literal('missing')}),object({kind:z.literal('present'),head:shaSchema,isDefault:z.boolean(),rules:mergeRequirementsSchema}),
])});
export type BaseSnapshot = z.infer<typeof baseSnapshotSchema>;
export const repoSnapshotSchema = object({repo:repoSchema,defaultBranch:text,defaultHead:shaSchema,bases:z.array(baseSnapshotSchema)});
export type RepoSnapshot = z.infer<typeof repoSnapshotSchema>;
export const branchSnapshotSchema = object({repo:repoSchema,name:text,state:z.union([object({kind:z.literal('missing')}),object({kind:z.literal('present'),head:shaSchema})])});
export type BranchSnapshot = z.infer<typeof branchSnapshotSchema>;
export const commitObservationSchema = object({repo:repoSchema,ancestor:shaSchema,descendant:shaSchema,result:z.enum(['contains','notContained','missing'])});
export type CommitObservation = z.infer<typeof commitObservationSchema>;
export const maintenanceBasisSchema = object({headRepo:repoSchema,headBranch:text,viewerPermission:z.enum(['ADMIN','MAINTAIN','WRITE','TRIAGE','READ','NONE']),author:text,maintainerCanModify:z.boolean(),authorization:z.union([
  object({kind:z.literal('actorIsAuthor'),actor:text}),object({kind:z.literal('systemCreated'),effectId:idSchema}),object({kind:z.literal('authorAuthorized'),evidence:text}),object({kind:z.literal('none')}),
])});
export type MaintenanceBasis = z.infer<typeof maintenanceBasisSchema>;
export const maintenanceObservationSchema = object({pr:prRefSchema,result:z.union([
  object({kind:z.literal('maintainable'),basis:maintenanceBasisSchema}),object({kind:z.literal('foreign'),basis:maintenanceBasisSchema}),object({kind:z.literal('unknown'),reason:text}),
])});
export type MaintenanceObservation = z.infer<typeof maintenanceObservationSchema>;
export const closingLinkSchema = object({issue:issueRefSchema,pr:prRefSchema});
export const checkAttemptSchema = object({repo:repoSchema,workflowRunId:revision,attempt:revision,head:shaSchema});
export type CheckAttempt = z.infer<typeof checkAttemptSchema>;
export const createdIssueObservationSchema = object({issue:issueRefSchema,title:text,body:z.string(),actor:text,createdAt:millisSchema});
export type CreatedIssueObservation = z.infer<typeof createdIssueObservationSchema>;
export const factsSchema = object({viewer:text,issues:z.array(issueSnapshotSchema),prs:z.array(prSnapshotSchema),links:z.array(closingLinkSchema),repos:z.array(repoSnapshotSchema),branches:z.array(branchSnapshotSchema),maintenance:z.array(maintenanceObservationSchema),commits:z.array(commitObservationSchema),checkAttempts:z.array(checkAttemptSchema),createdIssues:z.array(createdIssueObservationSchema)});
export type Facts = z.infer<typeof factsSchema>;
export const maintenanceIntentSchema = z.union([
  object({kind:z.literal('systemCreated'),pr:prRefSchema,effectId:idSchema}),
  object({kind:z.literal('authorAuthorized'),pr:prRefSchema,author:text,commentId:revision,bodyHash:hashSchema}),
]);
export type MaintenanceIntent = z.infer<typeof maintenanceIntentSchema>;
export const repoReadScopeSchema=object({repo:repoSchema,bases:z.array(text)});
export type RepoReadScope=z.infer<typeof repoReadScopeSchema>;
export const sourceScopeSchema = object({issues:z.array(issueRefSchema),prs:z.array(prRefSchema),repos:z.array(repoReadScopeSchema),branches:z.array(object({repo:repoSchema,name:text})),commits:z.array(object({repo:repoSchema,ancestor:shaSchema,descendant:shaSchema})),checkRuns:z.array(object({repo:repoSchema,runId:revision})),creations:z.array(object({repo:repoSchema,since:millisSchema,title:text,body:z.string(),actor:text})),maintenanceIntents:z.array(maintenanceIntentSchema).optional()});
export type SourceScope = z.infer<typeof sourceScopeSchema>;
export const portErrorSchema = z.union([
  object({kind:z.literal('permission'),message:text}),object({kind:z.literal('rateLimited'),message:text,resetAt:millisSchema}),
  object({kind:z.literal('unavailable'),message:text}),object({kind:z.literal('precondition'),message:text}),
  object({kind:z.literal('invalidResponse'),message:text}),object({kind:z.literal('uncertainOutcome'),message:text}),
]);
export type PortError = z.infer<typeof portErrorSchema>;
export type FactRead = {kind:'available';generation:number;scope:SourceScope;observedAt:Millis;facts:Facts}|{kind:'unavailable';error:PortError};


export const terminalSchema = z.union([
  object({kind:z.literal('merged'),pr:prRefSchema,mergeSha:shaSchema,at:millisSchema}),
  object({kind:z.literal('noCode'),bodyHash:hashSchema,reason:text,at:millisSchema}),
]);
export type Terminal = z.infer<typeof terminalSchema>;
export const pullRequestStampSchema = object({kind:z.literal('pullRequest'),pr:prRefSchema,head:shaSchema,target:targetSchema,bodyHash:hashSchema,prBodyHash:hashSchema,contractRevision:revision,rulingsHash:hashSchema});
export type PullRequestStamp = z.infer<typeof pullRequestStampSchema>;
export const mergeCommitStampSchema = object({kind:z.literal('mergeCommit'),issue:issueRefSchema,bodyHash:hashSchema,contractRevision:revision,terminal:terminalSchema,target:targetSchema,commit:shaSchema,rulingsHash:hashSchema});
export type MergeCommitStamp = z.infer<typeof mergeCommitStampSchema>;
export const parentStampSchema = object({kind:z.literal('parent'),parent:issueRefSchema,bodyHash:hashSchema,children:z.array(object({id:idSchema,issue:issueRefSchema,terminal:terminalSchema})),targets:z.array(targetSchema),rulingsHash:hashSchema});
export type ParentStamp = z.infer<typeof parentStampSchema>;
export const verdictSchema = object({role:roleSchema,status:z.enum(['pending','passed','failed']),note:z.string()});
export type Verdict = z.infer<typeof verdictSchema>;
/** One judge state's judgment: the fingerprint under judgment and one verdict per configured judge, keyed by state name. */
export const ticketGateSchema = object({stamp:z.union([pullRequestStampSchema,mergeCommitStampSchema]),verdicts:z.array(verdictSchema)});
export type TicketGate = z.infer<typeof ticketGateSchema>;
export const parentGateSchema = object({stamp:parentStampSchema,verdicts:z.array(verdictSchema)});
export type ParentGate = z.infer<typeof parentGateSchema>;
/** Times each state of a machine was entered, for `visits` conditions. */
const visitsSchema = z.record(z.string(),ordinal);
export const noteAuthorSchema = z.union([object({kind:z.literal('seat'),role:roleSchema}),object({kind:z.literal('system')}),object({kind:z.literal('main')})]);
export type NoteAuthor = z.infer<typeof noteAuthorSchema>;
export const ticketSchema = object({
  id:idSchema,revision,issue:issueRefSchema,target:targetSchema,dependsOn:z.array(idSchema),
  contract:object({revision,bodyHash:hashSchema,body:z.string()}),
  /** A state of the agenda's workflow, `Escalated` while Main's ruling is due, or `Asking` while the intent guardians settle a worker's question. */
  state:text,started:z.boolean(),visits:visitsSchema,
  /** The latest accepted session of each work role; a later seat of that role forks it. */
  sessions:z.record(z.string(),text),
  pr:object({ref:prRefSchema.nullable(),headRepo:repoSchema,branch:text,head:shaSchema,title:text,body:z.string()}).nullable(),
  gates:z.record(z.string(),ticketGateSchema),
  rulings:z.array(object({at:millisSchema,summary:text})),
  notes:z.array(object({at:millisSchema,author:noteAuthorSchema,kind:z.enum(['finding','checks','conflict','escalation','sourceChange','ruling']),text})),
  terminal:terminalSchema.nullable(),
  /**
   * The worker question the ticket waits on, exactly while it is `Asking`: the decision item, its tier, the asking
   * session's id and file, and the id of its `ask` comment once GitHub shows it.
   */
  ask:object({question:text,tier:tierSchema,session:text,file:text,comment:revision.nullable()}).nullable(),
});
export type Ticket = z.infer<typeof ticketSchema>;
export const effectResultSchema = z.union([
  object({kind:z.literal('published'),pr:prRefSchema}),
  object({kind:z.literal('merged'),pr:prRefSchema,mergeSha:shaSchema,at:millisSchema}),
  object({kind:z.literal('issueState'),issue:issueRefSchema,open:z.boolean()}),
  object({kind:z.literal('bodyReplaced'),issue:issueRefSchema,hash:hashSchema}),
  object({kind:z.literal('created'),issue:issueRefSchema}),
  object({kind:z.literal('attached'),parent:issueRefSchema,child:issueRefSchema}),
  object({kind:z.literal('rerun'),repo:repoSchema,workflowRunId:revision,attempt:revision}),
  object({kind:z.literal('commented'),issue:issueRefSchema,comment:revision}),
  object({kind:z.literal('projectFieldSet'),issue:issueRefSchema,field:z.literal('status'),option:text}),
  /** The intent guardians accepted the decision item: 202 on its first request, 200 on a repeat for the same comment. */
  object({kind:z.literal('answerRequested'),issue:issueRefSchema,comment:revision,status:z.union([z.literal(200),z.literal(202)])}),
]);
export type EffectResult = z.infer<typeof effectResultSchema>;
/** `origin` is the state entry that requested the effect; it advances only that entry. Main's resolve actions have none. */
export const effectSchema = object({id:idSchema,ticketId:idSchema,action:actionSchema,origin:object({state:text,revision}).nullable(),attempt:ordinal,state:z.union([
  object({kind:z.literal('ready')}),
  object({kind:z.literal('executing'),startedAt:millisSchema}),
  object({kind:z.enum(['failed','uncertain']),startedAt:millisSchema,error:portErrorSchema}),
  object({kind:z.literal('confirmed'),result:effectResultSchema}),
  object({kind:z.literal('cancelled'),reason:text}),
])});
export type Effect = z.infer<typeof effectSchema>;
export const closureSchema = object({id:idSchema,revision,state:text,stamp:parentStampSchema,visits:visitsSchema,gates:z.record(z.string(),parentGateSchema),rulings:z.array(object({at:millisSchema,summary:text})),notes:z.array(text)});
export type ClosureGate = z.infer<typeof closureSchema>;
/** The persisted agenda; `workflow` is the file-shaped workflow, parsed by parseAgenda. `run` stays attached only while its coordinator process lives; `pid` and `startedAt` together name that process, since a pid alone is reused. `startedAt` is the start time exactly as the OS reports it, compared only for equality. */
export const agendaSchema = object({id:agendaIdSchema,version:revision,nextId:revision,convenedAt:millisSchema,lifecycle:z.enum(['active','completed']),parent:issueRefSchema.nullable(),workflow:z.unknown(),tickets:z.array(ticketSchema),closure:closureSchema.nullable(),effects:z.array(effectSchema),run:z.union([object({kind:z.literal('detached')}),object({kind:z.literal('attached'),id:idSchema,mainAgentId:text,mainSessionId:text,pid:revision,startedAt:text})]),summary:text.nullable()});
export type CoordinatorProcess = Pick<Extract<z.infer<typeof agendaSchema>['run'],{kind:'attached'}>,'pid'|'startedAt'>;
export type Agenda = Omit<z.infer<typeof agendaSchema>,'workflow'>&{workflow:Workflow};
export type Caller = {agentId:string;sessionId:string;sessionFile:string|null;kind:'main'}|{agentId:string;sessionId:string;sessionFile:string;kind:'seat';ticketId:string;role:Role;revision:number};
/** Internal operation from the controller, never part of the public grammar: a work seat's native session has started. */
export type WorkerStarted = {ticketId:string;revision:number;role:Role;sessionId:string;sessionFile:string};
/** How a work seat's question is asked under PM integration: the tier it defaults to and the tier help its brief carries. */
export type PmAsk = {defaultTier:Tier;tierHelp:string};
/** What the engine needs for PM integration: this coordinator process, the configured Status option names, and how a worker's question is asked. */
export type PmContext = {host:string;pid:number;status:{inProgress:string;done:string};ask:PmAsk};
export type DomainError = {kind:'unauthorized'|'invalidTransition'|'staleRevision'|'sourceUnavailable'|'sourceChanged'|'notFound'|'ownershipBlocked'|'invalidTopology'|'agenda_attached';message:string};
export type ParseError = {path:string;reason:string};
