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
export type PmParts = { repos: PmRepos; project: PmProject; delivery: PmDelivery };
export type PmConfig = PmParts & { root: string };

export const PM_FILES = { repos: 'shared/repos.yaml', project: 'shared/project.yaml', delivery: 'dispatch/delivery.yaml' } as const;
const PM_FILE_LIST: readonly string[] = Object.values(PM_FILES);

/** One problem: the file (relative to the PM config directory), the key path (`(file)` when the file as a whole is at fault), and the reason. */
export type PmFileError = { file: string; key: string; message: string };

function parseFile<T>(file: string, source: string, schema: ZodLikeSchema<T>): Result<T, PmFileError[]> {
  let value: unknown;
  try { value = YAML.parse(source); } catch (error) { return { ok: false, error: [{ file, key: '(file)', message: `invalid YAML: ${error instanceof Error ? error.message : String(error)}` }] }; }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: parsed.error.issues.map(issue => ({ file, key: issue.path.length ? issue.path.join('.') : '(root)', message: issue.message })) };
}

function checkFile<T>(files: Readonly<Record<string, string>>, file: string, schema: ZodLikeSchema<T>): Result<T, PmFileError[]> {
  const source = files[file];
  if (source === undefined) return { ok: false, error: [{ file, key: '(file)', message: 'is missing' }] };
  return parseFile(file, source, schema);
}

/**
 * Strictly validates the full text of every PM file, keyed by its path relative to the PM config directory.
 * Exactly the three PM files are accepted; each problem names its file and key path.
 */
export function validatePmFiles(files: Readonly<Record<string, string>>): Result<PmParts, PmFileError[]> {
  const unknown: PmFileError[] = Object.keys(files)
    .filter(file => !PM_FILE_LIST.includes(file))
    .map(file => ({ file, key: '(file)', message: 'is not a PM configuration file' }));
  const repos = checkFile(files, PM_FILES.repos, reposSchema);
  const project = checkFile(files, PM_FILES.project, projectSchema);
  const delivery = checkFile(files, PM_FILES.delivery, deliverySchema);
  if (repos.ok && project.ok && delivery.ok && unknown.length === 0) return { ok: true, value: { repos: repos.value, project: project.value, delivery: delivery.value } };
  return { ok: false, error: [...unknown, ...(repos.ok ? [] : repos.error), ...(project.ok ? [] : project.error), ...(delivery.ok ? [] : delivery.error)] };
}

/** Reads the three PM files under `root` and validates them; any unknown or missing key refuses the whole configuration. */
export async function loadPmConfig(root: string): Promise<Result<PmConfig, string>> {
  const files: Record<string, string> = {};
  const unreadable: PmFileError[] = [];
  for (const file of PM_FILE_LIST) {
    try { files[file] = await readFile(join(root, file), 'utf8'); } catch (error) { unreadable.push({ file, key: '(file)', message: `cannot be read: ${error instanceof Error ? error.message : String(error)}` }); }
  }
  const problems = unreadable.length > 0 ? { ok: false as const, error: unreadable } : validatePmFiles(files);
  if (!problems.ok) return { ok: false, error: problems.error.map(item => `${join(root, item.file)}: ${item.key}: ${item.message}`).join('\n') };
  return { ok: true, value: { root, ...problems.value } };
}
