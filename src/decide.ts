// The decision call to AgentCompile. Never throws: any problem is a null decision, which the
// wrapper treats as forward (fail open).
//
// Bounded: the whole call (connect, send, read the answer) takes at most `timeoutMs`, and the
// server is told how long that is so it answers in time. After a few failures in a row the
// breaker opens: calls go straight to the model, without asking, until it tries again.

export const COMPANY_HEADER = "x-agentcompiler-company";
export const CONVERSATION_HEADER = "x-agentcompiler-conversation";
export const KEY_HEADER = "x-agentcompiler-key";
export const MODE_HEADER = "x-agentcompiler-mode";
export const DEADLINE_HEADER = "x-agentcompiler-deadline-ms";
export const FAILURES_TO_OPEN = 5;
export const OPEN_FOR_MS = 30_000;

export type Provider = "openai" | "anthropic";

export interface Decision {
  action: "tool_call" | "say" | "forward";
  tool?: string;
  args?: Record<string, unknown>;
  callId?: string;
  text?: string;
  reason?: string;
  /** What AgentCompile decided along the way (which job, what it asked, why it handed off). */
  events: Record<string, unknown>[];
}

export interface Settings {
  baseUrl: string;
  key?: string;
  company?: string;
  timeoutMs: number;
  fetch: typeof fetch;
  mode?: "live" | "shadow";
}

/** After `threshold` failures in a row (no answer, or a 5xx or 429), stop asking for `openForMs`;
 * then let one call through to see whether AgentCompile is back. */
export class Breaker {
  private failures = 0;
  private openUntil = 0;
  private trying = false;
  constructor(
    readonly threshold = FAILURES_TO_OPEN,
    readonly openForMs = OPEN_FOR_MS,
    private readonly now: () => number = () => performance.now(),
  ) {}

  allow(): boolean {
    if (this.failures < this.threshold) return true;
    if (this.now() < this.openUntil || this.trying) return false;
    this.trying = true; // the one call that finds out
    return true;
  }

  record(ok: boolean): void {
    this.trying = false;
    if (ok) {
      this.failures = 0;
      return;
    }
    this.failures += 1;
    if (this.failures >= this.threshold) this.openUntil = this.now() + this.openForMs;
  }
}

export function parseDecision(body: unknown): Decision | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const raw = Array.isArray(b.events) ? b.events : [];
  const events = raw.filter(
    (e): e is Record<string, unknown> => !!e && typeof e === "object" && !Array.isArray(e),
  );
  if (b.action === "tool_call" && typeof b.tool === "string" && isObject(b.args)) {
    return { action: "tool_call", tool: b.tool, args: b.args, callId: String(b.call_id ?? ""), events };
  }
  if (b.action === "say" && typeof b.text === "string") {
    return { action: "say", text: b.text, events };
  }
  if (b.action === "forward") {
    return { action: "forward", reason: String(b.reason ?? ""), events };
  }
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function headers(settings: Settings, conversationId?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (conversationId) h[CONVERSATION_HEADER] = conversationId;
  if (settings.company) h[COMPANY_HEADER] = settings.company; // optional: the key names the company
  if (settings.key) h[KEY_HEADER] = settings.key;
  return h;
}

export function endpoint(settings: Settings, path: string): string {
  return `${settings.baseUrl.replace(/\/+$/, "")}${path}`;
}

export async function decide(
  settings: Settings,
  provider: Provider,
  conversationId: string,
  request: Record<string, unknown>,
  breaker?: Breaker,
): Promise<{ decision: Decision | null; ms: number; error?: string }> {
  if (breaker && !breaker.allow()) return { decision: null, ms: 0, error: "circuit open" };
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  const sent = headers(settings, conversationId);
  sent[DEADLINE_HEADER] = String(Math.round(settings.timeoutMs));
  if (settings.mode === "shadow") sent[MODE_HEADER] = "shadow"; // the server keeps no state
  let response: Response;
  try {
    response = await settings.fetch(endpoint(settings, "/v1/decide"), {
      method: "POST",
      headers: sent,
      body: JSON.stringify({ provider, request }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    breaker?.record(false);
    const error = controller.signal.aborted ? "deadline" : errorName(err);
    return { decision: null, ms: performance.now() - started, error };
  }
  breaker?.record(response.status < 500 && response.status !== 429);
  try {
    if (response.status !== 200) {
      return { decision: null, ms: performance.now() - started, error: `HTTP ${response.status}` };
    }
    const decision = parseDecision(await response.json()); // still under the deadline
    const ms = performance.now() - started;
    return { decision, ms, error: decision ? undefined : "malformed decision" };
  } catch (err) {
    const error = controller.signal.aborted ? "deadline" : errorName(err);
    return { decision: null, ms: performance.now() - started, error };
  } finally {
    clearTimeout(timer);
  }
}

export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "Error";
}
