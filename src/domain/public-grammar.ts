import type { z as facadeZ, ZodLikeSchema } from '@oh-my-pi/omptype/zod';

type PublicZ = Pick<typeof facadeZ, 'string'|'number'|'boolean'|'literal'|'enum'|'union'|'array'|'object'>;

/** Build schema nodes in the consuming module graph, including the host facade. */
export function buildPublicGrammar(z: PublicZ) {
  const object = <const S extends Readonly<Record<string, ZodLikeSchema<unknown>>>>(shape: S) => z.object(shape).strict();
  const text = z.string().min(1);
  const ordinal = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
  const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
  const millisSchema = ordinal;
  const shaSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
  const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
  const idSchema = text;
  const agendaIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const repoSchema = object({owner:text,name:text});
  const issueRefSchema = object({repo:repoSchema,number:revision});
  const prRefSchema = issueRefSchema;
  const shaRefSchema = object({repo:repoSchema,sha:shaSchema});
  const targetSchema = object({repo:repoSchema,base:text});
  /** A configured seat name; which names exist is decided by the agenda's frozen workflow, not by the grammar. */
  const roleSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
  const entrySchema = object({id:idSchema,issue:issueRefSchema,target:targetSchema,dependsOn:z.array(idSchema),adoptPr:prRefSchema.nullable()});
  const conveneSchema = object({op:z.literal('convene'),parent:issueRefSchema.nullable(),tickets:z.array(entrySchema).min(1)});
  /** The intent guardians' routing of a decision item: one implementation detail, or a decision across modules or contracts. */
  const tierSchema = z.enum(['simple','complex']);
  const actionSchema = z.union([
    object({kind:z.literal('publishPr'),issue:issueRefSchema,headRepo:repoSchema,branch:text,head:shaSchema,target:targetSchema,pr:prRefSchema.nullable(),expectedBodyHash:hashSchema.nullable(),title:text,body:text}),
    object({kind:z.literal('merge'),issue:issueRefSchema,pr:prRefSchema,head:shaSchema,target:targetSchema,stampHash:hashSchema}),
    object({kind:z.literal('setIssueState'),issue:issueRefSchema,open:z.boolean(),bodyHash:hashSchema,afterEvent:text.nullable()}),
    object({kind:z.literal('replaceBody'),issue:issueRefSchema,expectedHash:hashSchema,body:z.string()}),
    object({kind:z.literal('createIssue'),repo:repoSchema,title:text,body:text}),
    object({kind:z.literal('attachChild'),parent:issueRefSchema,child:issueRefSchema}),
    object({kind:z.literal('rerunChecks'),pr:prRefSchema,repo:repoSchema,workflowRunId:revision,previousAttempt:revision,head:shaSchema}),
    /** `body` is the whole comment, ending with its marker line; the marker's key field identifies the comment at source. */
    object({kind:z.literal('comment'),issue:issueRefSchema,body:text,marker:object({kind:z.enum(['impl','ask']),key:text})}),
    /** `option` is the configured option name of the Project field. */
    object({kind:z.literal('setProjectField'),issue:issueRefSchema,field:z.literal('status'),option:text}),
    /** Hands an `ask` comment's decision item to the intent guardians; `comment` is that comment's id. */
    object({kind:z.literal('requestAnswer'),issue:issueRefSchema,comment:revision,question:text,tier:tierSchema}),
  ]);
  const effectResolutionSchema = object({effectId:idSchema,disposition:z.enum(['retry','adopt','cancel'])});
  const resolveSchema = object({op:z.literal('resolve'),ticketId:idSchema,revision,ruling:text,
    /** A state of the agenda's workflow machine: the ticket machine for a ticket, the parent machine for the closure. */
    to:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
    dependsOn:z.array(idSchema).optional(),target:targetSchema.optional(),adoptPr:prRefSchema.nullable().optional(),
    noCode:text.optional(),add:z.array(entrySchema).optional(),remove:z.array(idSchema).optional(),
    effects:z.array(effectResolutionSchema).optional(),actions:z.array(actionSchema).optional(),
  });
  const portInputSchema = z.union([
    conveneSchema,
    object({op:z.literal('resume'),agenda:idSchema}),
    object({op:z.literal('tickets')}),object({op:z.literal('status')}),
    object({op:z.literal('read'),ticketId:idSchema}),
    object({op:z.literal('launch'),ticketId:idSchema,role:roleSchema.optional()}),
    object({op:z.literal('submit'),ticketId:idSchema,revision,branch:text,head:shaSchema,title:text,body:text}),
    object({op:z.literal('verdict'),ticketId:idSchema,revision,role:roleSchema,ok:z.boolean(),note:text}),
    object({op:z.literal('escalate'),ticketId:idSchema,revision,kind:z.literal('question'),reason:text,
      /** How hard the decision item is; only a question carries it, and Meerkat integration falls back to its configured default. */
      tier:tierSchema.optional()}),
    object({op:z.literal('escalate'),ticketId:idSchema,revision,kind:z.enum(['blocked','split','noCode']),reason:text}),
    resolveSchema,
    object({op:z.literal('finish'),summary:text}),
  ]);

  /*
   * The caller-facing parameter definitions. They are wire definitions only: the entry parse maps them back to
   * `portInputSchema` and `actionSchema`, which stay the domain and persisted types. A tool's model sees one
   * object whose enum chooses the operation, scalar fields, and descriptions; no unions, no nulls, and at most
   * two object levels. References are strings because a flattened action item is already the second level.
   */
  const ticketIdField = text.optional().describe('The ticket id, exactly as returned by dispatch status or dispatch tickets.');
  const revisionField = revision.optional().describe('The ticket revision this call acts on: the revision returned by dispatch read or dispatch status. A stale revision is refused.');
  const tierField = tierSchema.optional().describe('How hard the decision item is: simple for one implementation detail, complex for a decision across modules or contracts.');
  const wireEntry = object({
    id: text.describe('The ticket id, unique within the agenda; resolve dependsOn and remove refer to it.'),
    issue: text.describe('The issue this ticket delivers, as <owner>/<repo>#<number>, for example oh-my-omp/omp-dispatch#236.'),
    target: text.describe('The repository and base branch this ticket delivers to, as <owner>/<repo>@<branch>, for example oh-my-omp/omp-dispatch@main.'),
    dependsOn: z.array(text).describe('Ticket ids that must be delivered before this ticket may launch; [] for an independent ticket.'),
    adoptPr: text.optional().describe('An existing pull request to adopt, as <owner>/<repo>#<number>. Omit when there is none.'),
  }).describe('One ticket entry supplied to convene or resolve add.');
  const wireEffects = z.array(object({
    effectId: text.describe('The id of a failed or uncertain effect, as shown by dispatch read.'),
    disposition: z.enum(['retry','adopt','cancel']).describe('retry re-requests the effect, adopt accepts the result the source already shows, cancel abandons it.'),
  }).describe('One effect disposition.')).describe('Dispositions for failed or uncertain effects; omit to leave them alone.');
  const wireActions = z.array(object({
    kind: z.enum(['publishPr','merge','setIssueState','replaceBody','createIssue','attachChild','rerunChecks','comment','setProjectField','requestAnswer']).describe('The GitHub write kind; it selects which of the remaining action fields apply.'),
    issue: text.optional().describe('The subject issue, as <owner>/<repo>#<number>. Used by publishPr, merge, setIssueState, replaceBody, comment, setProjectField and requestAnswer.'),
    pr: text.optional().describe('A pull request, as <owner>/<repo>#<number>. merge and rerunChecks require it; publishPr names an open PR to update and omits it to create one.'),
    repo: text.optional().describe('A repository, as <owner>/<repo>. Used by createIssue and rerunChecks.'),
    headRepo: text.optional().describe('publishPr: the repository holding the head branch, as <owner>/<repo>; usually the subject repository.'),
    branch: text.optional().describe('publishPr: the head branch name holding the commits to publish.'),
    head: text.optional().describe('publishPr, merge and rerunChecks: the full 40-64 character lowercase hex commit sha the action expects.'),
    target: text.optional().describe('publishPr and merge: the base repository and branch, as <owner>/<repo>@<branch>.'),
    expectedBodyHash: text.optional().describe('publishPr: the 64 character hex body hash expected when updating an existing PR; omit when creating one.'),
    title: text.optional().describe('publishPr and createIssue: the title.'),
    body: z.string().optional().describe('publishPr and createIssue: the body; replaceBody: the new issue body; comment: the whole comment ending with its marker line.'),
    stampHash: text.optional().describe('merge: the 64 character hex gate stamp hash this merge is authorized by, as returned by dispatch read.'),
    open: z.boolean().optional().describe('setIssueState: true reopens the issue, false closes it.'),
    bodyHash: text.optional().describe('setIssueState: the 64 character hex issue body hash the state change is based on.'),
    afterEvent: text.optional().describe('setIssueState: the lifecycle event the change follows; omit when it follows none.'),
    expectedHash: text.optional().describe('replaceBody: the 64 character hex issue body hash expected before the edit.'),
    parent: text.optional().describe('attachChild: the parent issue, as <owner>/<repo>#<number>.'),
    child: text.optional().describe('attachChild: the child issue to attach, as <owner>/<repo>#<number>.'),
    workflowRunId: revision.optional().describe('rerunChecks: the numeric id of the failing workflow run to rerun.'),
    previousAttempt: revision.optional().describe('rerunChecks: the numeric attempt being superseded, as counted by the workflow.'),
    markerKind: z.enum(['impl','ask']).optional().describe('comment: the marker kind whose key identifies the comment at source.'),
    markerKey: text.optional().describe('comment: the marker key identifying the comment at source.'),
    field: z.literal('status').optional().describe('setProjectField: the Project field to set; only status is supported.'),
    option: text.optional().describe('setProjectField: the configured Status option name to set.'),
    comment: revision.optional().describe('requestAnswer: the id of the ask comment holding the decision item.'),
    question: text.optional().describe('requestAnswer: the decision item text handed to the intent guardians.'),
    tier: tierSchema.optional().describe('requestAnswer: how hard the decision item is; simple for one detail, complex across modules or contracts.'),
  }).describe('One GitHub write resolve actions performs.')).describe('GitHub writes to enqueue after the ruling; the state machine performs and confirms them. Omit for none.');
  const toolParametersSchema = object({
    input: object({
      op: z.enum(['convene','resume','tickets','status','read','launch','resolve','finish']).describe('The operation: convene starts an agenda, resume takes over a saved one, tickets and status list state, read returns one ticket, launch seats a ticket, resolve records a ruling and may edit topology or enqueue GitHub writes, finish completes the agenda.'),
      agenda: agendaIdSchema.optional().describe('resume: the id of the saved agenda, as listed in the startup message.'),
      ticketId: ticketIdField,
      role: text.optional().describe('launch: an optional seat role to start; only a role the ticket state offers is accepted.'),
      summary: text.optional().describe('finish: the final summary of what the agenda delivered.'),
      parent: text.optional().describe('convene: the parent issue, as <owner>/<repo>#<number>; omit for an agenda with no parent.'),
      tickets: z.array(wireEntry).optional().describe('convene: every ticket the agenda contains, at least one; every current parent sub-issue must have one.'),
      revision: revisionField,
      ruling: text.optional().describe('resolve: the ruling sentence recorded in the ticket history and carried by its seats.'),
      to: text.optional().describe('resolve: the workflow state to continue in, by name; use a state from the ticket workflow, or the parent workflow for the closure.'),
      dependsOn: z.array(text).optional().describe('resolve: replaces the ticket dependency ids; [] makes it independent.'),
      target: text.optional().describe('resolve: replaces the ticket target, as <owner>/<repo>@<branch>.'),
      adoptPr: text.optional().describe('resolve: adopts an existing pull request, as <owner>/<repo>#<number>, that closes this ticket issue at its target. Omit to leave the associated PR alone.'),
      clearAdoptPr: z.boolean().optional().describe('resolve: true removes the associated pull request and merge terminal; omit or false keeps it. Do not combine with adoptPr.'),
      noCode: text.optional().describe('resolve: the reason the issue needs no code change; only accepted when to leads to a closeIssue action or a final state.'),
      add: z.array(wireEntry).optional().describe('resolve: ticket entries to add to the agenda.'),
      remove: z.array(text).optional().describe('resolve: ticket ids to remove; a ticket with unsettled effects cannot be removed.'),
      effects: wireEffects.optional(),
      actions: wireActions.optional(),
    }).describe('The Dispatch operation Main is performing.'),
  });
  const seatToolParametersSchema = object({
    input: object({
      op: z.enum(['read','submit','verdict','escalate']).describe('The operation: read returns the bound ticket, submit hands off your branch, verdict hands off your gate judgment, escalate hands a blocker or question to Main.'),
      ticketId: ticketIdField,
      revision: revisionField,
      branch: text.optional().describe('submit: the pushed branch holding the delivered work.'),
      head: shaSchema.optional().describe('submit: the full 40-64 character lowercase hex commit sha at the head of branch.'),
      title: text.optional().describe('submit: the pull request title.'),
      body: text.optional().describe('submit: the complete pull request body, which must contain exactly one closing keyword for the bound issue.'),
      role: text.optional().describe('verdict: the judge role this verdict belongs to; it must be your bound role.'),
      ok: z.boolean().optional().describe('verdict: true passes the gate, false rejects it with note as the findings.'),
      note: text.optional().describe('verdict: the concrete evidence note for the pass or rejection.'),
      kind: z.enum(['question','blocked','split','noCode']).optional().describe('escalate: question asks the intent guardians or Main; blocked, split and noCode report why this ticket cannot be delivered as scoped.'),
      reason: text.optional().describe('escalate: the blocker, question, split or no-code reason, with the evidence and the decision needed.'),
      tier: tierField,
    }).describe('The Dispatch operation the seat is performing.'),
  });
  return {text,ordinal,revision,millisSchema,shaSchema,hashSchema,idSchema,agendaIdSchema,repoSchema,issueRefSchema,prRefSchema,shaRefSchema,targetSchema,roleSchema,tierSchema,entrySchema,conveneSchema,actionSchema,portInputSchema,toolParametersSchema,seatToolParametersSchema};
}
