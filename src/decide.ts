// The decision call to AgentCompile. Never throws: any problem is a null decision, which the
// wrapper treats as forward (fail open).

export const COMPANY_HEADER = "x-agentcompiler-company";
export const CONVERSATION_HEADER = "x-agentcompiler-conversation";
export const KEY_HEADER = "x-agentcompiler-key";

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
): Promise<{ decision: Decision | null; ms: number; error?: string }> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const response = await settings.fetch(endpoint(settings, "/v1/decide"), {
      method: "POST",
      headers: headers(settings, conversationId),
      body: JSON.stringify({ provider, request }),
      signal: controller.signal,
    });
    const ms = performance.now() - started;
    if (response.status !== 200) return { decision: null, ms, error: `HTTP ${response.status}` };
    const decision = parseDecision(await response.json());
    return { decision, ms, error: decision ? undefined : "malformed decision" };
  } catch (err) {
    return { decision: null, ms: performance.now() - started, error: errorName(err) };
  } finally {
    clearTimeout(timer);
  }
}

export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "Error";
}
