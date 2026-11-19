import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "@oh-my-pi/omptype/zod";

import type { RequiredCheckIdentity, SourceScope } from "../src/domain/model.ts";

type Json = Record<string, unknown>;
type RuleNode = Json & { type: string; repositoryRuleset: { name: string; enforcement: string }; parameters: Json | null };
export type Connection<Element> = { nodes: Element[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

const routeSchema = z.object({ when: z.string().min(1), data: z.unknown() });
const requestSchema = z.object({ argv: z.array(z.string()), query: z.string() });
export type FakeGhRoute = z.infer<typeof routeSchema>;
export type FakeGhRequest = z.infer<typeof requestSchema>;
export type FakeGhSource = {
	readonly dir: string;
	requests(): FakeGhRequest[];
	diagnostics(): string;
	run<Value>(work: () => Promise<Value>): Promise<Value>;
	dispose(): void;
};

function describe(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
	return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

function connection<Element>(nodes: Element[], next: string | null): Connection<Element> {
	return { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } };
}

export const REPO = { owner: "acme", name: "widgets" };
const REPO_NAME = `${REPO.owner}/${REPO.name}`;
export const VIEWER = "octocat";
export const UPDATED_AT = "2026-01-02T03:04:05Z";
export const CLOSED_AT = "2026-01-03T04:05:06Z";
export const REOPENED_AT = "2026-01-04T05:06:07Z";
const sha = (n: number): string => n.toString(16).padStart(40, "0");
export const MAIN_OID = sha(0x11);
export const HEAD_OID = sha(0x22);
export const DRIFTED_OID = sha(0x33);
export type LinkedPr = { number: number; headBranch: string; headOid: string };
export const LINKED: readonly [LinkedPr, LinkedPr] = [
	{ number: 11, headBranch: "feat/a", headOid: sha(0x44) },
	{ number: 12, headBranch: "feat/b", headOid: sha(0x55) },
];
export const ISSUE_NUMBER = 5;
export const PR_NUMBER = 7;

function rule(type: string, name: string, parameters: Json | null = null): RuleNode {
	return { type, repositoryRuleset: { name, enforcement: "ACTIVE" }, parameters };
}

function requiredRule(name: string, strict: boolean, checks: { context: string; integrationId: number | null }[]): RuleNode {
	return rule("REQUIRED_STATUS_CHECKS", name, {
		__typename: "RequiredStatusChecksParameters",
		strictRequiredStatusChecksPolicy: strict,
		requiredStatusChecks: checks,
	});
}

export function constraintsOf(...pages: Connection<RuleNode>[]): string[] {
	const constraints: string[] = [];
	for (const page of pages) {
		for (const node of page.nodes) {
			constraints.push(
				`${node.type}:${node.repositoryRuleset.enforcement}:${node.repositoryRuleset.name}:${JSON.stringify(node.parameters)}`,
			);
		}
	}
	return constraints.sort();
}

const PLAIN_RULES = connection([rule("PULL_REQUEST", "require-pull-request"), rule("REQUIRED_LINEAR_HISTORY", "linear-history")], null);
const PLAIN_CLASSIC = null;

const RULES_FIRST = connection(
	[
		rule("CREATION", "restrict-create"),
		rule("UPDATE", "restrict-update"),
		rule("DELETION", "restrict-delete"),
		rule("NON_FAST_FORWARD", "no-force-push"),
		rule("REQUIRED_LINEAR_HISTORY", "linear-history"),
		rule("REQUIRED_SIGNATURES", "signed-commits"),
		rule("REQUIRED_CONVERSATION_RESOLUTION", "resolve-conversations"),
		rule("REQUIRED_REVIEW_THREAD_RESOLUTION", "resolve-threads"),
		rule("PULL_REQUEST", "require-pull-request"),
		requiredRule("required-branch-checks", true, [
			{ context: "ci/build", integrationId: null },
			{ context: "ci/lint", integrationId: null },
			{ context: "ci/unit", integrationId: null },
			{ context: "ci/typecheck", integrationId: null },
			{ context: "ci/format", integrationId: null },
			{ context: "ci/docs", integrationId: null },
			{ context: "ci/security", integrationId: null },
			{ context: "ci/contract", integrationId: null },
		]),
	],
	"rules-main-1",
);
const RULES_SECOND = connection(
	[
		rule("TAG_NAME_PATTERN", "tag-format"),
		requiredRule("required-e2e-checks", false, [
			{ context: "ci/e2e", integrationId: 42 },
			{ context: "ci/nightly", integrationId: null },
			{ context: "ci/pack", integrationId: null },
		]),
	],
	null,
);
const RULES_CLASSIC = {
	requiresStatusChecks: true,
	requiresStrictStatusChecks: false,
	requiredStatusChecks: [{ context: "ci/classic", app: { databaseId: 7 } }],
};

function branchNode(name: string, oid: string, rules: Connection<RuleNode>, classic: Json | null): Json {
	return { name, target: { oid }, branchProtectionRule: classic, rules };
}

function repoNode(rules: Connection<RuleNode>, classic: Json | null): Json {
	return { nameWithOwner: REPO_NAME, viewerPermission: "WRITE", defaultBranchRef: branchNode("main", MAIN_OID, rules, classic) };
}

function checkRun(name: string, databaseId: number, appId: number, conclusion: string, status = "COMPLETED"): Json {
	return {
		__typename: "CheckRun",
		databaseId,
		name,
		status,
		conclusion,
		detailsUrl: null,
		isRequired: false,
		checkSuite: {
			databaseId: databaseId + 1000,
			commit: { oid: HEAD_OID },
			app: { databaseId: appId, slug: "github-actions" },
			workflowRun: null,
		},
	};
}

function statusContext(context: string, state: string): Json {
	return { __typename: "StatusContext", context, state, isRequired: false, targetUrl: null };
}

export const CONTEXTS_FIRST = connection(
	[
		checkRun("ci/build", 301, 1, "SUCCESS"),
		checkRun("ci/lint", 302, 1, "SUCCESS"),
		checkRun("ci/unit", 303, 1, "SUCCESS"),
		checkRun("ci/typecheck", 304, 1, "SUCCESS"),
		checkRun("ci/format", 305, 1, "SUCCESS"),
		checkRun("ci/docs", 306, 1, "SUCCESS"),
		statusContext("ci/security", "SUCCESS"),
		checkRun("ci/contract", 307, 1, "SUCCESS"),
		checkRun("ci/classic", 308, 7, "SUCCESS"),
		checkRun("ci/e2e", 309, 42, "SUCCESS"),
	],
	"ctx-1",
);
export const CONTEXTS_SECOND = connection([statusContext("ci/nightly", "FAILURE"), checkRun("ci/pack", 310, 1, "SUCCESS")], null);

type PrOptions = {
	number: number;
	headBranch: string;
	headOid: string;
	author: string;
	title: string;
	body: string;
	closes: number[];
	contexts: Connection<Json> | null;
	rules: Connection<RuleNode>;
	classic: Json | null;
};

function prNode(options: PrOptions): Json {
	const branch = branchNode("main", MAIN_OID, options.rules, options.classic);
	const repository = { nameWithOwner: REPO_NAME, viewerPermission: "WRITE", defaultBranchRef: branch };
	return {
		number: options.number,
		repository,
		title: options.title,
		body: options.body,
		updatedAt: UPDATED_AT,
		state: "OPEN",
		headRefOid: options.headOid,
		headRefName: options.headBranch,
		baseRefName: "main",
		headRepository: { nameWithOwner: REPO_NAME, viewerPermission: "WRITE" },
		headRef: { target: { oid: options.headOid } },
		baseRef: branch,
		baseRepository: repository,
		author: { login: options.author },
		maintainerCanModify: true,
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		mergedAt: null,
		mergeCommit: null,
		closingIssuesReferences: connection(
			options.closes.map((number) => ({ number, repository: { nameWithOwner: REPO_NAME } })),
			null,
		),
		statusCheckRollup: options.contexts === null ? null : { contexts: options.contexts },
	};
}

type IssueOptions = {
	children: Connection<Json>;
	closedBy: Connection<Json>;
};

function issueNode(options: IssueOptions): Json {
	return {
		number: ISSUE_NUMBER,
		repository: { nameWithOwner: REPO_NAME },
		body: "epic body",
		updatedAt: UPDATED_AT,
		state: "OPEN",
		subIssues: options.children,
		lastClose: { nodes: [{ id: "CLOSED_EVENT_1", createdAt: CLOSED_AT }] },
		lastReopen: { nodes: [{ id: "REOPENED_EVENT_1", createdAt: REOPENED_AT }] },
		closedByPullRequestsReferences: options.closedBy,
	};
}

function childRef(number: number): Json {
	return { number, repository: { nameWithOwner: REPO_NAME } };
}

export function prScope(): SourceScope {
	return { issues: [], prs: [{ repo: REPO, number: PR_NUMBER }], repos: [], branches: [], commits: [], checkRuns: [], creations: [] };
}

export function issueScope(): SourceScope {
	return { issues: [{ repo: REPO, number: ISSUE_NUMBER }], prs: [], repos: [], branches: [], commits: [], checkRuns: [], creations: [] };
}

export type PrScenario = "paginated" | "head-drift" | "stuck-cursor" | "null-cursor";

const RULES_CONTINUATION = 'ref(qualifiedName:"refs/heads/main") { name target { oid } rules(first:10,after:"rules-main-1")';
const CHECKS_CONTINUATION = `pullRequest(number:${PR_NUMBER}) { number headRefOid contexts(first:10,after:"ctx-1")`;
const SUB_ISSUES_CONTINUATION = `issue(number:${ISSUE_NUMBER}) { number repository { nameWithOwner } subIssues(first:10,after:"sub-1")`;
const REPOSITORY_BATCH_PREFIX = `a0:repository(owner:"${REPO.owner}",name:"${REPO.name}") { nameWithOwner viewerPermission defaultBranchRef`;

function paginatedPr(contexts: Connection<Json>): Json {
	return prNode({
		number: PR_NUMBER,
		headBranch: "feat/pagination",
		headOid: HEAD_OID,
		author: VIEWER,
		title: "Drain every page",
		body: "Serves paginated connections.",
		closes: [ISSUE_NUMBER],
		contexts,
		rules: RULES_FIRST,
		classic: RULES_CLASSIC,
	});
}

function prFirstPage(contexts: Connection<Json>): FakeGhRoute {
	return {
		when: REPOSITORY_BATCH_PREFIX,
		data: { viewer: { login: VIEWER }, a0: repoNode(RULES_FIRST, RULES_CLASSIC), a1: { pullRequest: paginatedPr(contexts) } },
	};
}

function checksContinuation(headRefOid: string, contexts: Connection<Json>): FakeGhRoute {
	return {
		when: CHECKS_CONTINUATION,
		data: { repository: { pullRequest: { number: PR_NUMBER, headRefOid, statusCheckRollup: { contexts } } } },
	};
}

export function prRoutes(scenario: PrScenario): FakeGhRoute[] {
	const rulesContinuation: FakeGhRoute = {
		when: RULES_CONTINUATION,
		data: { repository: { ref: { name: "main", target: { oid: MAIN_OID }, rules: RULES_SECOND } } },
	};
	if (scenario === "paginated") {
		return [prFirstPage(CONTEXTS_FIRST), rulesContinuation, checksContinuation(HEAD_OID, CONTEXTS_SECOND)];
	}
	if (scenario === "head-drift") {
		return [prFirstPage(CONTEXTS_FIRST), rulesContinuation, checksContinuation(DRIFTED_OID, CONTEXTS_SECOND)];
	}
	if (scenario === "stuck-cursor") {
		const stuck = { nodes: [statusContext("ci/nightly", "SUCCESS")], pageInfo: { hasNextPage: true, endCursor: "ctx-1" } };
		return [prFirstPage(CONTEXTS_FIRST), rulesContinuation, checksContinuation(HEAD_OID, stuck)];
	}
	return [prFirstPage({ nodes: CONTEXTS_FIRST.nodes, pageInfo: { hasNextPage: true, endCursor: null } }), rulesContinuation];
}

function linkedPrNode(link: LinkedPr): Json {
	return prNode({
		number: link.number,
		headBranch: link.headBranch,
		headOid: link.headOid,
		author: "mouriya",
		title: `Linked pull request ${link.number}`,
		body: `Closes #${ISSUE_NUMBER}`,
		closes: [ISSUE_NUMBER],
		contexts: null,
		rules: PLAIN_RULES,
		classic: PLAIN_CLASSIC,
	});
}

export function issueRoutes(): FakeGhRoute[] {
	const children = connection([101, 102, 103, 104, 105, 106, 107, 108, 109, 110].map(childRef), "sub-1");
	const firstLinked = linkedPrNode(LINKED[0]);
	const secondLinked = linkedPrNode(LINKED[1]);
	return [
		{
			when: REPOSITORY_BATCH_PREFIX,
			data: {
				viewer: { login: VIEWER },
				a0: repoNode(PLAIN_RULES, PLAIN_CLASSIC),
				a1: {
					issue: issueNode({
						children,
						closedBy: connection(
							LINKED.map((link) => childRef(link.number)),
							null,
						),
					}),
				},
			},
		},
		{
			when: SUB_ISSUES_CONTINUATION,
			data: {
				repository: {
					issue: {
						number: ISSUE_NUMBER,
						repository: { nameWithOwner: REPO_NAME },
						subIssues: connection([111, 112, 113].map(childRef), null),
					},
				},
			},
		},
		{
			when: `a0:repository(owner:"${REPO.owner}",name:"${REPO.name}") { pullRequest(number:${LINKED[0].number})`,
			data: { viewer: { login: VIEWER }, a0: { pullRequest: firstLinked }, a1: { pullRequest: secondLinked } },
		},
	];
}

const CLASSIC_REQUIREMENTS: RequiredCheckIdentity[] = [{ name: "ci/classic", source: { kind: "app", id: 7 } }];
const FIRST_PAGE_REQUIREMENTS: RequiredCheckIdentity[] = [
	{ name: "ci/build", source: { kind: "any" } },
	{ name: "ci/lint", source: { kind: "any" } },
	{ name: "ci/unit", source: { kind: "any" } },
	{ name: "ci/typecheck", source: { kind: "any" } },
	{ name: "ci/format", source: { kind: "any" } },
	{ name: "ci/docs", source: { kind: "any" } },
	{ name: "ci/security", source: { kind: "any" } },
	{ name: "ci/contract", source: { kind: "any" } },
];
const SECOND_PAGE_REQUIREMENTS: RequiredCheckIdentity[] = [
	{ name: "ci/e2e", source: { kind: "app", id: 42 } },
	{ name: "ci/nightly", source: { kind: "any" } },
	{ name: "ci/pack", source: { kind: "any" } },
];

export const SERVED = {
	childNumbers: [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113],
	rules: [RULES_FIRST, RULES_SECOND],
	plainRules: PLAIN_RULES,
	contextsPages: CONTEXTS_FIRST.nodes.length + CONTEXTS_SECOND.nodes.length,
	requiredChecks: [...CLASSIC_REQUIREMENTS, ...FIRST_PAGE_REQUIREMENTS, ...SECOND_PAGE_REQUIREMENTS],
};

const quoteForShell = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const BUN = process.execPath;
const FIXTURE = fileURLToPath(import.meta.url);

export async function startFakeGh(options: { routes: FakeGhRoute[] }): Promise<FakeGhSource> {
	const dir = mkdtempSync("/tmp/omp-gh-pagination-XXXXXX");
	const scenario = join(dir, "scenario.json");
	const log = join(dir, "requests.log");
	const shimFailure = join(dir, "shim.err");
	writeFileSync(scenario, `${JSON.stringify({ routes: options.routes })}\n`);
	writeFileSync(log, "");
	writeFileSync(shimFailure, "");
	const shim = join(dir, "gh");
	writeFileSync(
		shim,
		`#!/bin/sh\nFAKE_GH_SCENARIO=${quoteForShell(scenario)} FAKE_GH_LOG=${quoteForShell(log)} exec ${quoteForShell(BUN)} ${quoteForShell(FIXTURE)} "$@" 2>>${quoteForShell(shimFailure)}\n`,
	);
	chmodSync(shim, 0o755);
	return {
		dir,
		requests: () => readRequests(log),
		diagnostics: () => (existsSync(shimFailure) ? readFileSync(shimFailure, "utf8") : ""),
		async run<Value>(work: () => Promise<Value>): Promise<Value> {
			const previous = process.env.PATH;
			process.env.PATH = previous === undefined ? dir : `${dir}:${previous}`;
			try {
				return await work();
			} finally {
				if (previous === undefined) delete process.env.PATH;
				else process.env.PATH = previous;
			}
		},
		dispose: () => {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function readRequests(log: string): FakeGhRequest[] {
	return readFileSync(log, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line, index) => {
			const entry: unknown = JSON.parse(line);
			const parsed = requestSchema.safeParse(entry);
			if (!parsed.success) throw new Error(`Fake gh log line ${index + 1} is not a request: ${describe(parsed.error)}`);
			return parsed.data;
		});
}

function envelope(status: number, body: Json): string {
	return `HTTP/2.0 ${status} ${status === 200 ? "OK" : "Error"}\r\ncontent-type: application/json\r\nx-ratelimit-remaining: 4999\r\n\r\n${JSON.stringify(body)}`;
}

function queryOf(payload: string): string | null {
	if (payload.trim().length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return null;
	}
	const query = z.object({ query: z.string().min(1) }).safeParse(parsed);
	return query.success ? query.data.query : null;
}

function readRoutes(scenario: string): FakeGhRoute[] {
	const entry: unknown = JSON.parse(readFileSync(scenario, "utf8"));
	const parsed = z.object({ routes: z.array(routeSchema) }).safeParse(entry);
	if (!parsed.success) throw new Error(`Fake gh scenario is not a route table: ${describe(parsed.error)}`);
	return parsed.data.routes;
}

export async function runFakeGh(): Promise<void> {
	const scenario = process.env.FAKE_GH_SCENARIO;
	const log = process.env.FAKE_GH_LOG;
	if (scenario === undefined || log === undefined) throw new Error("Fake gh needs FAKE_GH_SCENARIO and FAKE_GH_LOG");
	const argv = process.argv.slice(2);
	const payload = argv.includes("--input") ? await Bun.stdin.text() : "";
	const query = queryOf(payload);
	appendFileSync(log, `${JSON.stringify({ argv, query: query ?? payload })}\n`);
	if (query === null) {
		writeSync(1, envelope(500, { message: `Fake gh received no GraphQL query: ${payload.slice(0, 400)}` }));
		return;
	}
	const matches = readRoutes(scenario).filter((route) => query.includes(route.when));
	if (matches.length === 0) {
		writeSync(1, envelope(500, { message: `Fake gh has no route for: ${query.slice(0, 800)}` }));
		return;
	}
	if (matches.length > 1) {
		writeSync(
			1,
			envelope(500, {
				message: `Fake gh route ambiguity ${matches.map((route) => JSON.stringify(route.when)).join(" ")} for: ${query.slice(0, 800)}`,
			}),
		);
		return;
	}
	const match = matches[0];
	writeSync(1, match === undefined ? envelope(500, { message: "Fake gh lost its route" }) : envelope(200, { data: match.data }));
}

if (import.meta.main) {
	await runFakeGh();
	process.exit(0);
}
