import { z } from "@oh-my-pi/omptype/zod";

const text = z.string().min(1);
const commentId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const issueRef = z.string().regex(/^[^/\s#]+\/[^/\s#]+#[1-9][0-9]*$/);
const version = z.literal(1);
export const implMarkerSchema = z.object({
	v: version,
	host: text,
	pid: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
	agenda: text,
	session: text,
	file: text,
});
export const askMarkerSchema = z.object({ v: version, tier: z.enum(["simple", "complex"]), session: text });
export const replyMarkerSchema = z.object({ v: version, ask: commentId, decision: issueRef.nullable() });
export const replacedMarkerSchema = z.object({ v: version, ask: commentId.nullable(), by: issueRef });
export const escalatedMarkerSchema = z.object({ v: version, ask: commentId, agenda: issueRef });
export const markerKindSchema = z.enum(["impl", "ask", "reply", "replaced", "escalated"]);
export type MarkerKind = z.infer<typeof markerKindSchema>;
export const markerFactSchema = z.union([
	z.object({ id: commentId, kind: z.literal("impl"), json: implMarkerSchema }).strict(),
	z.object({ id: commentId, kind: z.literal("ask"), json: askMarkerSchema }).strict(),
	z.object({ id: commentId, kind: z.literal("reply"), json: replyMarkerSchema, body: z.string() }).strict(),
	z.object({ id: commentId, kind: z.literal("replaced"), json: replacedMarkerSchema }).strict(),
	z.object({ id: commentId, kind: z.literal("escalated"), json: escalatedMarkerSchema }).strict(),
]);
export type MarkerFact = z.infer<typeof markerFactSchema>;
export type Marker = { [Kind in MarkerKind]: { kind: Kind; json: Extract<MarkerFact, { kind: Kind }>["json"] } }[MarkerKind];

const LINE = /^<!-- meerkat:([a-z]+) (\{.*\}) -->$/;

export function formatMarker(marker: Marker): string {
	return `<!-- meerkat:${marker.kind} ${JSON.stringify(marker.json)} -->`;
}

export type MarkerRead = { kind: "none" } | { kind: "invalid"; reason: string } | { kind: "marker"; fact: MarkerFact };
export function parseMarker(id: number, body: string): MarkerRead {
	const lines = body.trimEnd().split("\n");
	const last = lines.at(-1)?.trim() ?? "";
	if (!last.startsWith("<!-- meerkat:")) return { kind: "none" };
	const match = LINE.exec(last);
	if (!match) return { kind: "invalid", reason: `comment ${id}: marker line is not <!-- meerkat:<kind> <JSON> -->` };
	let json: unknown;
	try {
		json = JSON.parse(match[2]!);
	} catch {
		return { kind: "invalid", reason: `comment ${id}: marker JSON does not parse` };
	}
	const kind = match[1];
	const parsed = markerFactSchema.safeParse({
		id,
		kind,
		json,
		...(kind === "reply" ? { body: lines.slice(0, -1).join("\n").trim() } : {}),
	});
	if (!parsed.success)
		return {
			kind: "invalid",
			reason: `comment ${id}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
		};
	return { kind: "marker", fact: parsed.data };
}
