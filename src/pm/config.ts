import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { YAML } from 'bun';
import { z, type ZodLikeSchema } from '@oh-my-pi/omptype/zod';
import type { Result } from '../domain/model.ts';

/** The PM configuration Dispatch reads from `dispatch.pmConfigDir`: two shared files and its own delivery file. */
const object = <const S extends Readonly<Record<string, ZodLikeSchema<unknown>>>>(shape: S) => z.object(shape).strict();
const text = z.string().min(1);
const repo = z.string().regex(/^[^/\s]+\/[^/\s]+$/);
const options = <const Keys extends readonly string[]>(keys: Keys) => object(Object.fromEntries(keys.map(key => [key, text])) as { [Key in Keys[number]]: typeof text });
const reposSchema = object({
  pm: object({ repo, project: object({ owner: text, number: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }) }),
  code: z.array(object({ repo, cwd: text })),
  design: z.array(repo),
  omp: z.array(repo),
});
const projectSchema = object({
  fields: object({
    status: object({ name: text, options: options(['todo', 'inProgress', 'done', 'superseded'] as const) }),
    kind: object({ name: text, options: options(['human', 'agenda', 'implementation'] as const) }),
    agenda: object({ name: text }),
    proposer: object({ name: text, options: options(['human', 'guardians', 'coordination'] as const) }),
  }),
});
const deliverySchema = object({
  guardiansURL: z.string().regex(/^https?:\/\/[^\s/]+(?:\/\S*)?$/),
  defaultTier: z.enum(['simple', 'complex']),
  tierHelp: text,
  resumePrompt: text,
});
export type PmRepos = z.infer<typeof reposSchema>;
export type PmProject = z.infer<typeof projectSchema>;
export type PmDelivery = z.infer<typeof deliverySchema>;
export type PmConfig = { root: string; repos: PmRepos; project: PmProject; delivery: PmDelivery };

export const PM_FILES = { repos: 'shared/repos.yaml', project: 'shared/project.yaml', delivery: 'dispatch/delivery.yaml' } as const;

/** Each problem is one line `<file>: <key path>: <problem>`. */
async function readConfig<T>(root: string, file: string, schema: ZodLikeSchema<T>): Promise<Result<T, string[]>> {
  const path = join(root, file);
  let source: string;
  try { source = await readFile(path, 'utf8'); } catch (error) { return { ok: false, error: [`${path}: (file): cannot be read: ${error instanceof Error ? error.message : String(error)}`] }; }
  let value: unknown;
  try { value = YAML.parse(source); } catch (error) { return { ok: false, error: [`${path}: (file): invalid YAML: ${error instanceof Error ? error.message : String(error)}`] }; }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: parsed.error.issues.map(issue => `${path}: ${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`) };
}

/** Reads and strictly validates every PM file under `root`; any unknown or missing key refuses the whole configuration. */
export async function loadPmConfig(root: string): Promise<Result<PmConfig, string>> {
  const [repos, project, delivery] = await Promise.all([
    readConfig(root, PM_FILES.repos, reposSchema), readConfig(root, PM_FILES.project, projectSchema), readConfig(root, PM_FILES.delivery, deliverySchema)]);
  if (repos.ok && project.ok && delivery.ok) return { ok: true, value: { root, repos: repos.value, project: project.value, delivery: delivery.value } };
  return { ok: false, error: [repos, project, delivery].flatMap(item => item.ok ? [] : item.error).join('\n') };
}
