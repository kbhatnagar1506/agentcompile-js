// Turning create() arguments into the JSON the decision call sends.

// What the engine reads; everything else stays between the customer and their provider.
const FIELDS = ["model", "messages", "system", "tools"] as const;
// A Responses API call (OpenAI's `responses.create`): the same, in that API's own words.
const RESPONSES_FIELDS = ["model", "input", "instructions", "tools", "previous_response_id", "conversation"] as const;

export function jsonable(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(jsonable);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined && typeof v !== "function") out[k] = jsonable(v);
    }
    return out;
  }
  return String(value);
}

export function payload(params: Record<string, unknown>): Record<string, unknown> {
  return pick(params, FIELDS);
}

/** What capture keeps of a call: `payload`, or a Responses API call's own fields. */
export function requestOf(params: Record<string, unknown>): Record<string, unknown> {
  return "input" in params && !("messages" in params) ? pick(params, RESPONSES_FIELDS) : payload(params);
}

function pick(params: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (params[field] !== undefined && params[field] !== null) out[field] = jsonable(params[field]);
  }
  return out;
}
