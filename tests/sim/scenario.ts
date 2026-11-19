import { z } from "@oh-my-pi/omptype/zod";

const expectSchema = z.record(z.string(), z.string());
export type Expect = z.infer<typeof expectSchema>;

/** A step an Owner takes before it commits: call a tool, or wait for a marker file. */
const preStepSchema = z.union([
	z.object({ kind: z.literal("call"), name: z.string(), args: z.record(z.string(), z.unknown()) }),
	z.object({ kind: z.literal("wait"), marker: z.string() }),
]);

const ownerRoundSchema = z.union([
	z.object({
		kind: z.literal("commit"),
		/** Steps the Owner takes, one per model request, before its commit. */
		before: z.array(preStepSchema).optional(),
		write: z.record(z.string(), z.string()),
		remove: z.array(z.string()).optional(),
		after: z
			.union([
				z.object({ kind: z.literal("block"), marker: z.string() }),
				z.object({ kind: z.literal("push"), waitFor: z.string(), write: z.record(z.string(), z.string()) }),
			])
			.optional(),
	}),
	z.object({
		kind: z.literal("escalate"),
		escalation: z.enum(["question", "blocked", "split", "noCode"]),
		reason: z.string(),
		tier: z.enum(["simple", "complex"]).optional(),
	}),
	z.object({ kind: z.literal("quit") }),
]);
export type OwnerRound = z.infer<typeof ownerRoundSchema>;

const rulingSchema = z.object({ to: z.string(), ruling: z.string(), noCode: z.string().optional() });
export type Ruling = z.infer<typeof rulingSchema>;

const ticketSpecSchema = z.object({
	id: z.string(),
	issue: z.number().int(),
	dependsOn: z.array(z.string()),
	owner: z.array(ownerRoundSchema).min(1),
	gate: expectSchema,
	judgeExpect: z.record(z.string(), expectSchema).optional(),
	hold: z.object({ roles: z.array(z.string()), marker: z.string() }).optional(),
	judgeFailure: z.object({ role: z.string(), message: z.string() }).optional(),
	rulings: z.array(rulingSchema).optional(),
});
export type TicketSpec = z.infer<typeof ticketSpecSchema>;

export const scenarioSchema = z.object({
	name: z.string(),
	repo: z.object({ owner: z.string(), name: z.string() }),
	parent: z.number().int().nullable(),
	tickets: z.array(ticketSpecSchema),
	closure: expectSchema,
	parentRoles: z.array(z.string()),
	workRoles: z.array(z.string()),
	retryFailed: z.string().optional(),
	resumeFirst: z.string().optional(),
	log: z.string(),
});
export type Scenario = z.infer<typeof scenarioSchema>;
