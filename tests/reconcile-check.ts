import { expect } from "bun:test";
import { reconcile, reconciled } from "../src/domain/engine.ts";
import { canonical } from "../src/domain/identity.ts";
import type { Agenda, Facts } from "../src/domain/model.ts";

export function checkedReconcile(state: Agenda, facts: Facts, at: number): void {
	const shared = structuredClone(state),
		before = canonical(state);
	const draft = reconciled(shared, facts, at);
	reconcile(state, facts, at);
	const after = canonical(state);
	expect(canonical(shared)).toBe(before);
	expect(draft === null).toBe(after === before);
	expect(canonical(draft ?? shared)).toBe(after);
}
