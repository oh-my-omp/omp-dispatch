// The scenario contract shared by the driver (which seeds the simulated GitHub
// and judges the outcome) and the scripted model (which plays Main and every
// seat). The script reacts only to what omp actually sends it: briefs, tool
// results and dispatch notifications; it never reads dispatch state files.

import {z} from '@oh-my-pi/omptype/zod';

/** Exact file contents a gate expects in its checkout. */
const expectSchema = z.record(z.string(), z.string());
export type Expect = z.infer<typeof expectSchema>;

const ownerRoundSchema = z.union([
  z.object({
    kind: z.literal('commit'),
    write: z.record(z.string(), z.string()),
    remove: z.array(z.string()).optional(),
    /** What the Owner does after its accepted submit, while it is still a live seat. */
    after: z.union([
      z.object({kind: z.literal('block'), marker: z.string()}),
      z.object({kind: z.literal('push'), waitFor: z.string(), write: z.record(z.string(), z.string())}),
    ]).optional(),
  }),
  /** `tier` goes with a question only. */
  z.object({kind: z.literal('escalate'), escalation: z.enum(['question', 'blocked', 'split', 'noCode']), reason: z.string(), tier: z.enum(['simple', 'complex']).optional()}),
  /** Ends the seat with plain text and no handoff. */
  z.object({kind: z.literal('quit')}),
]);
export type OwnerRound = z.infer<typeof ownerRoundSchema>;

const rulingSchema = z.object({to: z.string(), ruling: z.string(), noCode: z.string().optional()});
export type Ruling = z.infer<typeof rulingSchema>;

const ticketSpecSchema = z.object({
  id: z.string(),
  issue: z.number().int(),
  dependsOn: z.array(z.string()),
  /** Owner behaviour per round; a round is one Owner handoff, or one seat that ended without a handoff. */
  owner: z.array(ownerRoundSchema).min(1),
  /** Judges pass only when the checkout holds exactly these files. */
  gate: expectSchema,
  /** Per-judge expectations overriding `gate` for the named roles. */
  judgeExpect: z.record(z.string(), expectSchema).optional(),
  /** Judges that wait for a marker file before inspecting their checkout. */
  hold: z.object({roles: z.array(z.string()), marker: z.string()}).optional(),
  /** The first judge of `role` ends with a model request failure carrying `message` instead of a verdict. */
  judgeFailure: z.object({role: z.string(), message: z.string()}).optional(),
  /** Main's rulings for this ticket's escalations, in order. */
  rulings: z.array(rulingSchema).optional(),
});
export type TicketSpec = z.infer<typeof ticketSpecSchema>;

export const scenarioSchema = z.object({
  name: z.string(),
  repo: z.object({owner: z.string(), name: z.string()}),
  parent: z.number().int().nullable(),
  tickets: z.array(ticketSpecSchema),
  /** The parent-stage judges' expectation on the target branch. */
  closure: expectSchema,
  /** The workflow's parent judge roles; every other judge judges its own ticket. */
  parentRoles: z.array(z.string()),
  /** The workflow's work roles, played by the scripted Owner. */
  workRoles: z.array(z.string()),
  /**
   * A marker Main waits for before it settles a `failed:` decision: it then calls finish, which must be refused, and
   * resolves the effect with `retry`. Without it Main leaves `failed:` decisions alone.
   */
  retryFailed: z.string().optional(),
  /** An agenda id Main asks to resume first, whatever the startup message lists; the refusal is the point. */
  resumeFirst: z.string().optional(),
  /** JSON lines of every scripted model call, for the driver's assertions. */
  log: z.string(),
});
export type Scenario = z.infer<typeof scenarioSchema>;
