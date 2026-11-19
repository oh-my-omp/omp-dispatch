import type { ProcessPort } from "../src/ports/contracts.ts";

export class ProcessTable {
	private readonly running = new Map<number, string>();
	spawn(pid: number, startedAt: string): ProcessPort {
		this.running.set(pid, startedAt);
		return {
			current: async () =>
				this.running.get(pid) === startedAt
					? { ok: true, value: { pid, startedAt } }
					: { ok: false, error: { kind: "invalidResponse", message: `pid ${pid} is not running` } },
			start: async (target) => {
				const found = this.running.get(target);
				return { ok: true, value: found === undefined ? { kind: "absent" } : { kind: "running", startedAt: found } };
			},
		};
	}
	kill(pid: number): void {
		this.running.delete(pid);
	}
}
