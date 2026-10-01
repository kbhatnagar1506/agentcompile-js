// How a conversation ended, reported by you: `outcome(ticket.id, "resolved")`. AgentCompile
// learns only from conversations that went well; an outcome you report is the strongest
// evidence it has. Sent in the background (never blocks, never throws), with the key and address
// of the client you wrapped last.

import { type Settings, endpoint, headers } from "./decide.js";

export const OUTCOMES = ["resolved", "escalated", "unresolved", "abandoned", "reopened", "complaint"] as const;
export type Outcome = (typeof OUTCOMES)[number];

let last: Settings | null = null;
const pending = new Set<Promise<void>>();
export const counts = { sent: 0, failed: 0 };

export function remember(settings: Settings): void {
  last = settings;
}

/** Report how a conversation ended. Throws for an unknown label (a typo would be lost). */
export function outcome(conversationId: string, label: Outcome, note?: string): void {
  if (!OUTCOMES.includes(label)) throw new Error(`outcome must be one of ${OUTCOMES.join(", ")}`);
  if (!last) return; // nothing wrapped yet: nowhere to send it
  const settings = last;
  const record: Record<string, string> = {
    conversation_id: conversationId,
    outcome: label,
    timestamp: new Date().toISOString(),
  };
  if (note) record.note = note;
  const sending = (async () => {
    try {
      const response = await settings.fetch(endpoint(settings, "/v1/outcome"), {
        method: "POST",
        headers: headers(settings),
        body: JSON.stringify({ outcomes: [record] }),
      });
      if (response.status === 200) counts.sent += 1;
      else counts.failed += 1;
    } catch {
      counts.failed += 1;
    }
  })();
  pending.add(sending);
  void sending.finally(() => pending.delete(sending));
}

export async function flushOutcomes(): Promise<void> {
  await Promise.all([...pending]);
}
