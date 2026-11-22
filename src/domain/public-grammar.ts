import type { z as facadeZ, ZodLikeSchema } from "@oh-my-pi/omptype/zod";

type PublicZ = Pick<typeof facadeZ, "string" | "number" | "boolean" | "literal" | "enum" | "union" | "array" | "object">;

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
	const nameSegment = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
	const repoSchema = object({ owner: text, name: text });
	const issueRefSchema = object({ repo: repoSchema, number: revision });
	const prRefSchema = issueRefSchema;
	const shaRefSchema = object({ repo: repoSchema, sha: shaSchema });
	const targetSchema = object({ repo: repoSchema, base: text });
	const roleSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
	const entrySchema = object({
		id: idSchema,
		issue: issueRefSchema,
		target: targetSchema,
		dependsOn: z.array(idSchema),
		adoptPr: prRefSchema.nullable(),
	});
	const conveneSchema = object({ op: z.literal("convene"), parent: issueRefSchema.nullable(), tickets: z.array(entrySchema).min(1) });
	const tierSchema = z.enum(["simple", "complex"]);
	const actionSchema = z.union([
		object({
			kind: z.literal("publishPr"),
			issue: issueRefSchema,
			headRepo: repoSchema,
			branch: text,
			head: shaSchema,
			target: targetSchema,
			pr: prRefSchema.nullable(),
			expectedBodyHash: hashSchema.nullable(),
			title: text,
			body: text,
		}),
		object({
			kind: z.literal("merge"),
			issue: issueRefSchema,
			pr: prRefSchema,
			head: shaSchema,
			target: targetSchema,
			stampHash: hashSchema,
		}),
		object({
			kind: z.literal("setIssueState"),
			issue: issueRefSchema,
			open: z.boolean(),
			bodyHash: hashSchema,
			afterEvent: text.nullable(),
		}),
		object({ kind: z.literal("replaceBody"), issue: issueRefSchema, expectedHash: hashSchema, body: z.string() }),
		object({ kind: z.literal("createIssue"), repo: repoSchema, title: text, body: text }),
		object({ kind: z.literal("attachChild"), parent: issueRefSchema, child: issueRefSchema }),
		object({
			kind: z.literal("rerunChecks"),
			pr: prRefSchema,
			repo: repoSchema,
			workflowRunId: revision,
			previousAttempt: revision,
			head: shaSchema,
		}),
		object({ kind: z.literal("comment"), issue: issueRefSchema, body: text, marker: object({ kind: z.enum(["impl", "ask"]), key: text }) }),
		object({ kind: z.literal("setProjectField"), issue: issueRefSchema, field: z.literal("status"), option: text }),
		object({ kind: z.literal("requestAnswer"), issue: issueRefSchema, comment: revision, question: text, tier: tierSchema }),
	]);
	const effectResolutionSchema = object({ effectId: idSchema, disposition: z.enum(["retry", "adopt", "cancel"]) });
	const resolveSchema = object({
		op: z.literal("resolve"),
		ticketId: idSchema,
		revision,
		ruling: text,
		to: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
		dependsOn: z.array(idSchema).optional(),
		target: targetSchema.optional(),
		adoptPr: prRefSchema.nullable().optional(),
		noCode: text.optional(),
		add: z.array(entrySchema).optional(),
		remove: z.array(idSchema).optional(),
		effects: z.array(effectResolutionSchema).optional(),
		actions: z.array(actionSchema).optional(),
	});
	const portInputSchema = z.union([
		conveneSchema,
		object({ op: z.literal("resume"), agenda: idSchema }),
		object({ op: z.literal("tickets") }),
		object({ op: z.literal("status") }),
		object({ op: z.literal("read"), ticketId: idSchema }),
		object({ op: z.literal("launch"), ticketId: idSchema, role: roleSchema.optional() }),
		object({ op: z.literal("submit"), ticketId: idSchema, revision, branch: text, head: shaSchema, title: text, body: text }),
		object({ op: z.literal("verdict"), ticketId: idSchema, revision, role: roleSchema, ok: z.boolean(), note: text }),
		object({
			op: z.literal("escalate"),
			ticketId: idSchema,
			revision,
			kind: z.literal("question"),
			reason: text,
			tier: tierSchema.optional(),
		}),
		object({ op: z.literal("escalate"), ticketId: idSchema, revision, kind: z.enum(["blocked", "split", "noCode"]), reason: text }),
		resolveSchema,
		object({ op: z.literal("finish"), summary: text }),
	]);

	// Structured wire coordinates (no "<owner>/<repo>#<number>" or "<owner>/<repo>@<branch>" string DSLs)
	const wireRepoSchema = object({
		owner: nameSegment.describe("GitHub repository owner (user or organization)."),
		repo: nameSegment.describe("GitHub repository name."),
	}).describe("GitHub repository coordinate.");
	const wireIssueRefSchema = object({
		owner: nameSegment.describe("GitHub repository owner."),
		repo: nameSegment.describe("GitHub repository name."),
		number: revision.describe("GitHub issue or pull request number."),
	}).describe("GitHub issue or pull request coordinate.");
	const wireTargetSchema = object({
		owner: nameSegment.describe("Target GitHub repository owner."),
		repo: nameSegment.describe("Target GitHub repository name."),
		branch: text.describe("Target base branch name, for example main."),
	}).describe("Target repository and base branch.");
	const wireEntrySchema = object({
		id: text.describe("The ticket id, unique within the agenda; resolve dependsOn and remove refer to it."),
		issue: wireIssueRefSchema.describe("The GitHub issue this ticket delivers."),
		target: wireTargetSchema.describe("The repository and base branch this ticket delivers to."),
		dependsOn: z.array(text).describe("Ticket ids that must be delivered before this ticket may launch; [] for an independent ticket."),
		adoptPr: wireIssueRefSchema.optional().describe("An existing pull request to adopt. Omit when there is none."),
	}).describe("One ticket entry supplied to convene or resolve.add.");
	const wireEffectsSchema = z
		.array(
			object({
				effectId: text.describe("The id of a failed or uncertain effect, as shown by read dispatch://<ticketId>."),
				disposition: z
					.enum(["retry", "adopt", "cancel"])
					.describe("retry re-requests the effect, adopt accepts the result the source already shows, cancel abandons it."),
			}).describe("One effect disposition."),
		)
		.describe("Dispositions for failed or uncertain effects; omit to leave them alone.");
	const wireGitHubActionSchema = object({
		publishPr: object({
			issue: wireIssueRefSchema.describe("The subject issue."),
			headRepo: wireRepoSchema.describe("Repository holding the head branch; usually the subject repository."),
			branch: text.describe("Head branch name holding the commits to publish."),
			head: shaSchema.describe("Full 40-64 character lowercase hex commit sha."),
			target: wireTargetSchema.describe("Base repository and branch."),
			pr: wireIssueRefSchema.optional().describe("Open PR to update; omit to create one."),
			expectedBodyHash: hashSchema
				.optional()
				.describe("64-character hex body hash expected when updating an existing PR; omit when creating one."),
			title: text.describe("Pull request title."),
			body: text.describe("Pull request body."),
		})
			.optional()
			.describe("Create or update a pull request."),
		merge: object({
			issue: wireIssueRefSchema.describe("The subject issue."),
			pr: wireIssueRefSchema.describe("The pull request to merge."),
			head: shaSchema.describe("Full 40-64 character lowercase hex commit sha."),
			target: wireTargetSchema.describe("Base repository and branch."),
			stampHash: hashSchema.describe("64-character hex gate stamp hash authorizing this merge."),
		})
			.optional()
			.describe("Merge an approved pull request."),
		setIssueState: object({
			issue: wireIssueRefSchema.describe("The subject issue."),
			open: z.boolean().describe("true reopens the issue, false closes it."),
			bodyHash: hashSchema.describe("64-character hex issue body hash the state change is based on."),
			afterEvent: text.optional().describe("Lifecycle event the change follows; omit when none."),
		})
			.optional()
			.describe("Open or close an issue."),
		replaceBody: object({
			issue: wireIssueRefSchema.describe("The subject issue."),
			expectedHash: hashSchema.describe("64-character hex issue body hash expected before the edit."),
			body: z.string().describe("New issue body (may be empty)."),
		})
			.optional()
			.describe("Replace an issue body."),
		createIssue: object({
			repo: wireRepoSchema.describe("Repository where the issue is created."),
			title: text.describe("Issue title."),
			body: text.describe("Issue body."),
		})
			.optional()
			.describe("Create a new issue."),
		attachChild: object({
			parent: wireIssueRefSchema.describe("Parent issue."),
			child: wireIssueRefSchema.describe("Child issue to attach."),
		})
			.optional()
			.describe("Attach a child sub-issue to a parent issue."),
		rerunChecks: object({
			pr: wireIssueRefSchema.describe("Pull request whose checks are rerun."),
			repo: wireRepoSchema.describe("Repository owning the workflow run."),
			workflowRunId: revision.describe("Numeric id of the failing workflow run to rerun."),
			previousAttempt: revision.describe("Numeric attempt being superseded."),
			head: shaSchema.describe("Full 40-64 character lowercase hex commit sha."),
		})
			.optional()
			.describe("Rerun a failing GitHub Actions workflow run."),
		comment: object({
			issue: wireIssueRefSchema.describe("Issue to comment on."),
			body: text.describe("Complete comment body ending with its marker line."),
			marker: object({
				kind: z.enum(["impl", "ask"]).describe("Marker kind identifying the comment at source."),
				key: text.describe("Marker key identifying the comment at source."),
			}).describe("Source comment marker."),
		})
			.optional()
			.describe("Post a marked comment on an issue."),
		setProjectField: object({
			issue: wireIssueRefSchema.describe("Subject issue."),
			field: z.literal("status").describe("Project field to set (only status is supported)."),
			option: text.describe("Configured Status option name to set."),
		})
			.optional()
			.describe("Set a GitHub Project status field."),
		requestAnswer: object({
			issue: wireIssueRefSchema.describe("Subject issue."),
			comment: revision.describe("Id of the ask comment holding the decision item."),
			question: text.describe("Decision item text handed to the intent guardians."),
			tier: tierSchema.describe("Decision difficulty: simple for one detail, complex across modules or contracts."),
		})
			.optional()
			.describe("Request an answer from the intent guardians."),
	}).describe("One GitHub write action: set exactly one action property.");

	const tierField = tierSchema
		.optional()
		.describe("Only for kind='question': simple for one implementation detail, complex for a decision across modules or contracts.");

	const dispatchTicketParametersSchema = object({
		convene: object({
			parent: wireIssueRefSchema.optional().describe("Parent GitHub issue; omit for an agenda with no parent."),
			tickets: z
				.array(wireEntrySchema)
				.min(1)
				.describe("Every ticket the agenda contains (at least one; every current parent sub-issue must have one)."),
		})
			.optional()
			.describe("Start a new agenda with its ticket graph."),
		resume: object({
			agenda: agendaIdSchema.describe("The UUID of the saved active agenda listed in the startup message."),
		})
			.optional()
			.describe("Take over a saved active agenda."),
		finish: object({
			summary: text.describe("The final summary of what the agenda delivered."),
		})
			.optional()
			.describe("Complete the agenda after every ticket and the parent closure rest in final states."),
	});

	const dispatchStepParametersSchema = object({
		ticketId: text.describe("The ticket id (or closure id), as returned by read dispatch://status or read dispatch://tickets."),
		launch: object({
			role: roleSchema.optional().describe("Optional seat role to start; omit to launch the ticket's currently executable seats."),
		})
			.optional()
			.describe("Launch this ticket once so Dispatch relays its seats along the workflow."),
		resolve: object({
			revision: revision.describe(
				"The ticket revision returned by read dispatch://<ticketId> or read dispatch://status. A stale revision is refused.",
			),
			ruling: text.describe("The ruling sentence recorded in the ticket history and carried by its seats."),
			to: z
				.string()
				.regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
				.describe("Workflow state to continue in, by name (use a state from the ticket workflow, or the parent workflow for the closure)."),
			dependsOn: z.array(text).optional().describe("Replaces the ticket dependency ids; [] makes it independent."),
			target: wireTargetSchema.optional().describe("Replaces the ticket target repository and base branch."),
			adoptPr: wireIssueRefSchema
				.optional()
				.describe("Adopts an existing pull request closing this ticket issue at its target. Omit to leave the associated PR alone."),
			clearAdoptPr: z
				.boolean()
				.optional()
				.describe("true removes the associated pull request and merge terminal; omit or false keeps it. Do not combine with adoptPr."),
			noCode: text
				.optional()
				.describe("Reason the issue needs no code change; only accepted when to leads to a closeIssue action or a final state."),
			add: z.array(wireEntrySchema).optional().describe("Ticket entries to add to the agenda."),
			remove: z.array(text).optional().describe("Ticket ids to remove; a ticket with unsettled effects cannot be removed."),
			effects: wireEffectsSchema.optional(),
			githubActions: z
				.array(wireGitHubActionSchema)
				.optional()
				.describe("GitHub writes to enqueue after the ruling; the state machine performs and confirms them. Omit for none."),
		})
			.optional()
			.describe("Record a ruling, edit topology, settle effects, or enqueue GitHub writes."),
	});

	const seatSubmitParametersSchema = object({
		branch: text.describe("The pushed branch holding the delivered work."),
		head: shaSchema.describe("The full 40-64 character lowercase hex commit sha at the head of branch."),
		title: text.describe("The pull request title."),
		body: text.describe("The complete pull request body, which must contain exactly one closing keyword for the bound issue."),
		revision: revision.optional().describe("Optional ticket revision guard; defaults to this seat's bound revision."),
	});

	const seatVerdictParametersSchema = object({
		ok: z.boolean().describe("true passes the gate, false rejects it with note as the findings."),
		note: text.describe("The concrete evidence note for the pass or rejection."),
		revision: revision.optional().describe("Optional ticket revision guard; defaults to this seat's bound revision."),
	});

	const seatEscalateParametersSchema = object({
		kind: z
			.enum(["question", "blocked", "split", "noCode"])
			.describe(
				"question asks the intent guardians or Main; blocked, split, and noCode report why this ticket cannot be delivered as scoped.",
			),
		reason: text.describe("The blocker, question, split, or no-code reason, with the evidence and the decision needed."),
		tier: tierField,
		revision: revision.optional().describe("Optional ticket revision guard; defaults to this seat's bound revision."),
	});

	return {
		text,
		ordinal,
		revision,
		millisSchema,
		shaSchema,
		hashSchema,
		idSchema,
		agendaIdSchema,
		repoSchema,
		issueRefSchema,
		prRefSchema,
		shaRefSchema,
		targetSchema,
		roleSchema,
		tierSchema,
		entrySchema,
		conveneSchema,
		actionSchema,
		portInputSchema,
		wireRepoSchema,
		wireIssueRefSchema,
		wireTargetSchema,
		wireEntrySchema,
		wireGitHubActionSchema,
		dispatchTicketParametersSchema,
		dispatchStepParametersSchema,
		seatSubmitParametersSchema,
		seatVerdictParametersSchema,
		seatEscalateParametersSchema,
	};
}
