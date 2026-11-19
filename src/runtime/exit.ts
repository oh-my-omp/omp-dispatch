import { logger } from "@oh-my-pi/pi-coding-agent";
import type { ReadonlyAgenda } from "../domain/model.ts";

export class RuntimeExit {
	private granted: null | (() => void) = null;
	private requested = false;
	grant(request: () => void): void {
		this.granted ??= request;
	}
	commit(finished: boolean, agenda: ReadonlyAgenda | null): void {
		if (this.requested || !finished) return;
		if (!this.granted) return;
		if (agenda?.lifecycle !== "completed") return;
		this.requested = true;
		logger.info("Dispatch agenda is completed; the coordinator exits with it", { agendaId: agenda.id });
		this.granted();
	}
}
