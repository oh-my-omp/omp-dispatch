import type { MarkerFact } from "./markers.ts";

export type Settlement =
	| { kind: "reply"; text: string; commentId: number }
	| { kind: "replaced"; by: string; commentId: number }
	| { kind: "escalated"; agenda: string; commentId: number };
export type IgnoredSettlement = { commentId: number; ask: number | null };

export function settlement(ask: number, markers: readonly MarkerFact[]): { settlement: Settlement | null; ignored: IgnoredSettlement[] } {
	let found: Settlement | null = null;
	const ignored: IgnoredSettlement[] = [];
	for (const marker of markers) {
		if (marker.id <= ask) continue;
		switch (marker.kind) {
			case "impl":
			case "ask":
				break;
			case "reply":
				if (marker.json.ask !== ask) ignored.push({ commentId: marker.id, ask: marker.json.ask });
				else if (found === null || found.kind === "escalated") found = { kind: "reply", text: marker.body, commentId: marker.id };
				break;
			case "replaced":
				if (marker.json.ask !== ask) ignored.push({ commentId: marker.id, ask: marker.json.ask });
				else if (found === null || found.kind === "escalated") found = { kind: "replaced", by: marker.json.by, commentId: marker.id };
				break;
			case "escalated":
				if (marker.json.ask !== ask) ignored.push({ commentId: marker.id, ask: marker.json.ask });
				else if (found === null) found = { kind: "escalated", agenda: marker.json.agenda, commentId: marker.id };
				break;
		}
	}
	return { settlement: found, ignored };
}
