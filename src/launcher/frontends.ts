import {z} from '@oh-my-pi/omptype/zod';
import type {Runner} from './exec.ts';
import {launchTern,ternSpec} from './tern.ts';

/**
 * Where a coordinator process runs. The link names its frontend as a JSON
 * object discriminated by `kind`; every other field belongs to that frontend
 * and is checked by its own schema, so a new frontend extends the link without
 * changing its grammar. With a second frontend this becomes
 * `z.union([ternSpec, otherSpec])`.
 */
export const frontendSpec=ternSpec;
export type FrontendSpec=z.infer<typeof frontendSpec>;

/** What any frontend starts: `omp --dispatch <reference>` in `cwd`. */
export type CoordinatorTarget={reference:string;cwd:string};

/** `existing`: the frontend already runs a coordinator for this reference and started nothing. */
export type LaunchOutcome={kind:'launched'}|{kind:'existing';detail:string}|{kind:'frontendFailed';output:string};

function startFrontend(spec:FrontendSpec,target:CoordinatorTarget,exec:Runner):Promise<LaunchOutcome> {
  switch(spec.kind){
    case 'tern':return launchTern(target,exec);
  }
}

/** The last launch queued for each reference; it never rejects, and leaves once nothing follows it. */
const queued=new Map<string,Promise<void>>();

/**
 * Launches for one reference run one at a time, whichever listener asked: a
 * frontend decides `existing` from what it already runs, and a coordinator it
 * is still starting is not running yet. Waiting for the earlier launch lets the
 * frontend itself report the coordinator it just started, so one issue's
 * `opened` and `edited` deliveries, or a delivery and a click, start one
 * process. The queue orders launches only; the frontend stays the record of
 * what runs.
 */
export function launchFrontend(spec:FrontendSpec,target:CoordinatorTarget,exec:Runner):Promise<LaunchOutcome> {
  const launch=(queued.get(target.reference)??Promise.resolve()).then(()=>startFrontend(spec,target,exec));
  const settled=launch.then(()=>undefined,()=>undefined);
  queued.set(target.reference,settled);
  void settled.then(()=>{if(queued.get(target.reference)===settled)queued.delete(target.reference);});
  return launch;
}
