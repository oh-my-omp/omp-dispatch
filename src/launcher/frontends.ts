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

export function launchFrontend(spec:FrontendSpec,target:CoordinatorTarget,exec:Runner):Promise<LaunchOutcome> {
  switch(spec.kind){
    case 'tern':return launchTern(target,exec);
  }
}
