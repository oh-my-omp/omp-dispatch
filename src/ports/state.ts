import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from '@oh-my-pi/omptype/zod';
import { agendaIdSchema } from '../domain/model.ts';
import type { Agenda, AgendaId, Result } from '../domain/model.ts';
import { encodeAgenda, parseAgenda } from '../domain/parse.ts';
import type { AgendaEntry, AgendaFiles, FileMetrics, StateError } from './contracts.ts';

const envelopeSchema = z.object({
  format: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  state: z.unknown(),
}).strict();

type StateResult<T> = Result<T, StateError>;

function failure<T>(kind: StateError['kind'], message: string): StateResult<T> {
  return { ok: false, error: { kind, message } };
}

function unavailable<T>(operation: string, error: unknown): StateResult<T> {
  return failure('unavailable', `${operation}: ${error instanceof Error ? error.message : 'Filesystem operation failed'}`);
}

function decode(contents: string, id: AgendaId): StateResult<Agenda> {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return failure('corruptState', `Agenda ${id}: invalid JSON`);
  }
  if (typeof value === 'object' && value !== null && 'format' in value
    && typeof value.format === 'number' && Number.isInteger(value.format) && value.format !== 9) {
    return failure('unsupportedFormat', `Agenda ${id}: unsupported format ${value.format}`);
  }
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) return failure('corruptState', `Agenda ${id}: invalid state envelope`);
  const state = parseAgenda(parsed.data.state);
  if (!state.ok) return failure('corruptState', `Agenda ${id}: ${state.error.path}: ${state.error.reason}`);
  if (state.value.id !== id) return failure('corruptState', `Agenda ${id}: envelope identity does not match filename`);
  return state;
}

type EnvelopeHead = { format: number; id: string; version: number; lifecycle: 'active' | 'completed' };

const ENVELOPE_HEAD = /^\{"format":(-?\d+),"state":\{"id":"([^"]+)","version":(-?\d+),"nextId":-?\d+,"convenedAt":-?\d+,"lifecycle":"(active|completed)"/;

/** The envelope head exactly as this module writes it; null on any older or foreign shape. */
function envelopeHead(text: string): EnvelopeHead | null {
  const head = ENVELOPE_HEAD.exec(text);
  if (head === null) return null;
  const format = head[1], id = head[2], version = head[3], lifecycle = head[4];
  if (format === undefined || id === undefined || version === undefined || (lifecycle !== 'active' && lifecycle !== 'completed')) return null;
  return { format: Number(format), id, version: Number(version), lifecycle };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** A single controller owns writes; expectedVersion is not a cross-process CAS. */
export function createAgendaFiles(dataDir: string, metrics?: FileMetrics): AgendaFiles {
  const directory = join(dataDir, 'state');
  let preparation: Promise<void> | undefined;
  async function prepareDirectory(): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await syncDirectory(directory);
  }
  function prepare(): Promise<void> {
    // This port prepares only its own state directory. Failed preparation can retry.
    return preparation ??= prepareDirectory().catch(error => {
      preparation = undefined;
      throw error;
    });
  }

  async function load(id: AgendaId): Promise<StateResult<Agenda>> {
    if (!agendaIdSchema.safeParse(id).success) return failure('corruptState', 'Invalid agenda filename identity');
    let contents: string;
    try {
      contents = await readFile(join(directory, `${id}.json`), 'utf8');
    } catch (error) {
      return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
        ? failure('notFound', `Agenda ${id} was not found`)
        : unavailable(`Read agenda ${id}`, error);
    }
    return decode(contents, id);
  }

  async function list(): Promise<StateResult<readonly AgendaEntry[]>> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
        ? { ok: true, value: [] }
        : unavailable('List agendas', error);
    }
    const entries: AgendaEntry[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!agendaIdSchema.safeParse(id).success) return failure('corruptState', 'Invalid agenda filename identity');
      let head: EnvelopeHead | null = null;
      try {
        const handle = await open(join(directory, name), 'r');
        try {
          const buffer = Buffer.alloc(512);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          head = envelopeHead(buffer.toString('utf8', 0, bytesRead));
        } finally {
          await handle.close();
        }
      } catch (error) {
        return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
          ? failure('notFound', `Agenda ${id} was not found`)
          : unavailable(`Read agenda ${id}`, error);
      }
      if (head !== null && head.format === 9 && head.id === id) {
        entries.push({ id, lifecycle: head.lifecycle });
        continue;
      }
      const state = await load(id);
      if (!state.ok) return state;
      entries.push({ id: state.value.id, lifecycle: state.value.lifecycle });
    }
    return { ok: true, value: entries };
  }

  async function save(expectedVersion: number | null, supplied: Agenda): Promise<StateResult<null>> {
    // Round-trip through the persisted form, so only a state that loads back exactly is ever written.
    const encoded = encodeAgenda(supplied);
    const parsed = parseAgenda(encoded);
    if (!parsed.ok) return failure('corruptState', `${parsed.error.path}: ${parsed.error.reason}`);
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      return failure('versionConflict', 'Expected version must be a positive integer or null');
    }
    const state = parsed.value;
    const target = join(directory, `${state.id}.json`);
    // Capture the complete target once, before any I/O. Retrying never recomputes a transition.
    const contents = `${JSON.stringify({ format: 9, state: encoded })}\n`;
    let previousText: string | null;
    try {
      previousText = await readFile(target, 'utf8');
    } catch (error) {
      const missing = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
      if (!missing) return unavailable(`Read agenda ${state.id}`, error);
      previousText = null;
    }

    if (previousText === contents) {
      // Rename may already have succeeded while directory fsync failed. Repair
      // durability against the actual target without replacing unchanged content.
      try {
        await prepare();
        const handle = await open(target, 'r');
        try {
          await handle.chmod(0o600);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncDirectory(directory);
        return { ok: true, value: null };
      } catch (error) {
        return unavailable(`Sync agenda ${state.id}`, error);
      }
    }

    let previousVersion: number | null;
    if (previousText === null) {
      previousVersion = null;
    } else {
      const head = envelopeHead(previousText);
      if (head !== null && head.format === 9 && head.id === state.id) {
        previousVersion = head.version;
      } else {
        // Anything this module would not have written gets the full decode, so
        // corrupt, unsupported or mismatched files report exactly as before.
        const previous = decode(previousText, state.id);
        if (!previous.ok) return previous;
        previousVersion = previous.value.version;
      }
    }
    if (previousVersion !== expectedVersion) {
      return failure('versionConflict', `Agenda ${state.id}: expected ${expectedVersion ?? 'no existing state'}, found ${previousVersion ?? 'no existing state'}`);
    }

    const temporary = join(directory, `.${state.id}.${randomUUID()}.tmp`);
    let temporaryCreated = false;
    let renamed = false;
    try {
      await prepare();
      const handle = await open(temporary, 'wx', 0o600);
      temporaryCreated = true;
      try {
        // chmod also makes 0600 exact when the process umask removes owner bits.
        await handle.chmod(0o600);
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
      renamed = true;
      if (metrics) metrics.replaces += 1;
      await syncDirectory(directory);
      return { ok: true, value: null };
    } catch (error) {
      return unavailable(`Save agenda ${state.id}`, error);
    } finally {
      if (temporaryCreated && !renamed) {
        // Only our uncommitted temporary file is disposable. Preserve the
        // original failure if cleanup itself cannot access the filesystem.
        try { await unlink(temporary); } catch { /* The save result already reports failure. */ }
      }
    }
  }

  return { load, list, save };
}
