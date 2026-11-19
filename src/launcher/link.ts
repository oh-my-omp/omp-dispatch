import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "@oh-my-pi/omptype/zod";
import { parseIssueReference, refKey } from "../domain/identity.ts";
import type { IssueRef, Result } from "../domain/model.ts";
import { diagnosticText } from "./diagnostics.ts";
import { type FrontendSpec, frontendSpec } from "./frontends.ts";

/**
 * A configurable port would invalidate
 * every link already written into an issue, so it is a constant, not a setting.
 */
export const LAUNCHER_PORT = 47591;
export const LAUNCHER_ORIGIN = `http://127.0.0.1:${LAUNCHER_PORT}`;

const linkSpec = z.object({ cwd: z.string(), frontend: frontendSpec }).strict();

export type LaunchTarget = { issue: IssueRef; reference: string; cwd: string; frontend: FrontendSpec };
export type Rejection = { kind: "rejected"; reason: string };

export function refuse(reason: string): { ok: false; error: Rejection } {
	return { ok: false, error: { kind: "rejected", reason } };
}

export function isUserNavigation(navigation: { mode: string | undefined; user: string | undefined }): boolean {
	return navigation.mode === "navigate" && navigation.user === "?1";
}

export function parseLinkPath(pathname: string): Result<IssueRef, Rejection> {
	const segments = pathname.split("/").filter((segment) => segment.length > 0);
	if (segments.length !== 4) return refuse(diagnosticText({ kind: "linkPath" }));
	const [owner, repo, kind, number] = segments as [string, string, string, string];
	if (kind !== "issues") return refuse(diagnosticText({ kind: "issuePath" }));
	const reference = `${owner}/${repo}#${number}`,
		issue = parseIssueReference(reference);
	return issue.ok ? { ok: true, value: issue.value } : refuse(diagnosticText({ kind: "issueReference", value: reference }));
}

export async function resolveTarget(input: { pathname: string; search: string }): Promise<Result<LaunchTarget, Rejection>> {
	const path = parseLinkPath(input.pathname);
	if (!path.ok) return path;
	const raw = new URLSearchParams(input.search).get("spec");
	if (raw === null || raw.length === 0) return refuse(diagnosticText({ kind: "missingSpec" }));
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return refuse(diagnosticText({ kind: "specJson" }));
	}
	const spec = linkSpec.safeParse(json);
	if (!spec.success)
		return refuse(
			diagnosticText({
				kind: "specShape",
				detail: spec.error.issues.map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`).join("; "),
			}),
		);
	const { cwd, frontend } = spec.data;
	if (!isAbsolute(cwd)) return refuse(diagnosticText({ kind: "relativeCwd", cwd }));
	const directory = await stat(cwd).catch(() => null);
	if (!directory?.isDirectory()) return refuse(diagnosticText({ kind: "missingDirectory", cwd }));
	return { ok: true, value: { issue: path.value, reference: refKey(path.value), cwd, frontend } };
}

const LINK_PATTERN = new RegExp(`${LAUNCHER_ORIGIN.replaceAll(".", "\\.")}/[^\\s()<>"'\\]]+`, "g");

export function launcherLinks(text: string): URL[] {
	return [...text.matchAll(LINK_PATTERN)].flatMap((match) => (URL.canParse(match[0]) ? [new URL(match[0])] : []));
}
