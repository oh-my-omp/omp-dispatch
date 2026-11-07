import {expect} from 'bun:test';
import type {Agenda,Facts} from '../src/domain/model.ts';
import {reconcile,reconciled} from '../src/domain/engine.ts';
import {canonical} from '../src/domain/identity.ts';

/**
 * Reconciles `state` in place, and checks the copy-on-write pass the controller uses against it: run on a shared
 * copy, the pass leaves that copy untouched, returns null exactly when the in-place pass changed nothing, and
 * otherwise returns a draft equal to the in-place result.
 */
export function checkedReconcile(state:Agenda,facts:Facts,at:number):void {
  const shared=structuredClone(state),before=canonical(state);
  const draft=reconciled(shared,facts,at);
  reconcile(state,facts,at);
  const after=canonical(state);
  expect(canonical(shared)).toBe(before);
  expect(draft===null).toBe(after===before);
  expect(canonical(draft??shared)).toBe(after);
}
