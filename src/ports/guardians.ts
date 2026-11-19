import type { PortError, Result } from "../domain/model.ts";
import type { AskRequest, GuardiansPort } from "./contracts.ts";

const TIMEOUT_MS = 60_000;

export function createGuardiansPort(baseURL: string): GuardiansPort {
	const url = `${baseURL.replace(/\/+$/, "")}/v1/asks`;
	return {
		async requestAnswer(request: AskRequest): Promise<Result<200 | 202, PortError>> {
			const body = JSON.stringify({
				issue: `${request.issue.repo.owner}/${request.issue.repo.name}#${request.issue.number}`,
				comment: request.comment,
				question: request.question,
				tier: request.tier,
			});
			let response: Response;
			try {
				response = await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});
			} catch (error) {
				return {
					ok: false,
					error: { kind: "unavailable", message: `POST ${url}: ${error instanceof Error ? error.message : String(error)}` },
				};
			}
			if (response.status === 200 || response.status === 202) return { ok: true, value: response.status };
			const text = await response
				.text()
				.catch((error: unknown) => `(body unreadable: ${error instanceof Error ? error.message : String(error)})`);
			return {
				ok: false,
				error: {
					kind: response.status >= 400 && response.status < 500 ? "precondition" : "unavailable",
					message: `POST ${url} answered HTTP ${response.status}: ${text}`,
				},
			};
		},
	};
}
