import { join, resolve } from "node:path";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import type { Result, Workflow } from "../domain/model.ts";
import type { WorkflowError } from "./contracts.ts";
import { loadWorkflow } from "./workflow.ts";

export async function configuredWorkflow(cwd: string, dataDir: string): Promise<Result<Workflow, WorkflowError>> {
	const settings = await getPluginSettings("omp-dispatch", cwd);
	const file: unknown = process.env.OMP_DISPATCH_WORKFLOW ?? settings.workflowFile;
	if (file === undefined) return loadWorkflow({ kind: "dataDir", path: join(dataDir, "workflow.yml") });
	if (typeof file !== "string" || !file.trim())
		return { ok: false, error: { source: "omp-dispatch.workflowFile", reason: "Dispatch workflowFile must be a nonempty string" } };
	return loadWorkflow({ kind: "configured", path: resolve(cwd, file) });
}
