import { join, resolve } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import type { Result } from "../domain/model.ts";

export type RuntimeSettings = { dataDir: string; intervalSeconds: number; meerkat: string | null };

const DEFAULT_INTERVAL_SECONDS = 120;
const MAX_INTERVAL_SECONDS = 2_147_483;

function pick(
	raw: Readonly<Record<string, unknown>>,
	env: Readonly<Record<string, string | undefined>>,
	key: string,
	variable: string,
): { source: string; value: unknown } {
	const fromEnv = env[variable];
	return fromEnv !== undefined ? { source: variable, value: fromEnv } : { source: `omp-dispatch.${key}`, value: raw[key] };
}

function invalid(picked: { source: string; value: unknown }, expected: string): { ok: false; error: string } {
	return { ok: false, error: `${picked.source} must be ${expected}, not ${JSON.stringify(picked.value)}` };
}

function wholeSeconds(value: unknown): number | null {
	const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
	return number !== null && Number.isSafeInteger(number) && number >= 1 && number <= MAX_INTERVAL_SECONDS ? number : null;
}

export function parseRuntimeSettings(
	raw: Readonly<Record<string, unknown>>,
	env: Readonly<Record<string, string | undefined>>,
	cwd: string,
	defaultDataDir: string,
): Result<RuntimeSettings, string> {
	const data = pick(raw, env, "dataDir", "OMP_DISPATCH_DIR");
	const dataDir = data.value ?? defaultDataDir;
	if (typeof dataDir !== "string" || !dataDir.trim()) return invalid(data, "a nonempty path");
	const interval = pick(raw, env, "recomputeIntervalSeconds", "OMP_DISPATCH_RECOMPUTE_SECONDS");
	const intervalSeconds = wholeSeconds(interval.value ?? DEFAULT_INTERVAL_SECONDS);
	if (intervalSeconds === null) return invalid(interval, `whole seconds from 1 to ${MAX_INTERVAL_SECONDS}`);
	const meerkat = pick(raw, env, "meerkatConfigDir", "OMP_DISPATCH_MEERKAT_CONFIG");
	const meerkatDir = meerkat.value ?? "";
	if (typeof meerkatDir !== "string") return invalid(meerkat, "a path string");
	return {
		ok: true,
		value: { dataDir: resolve(cwd, dataDir), intervalSeconds, meerkat: meerkatDir.trim() ? resolve(cwd, meerkatDir.trim()) : null },
	};
}

export async function readRuntimeSettings(cwd: string): Promise<Result<RuntimeSettings, string>> {
	return parseRuntimeSettings(await getPluginSettings("omp-dispatch", cwd), process.env, cwd, join(getAgentDir(), "omp-dispatch"));
}
