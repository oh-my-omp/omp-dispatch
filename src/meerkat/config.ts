import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { YAML } from 'bun';
import { z, type ZodLikeSchema } from '@oh-my-pi/omptype/zod';
import type { Result } from '../domain/model.ts';

/** The Meerkat configuration Dispatch reads from the `meerkatConfigDir` plugin setting: two shared files and its own delivery file. */
const object = <const S extends Readonly<Record<string, ZodLikeSchema<unknown>>>>(shape: S) => z.object(shape).strict();
const text = z.string().min(1);
const repo = z.string().regex(/^[^/\s]+\/[^/\s]+$/);
const options = <const Keys extends readonly string[]>(keys: Keys) => object(Object.fromEntries(keys.map(key => [key, text])) as { [Key in Keys[number]]: typeof text });
const reposSchema = object({
  agenda: object({ repo, project: object({ owner: text, number: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }) }),
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
export type MeerkatRepos = z.infer<typeof reposSchema>;
export type MeerkatProject = z.infer<typeof projectSchema>;
export type MeerkatDelivery = z.infer<typeof deliverySchema>;
export type MeerkatParts = { repos: MeerkatRepos; project: MeerkatProject; delivery: MeerkatDelivery };
export type MeerkatConfig = MeerkatParts & { root: string };

export const MEERKAT_FILES = { repos: 'shared/repos.yaml', project: 'shared/project.yaml', delivery: 'dispatch/delivery.yaml' } as const;
const MEERKAT_FILE_LIST: readonly string[] = Object.values(MEERKAT_FILES);

/** One problem: the file (relative to the Meerkat config directory), the key path (`(file)` when the file as a whole is at fault), and the reason. */
export type MeerkatFileError = { file: string; key: string; message: string };

function parseFile<T>(file: string, source: string, schema: ZodLikeSchema<T>): Result<T, MeerkatFileError[]> {
  let value: unknown;
  try { value = YAML.parse(source); } catch (error) { return { ok: false, error: [{ file, key: '(file)', message: `invalid YAML: ${error instanceof Error ? error.message : String(error)}` }] }; }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: parsed.error.issues.map(issue => ({ file, key: issue.path.length ? issue.path.join('.') : '(root)', message: issue.message })) };
}

function checkFile<T>(files: Readonly<Record<string, string>>, file: string, schema: ZodLikeSchema<T>): Result<T, MeerkatFileError[]> {
  const source = files[file];
  if (source === undefined) return { ok: false, error: [{ file, key: '(file)', message: 'is missing' }] };
  return parseFile(file, source, schema);
}

/**
 * Strictly validates the full text of every Meerkat file, keyed by its path relative to the Meerkat config directory.
 * Exactly the three Meerkat files are accepted; each problem names its file and key path.
 */
export function validateMeerkatFiles(files: Readonly<Record<string, string>>): Result<MeerkatParts, MeerkatFileError[]> {
  const unknown: MeerkatFileError[] = Object.keys(files)
    .filter(file => !MEERKAT_FILE_LIST.includes(file))
    .map(file => ({ file, key: '(file)', message: 'is not a Meerkat configuration file' }));
  const repos = checkFile(files, MEERKAT_FILES.repos, reposSchema);
  const project = checkFile(files, MEERKAT_FILES.project, projectSchema);
  const delivery = checkFile(files, MEERKAT_FILES.delivery, deliverySchema);
  if (repos.ok && project.ok && delivery.ok && unknown.length === 0) return { ok: true, value: { repos: repos.value, project: project.value, delivery: delivery.value } };
  return { ok: false, error: [...unknown, ...(repos.ok ? [] : repos.error), ...(project.ok ? [] : project.error), ...(delivery.ok ? [] : delivery.error)] };
}

/** Reads the three Meerkat files under `root` and validates them; any unknown or missing key refuses the whole configuration. */
export async function loadMeerkatConfig(root: string): Promise<Result<MeerkatConfig, string>> {
  const files: Record<string, string> = {};
  const unreadable: MeerkatFileError[] = [];
  for (const file of MEERKAT_FILE_LIST) {
    try { files[file] = await readFile(join(root, file), 'utf8'); } catch (error) { unreadable.push({ file, key: '(file)', message: `cannot be read: ${error instanceof Error ? error.message : String(error)}` }); }
  }
  const problems = unreadable.length > 0 ? { ok: false as const, error: unreadable } : validateMeerkatFiles(files);
  if (!problems.ok) return { ok: false, error: problems.error.map(item => `${join(root, item.file)}: ${item.key}: ${item.message}`).join('\n') };
  return { ok: true, value: { root, ...problems.value } };
}
