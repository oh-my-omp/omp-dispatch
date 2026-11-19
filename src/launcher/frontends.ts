import type { z } from "@oh-my-pi/omptype/zod";
import type { Runner } from "./exec.ts";
import { launchTern, ternSpec } from "./tern.ts";

export const frontendSpec = ternSpec;
export type FrontendSpec = z.infer<typeof frontendSpec>;

export type CoordinatorTarget = { reference: string; cwd: string };

export type LaunchOutcome = { kind: "launched" } | { kind: "existing"; detail: string } | { kind: "frontendFailed"; output: string };

function startFrontend(spec: FrontendSpec, target: CoordinatorTarget, exec: Runner): Promise<LaunchOutcome> {
	switch (spec.kind) {
		case "tern":
			return launchTern(target, exec);
	}
}

const queued = new Map<string, Promise<void>>();

export function launchFrontend(spec: FrontendSpec, target: CoordinatorTarget, exec: Runner): Promise<LaunchOutcome> {
	const launch = (queued.get(target.reference) ?? Promise.resolve()).then(() => startFrontend(spec, target, exec));
	const settled = launch.then(
		() => undefined,
		() => undefined,
	);
	queued.set(target.reference, settled);
	void settled.then(() => {
		if (queued.get(target.reference) === settled) queued.delete(target.reference);
	});
	return launch;
}
