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
  const actionSchema = z.union([
    object({kind:z.literal('publishPr'),issue:issueRefSchema,headRepo:repoSchema,branch:text,head:shaSchema,target:targetSchema,pr:prRefSchema.nullable(),expectedBodyHash:hashSchema.nullable(),title:text,body:text}),
    object({kind:z.literal('merge'),issue:issueRefSchema,pr:prRefSchema,head:shaSchema,target:targetSchema,stampHash:hashSchema}),
    object({kind:z.literal('setIssueState'),issue:issueRefSchema,open:z.boolean(),bodyHash:hashSchema,afterEvent:text.nullable()}),
    object({kind:z.literal('replaceBody'),issue:issueRefSchema,expectedHash:hashSchema,body:z.string()}),
    object({kind:z.literal('createIssue'),repo:repoSchema,title:text,body:text}),
    object({kind:z.literal('attachChild'),parent:issueRefSchema,child:issueRefSchema}),
    object({kind:z.literal('rerunChecks'),pr:prRefSchema,repo:repoSchema,workflowRunId:revision,previousAttempt:revision,head:shaSchema}),
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
    object({op:z.literal('escalate'),ticketId:idSchema,revision,kind:z.enum(['question','blocked','split','noCode']),reason:text}),
    resolveSchema,
    object({op:z.literal('finish'),summary:text}),
  ]);
  const toolParametersSchema = object({input:portInputSchema});
  return {text,ordinal,revision,millisSchema,shaSchema,hashSchema,idSchema,agendaIdSchema,repoSchema,issueRefSchema,prRefSchema,shaRefSchema,targetSchema,roleSchema,entrySchema,conveneSchema,actionSchema,portInputSchema,toolParametersSchema};
}
