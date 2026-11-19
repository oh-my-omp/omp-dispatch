import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type {
	Agenda,
	AgendaId,
	Caller,
	CheckAttempt,
	ClosureGate,
	CoordinatorProcess,
	CreatedIssueObservation,
	DeepReadonly,
	Facts,
	IssueRef,
	IssueSnapshot,
	Millis,
	PortError,
	PrRef,
	PrSnapshot,
	Repo,
	Result,
	Role,
	Sha,
	SourceScope,
	Target,
	Ticket,
	Tier,
} from "../domain/model.ts";

export type PrWrite = { headRepo: Repo; branch: string; head: Sha; target: Target; title: string; body: string };
export type IssueWrite = { repo: Repo; title: string; body: string };
export type MeerkatProjectSource = { owner: string; number: number; statusField: string };
export interface GitHubPort {
	facts(scope: SourceScope, cause: string): Promise<Result<Facts, PortError>>;
	contains(repo: Repo, ancestor: Sha, descendant: Sha): Promise<Result<"contains" | "notContained" | "missing", PortError>>;
	branchHead(repo: Repo, branch: string): Promise<Result<{ kind: "missing" } | { kind: "present"; head: Sha }, PortError>>;
	issue(ref: IssueRef): Promise<Result<IssueSnapshot, PortError>>;
	pr(ref: PrRef): Promise<Result<PrSnapshot, PortError>>;
	openPrsByHead(headRepo: Repo, branch: string, target: Target): Promise<Result<readonly PrSnapshot[], PortError>>;
	issuesCreatedSince(repo: Repo, since: Millis): Promise<Result<readonly CreatedIssueObservation[], PortError>>;
	checkAttempt(repo: Repo, runId: number): Promise<Result<CheckAttempt, PortError>>;
	createIssue(input: IssueWrite): Promise<Result<IssueRef, PortError>>;
	addSubIssue(parent: IssueRef, child: IssueRef): Promise<Result<null, PortError>>;
	editIssueBody(issue: IssueRef, expectedHash: string, body: string): Promise<Result<null, PortError>>;
	setIssueOpen(issue: IssueRef, open: boolean): Promise<Result<null, PortError>>;
	createPr(input: PrWrite): Promise<Result<PrRef, PortError>>;
	editPr(pr: PrRef, input: PrWrite): Promise<Result<null, PortError>>;
	mergePr(pr: PrRef, head: Sha): Promise<Result<null, PortError>>;
	rerunCheck(repo: Repo, workflowRunId: number): Promise<Result<null, PortError>>;
	comment(issue: IssueRef, body: string): Promise<Result<number, PortError>>;
	setProjectField(issue: IssueRef, field: "status", option: string): Promise<Result<null, PortError>>;
}
export type AskRequest = { issue: IssueRef; comment: number; question: string; tier: Tier };
export interface GuardiansPort {
	requestAnswer(request: AskRequest): Promise<Result<200 | 202, PortError>>;
}
export type StateError = { kind: "notFound" | "unsupportedFormat" | "corruptState" | "versionConflict" | "unavailable"; message: string };
export type WorkflowError = { source: string; reason: string };
export type AgendaEntry = { id: AgendaId; lifecycle: "active" | "completed" };
export interface AgendaFiles {
	load(id: AgendaId): Promise<Result<Agenda, StateError>>;
	list(): Promise<Result<readonly AgendaEntry[], StateError>>;
	save(expectedVersion: number | null, state: Agenda): Promise<Result<null, StateError>>;
}
export type FileMetrics = { replaces: number; unchangedReplaces: number };
export type SeatWorkspace =
	| { kind: "fork"; sessionFile: string }
	| { kind: "base"; target: Target }
	| { kind: "commit"; repo: Repo; sha: Sha; pull: number | null };
export type SeatLaunch = {
	agendaId: string;
	ticketId: string;
	revision: number;
	role: Role;
	seat: "work" | "judge";
	agent: string;
	cwd: string;
	prompt: string;
	resume: string | null;
	ticket: DeepReadonly<Ticket | ClosureGate>;
	workspace: SeatWorkspace;
};
export type SeatHandle = { agentId: string; sessionId: string; sessionFile: string; jobId: string };
export type SeatExit = { ticketId: string; role: Role; revision: number };
export interface HostPort {
	bind(ctx: ExtensionContext): Result<Caller, PortError>;
	launch(input: SeatLaunch): Promise<Result<SeatHandle, PortError>>;
	agents(cwd: string, names: readonly string[]): Promise<Result<null, PortError>>;
	active(ticketId: string, role: Role): boolean;
	seated(ticketId: string, role: Role, revision: number): boolean;
	finish(agendaId: string): Promise<Result<null, PortError>>;
	dispose(): Promise<void>;
}
export type ProcessStart = { kind: "absent" } | { kind: "running"; startedAt: string };
export interface ProcessPort {
	current(): Promise<Result<CoordinatorProcess, PortError>>;
	start(pid: number): Promise<Result<ProcessStart, PortError>>;
}
