import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { YAML } from "bun";
import type { Result, Workflow } from "../domain/model.ts";
import { parseWorkflow } from "../domain/workflow.ts";
import type { WorkflowError } from "./contracts.ts";

/** Where the next agenda's workflow comes from: a configured file, or the data directory's optional override. */
export type WorkflowSource = { kind: "configured"; path: string } | { kind: "dataDir"; path: string };
const BUILT_IN = fileURLToPath(new URL("../default-workflow.yml", import.meta.url));

type Read = { kind: "text"; text: string } | { kind: "missing" } | { kind: "failed"; reason: string };
async function read(path: string): Promise<Read> {
	try {
		return { kind: "text", text: await readFile(path, "utf8") };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { kind: "missing" };
		return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
	}
}
function decode(source: string, text: string): Result<Workflow, WorkflowError> {
	let value: unknown;
	try {
		value = YAML.parse(text);
	} catch (error) {
		return { ok: false, error: { source, reason: `Invalid YAML: ${error instanceof Error ? error.message : String(error)}` } };
	}
	const parsed = parseWorkflow(value);
	return parsed.ok ? parsed : { ok: false, error: { source, reason: `${parsed.error.path}: ${parsed.error.reason}` } };
}

/** Read once per convene: the parsed workflow is a copy of the file at that moment, frozen into the new agenda. */
export async function loadWorkflow(source: WorkflowSource): Promise<Result<Workflow, WorkflowError>> {
	const own = await read(source.path);
	switch (own.kind) {
		case "text":
			return decode(source.path, own.text);
		case "failed":
			return { ok: false, error: { source: source.path, reason: own.reason } };
		case "missing": {
			if (source.kind === "configured")
				return { ok: false, error: { source: source.path, reason: "The configured workflow file does not exist" } };
			const builtIn = await read(BUILT_IN);
			if (builtIn.kind !== "text")
				return {
					ok: false,
					error: {
						source: BUILT_IN,
						reason: builtIn.kind === "failed" ? builtIn.reason : "The built-in workflow is missing from the package",
					},
				};
			return decode(BUILT_IN, builtIn.text);
		}
	}
}
