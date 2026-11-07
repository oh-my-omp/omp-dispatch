import type { MarkerFact } from './markers.ts';

/** How the ask a ticket waits on was settled, read from the markers on its issue. */
export type Settlement =
  | { kind: 'reply'; text: string; commentId: number }
  | { kind: 'replaced'; by: string; commentId: number }
  | { kind: 'escalated'; agenda: string; commentId: number };
/** A settlement marker that names another ask (or none), so it does not settle the one waited on. */
export type IgnoredSettlement = { commentId: number; ask: number | null };

/**
 * The settlement of ask comment `ask` among an issue's markers, in comment order. Only markers naming that ask
 * count: the first `reply` or `replaced` settles it, and wins over an earlier `escalated`, which only says the
 * council took it up. Every settlement marker naming another ask is returned as ignored.
 */
export function settlement(ask: number, markers: readonly MarkerFact[]): { settlement: Settlement | null; ignored: IgnoredSettlement[] } {
  let found: Settlement | null = null;
  const ignored: IgnoredSettlement[] = [];
  for (const marker of markers) {
    switch (marker.kind) {
      case 'impl':
      case 'ask':
        break;
      case 'reply':
        if (marker.json.ask !== ask) ignored.push({ commentId: marker.id, ask: marker.json.ask });
        else if (found === null || found.kind === 'escalated') found = { kind: 'reply', text: marker.body, commentId: marker.id };
        break;
      case 'replaced':
        if (marker.json.ask !== ask) ignored.push({ commentId: marker.id, ask: marker.json.ask });
        else if (found === null || found.kind === 'escalated') found = { kind: 'replaced', by: marker.json.by, commentId: marker.id };
        break;
      case 'escalated':
        if (marker.json.ask !== ask) ignored.push({ commentId: marker.id, ask: marker.json.ask });
        else if (found === null) found = { kind: 'escalated', agenda: marker.json.agenda, commentId: marker.id };
        break;
    }
  }
  return { settlement: found, ignored };
}
