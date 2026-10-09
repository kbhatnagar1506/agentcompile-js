// The SDK side of the SDK <-> server contract: test/contract/ is vendored from the server repo
// (kbhatnagar1506/agent-compiler, tests/contract/; scripts/sync-contract.sh). Every golden
// request is one this SDK sends, and every golden response is one it parses.
//
// With AGENTCOMPILE_CONTRACT_URL set (CI starts the server's contract server: the real endpoint,
// fake models), the same requests go to it and a wrapped openai client runs a whole job end to
// end: wrap -> decide -> tool call -> answer.

import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { decide, parseDecision } from "../src/decide.js";
import { flush, outcome, wrap } from "../src/index.js";
import { payload } from "../src/payload.js";

type Json = any;
const HERE = join(__dirname, "contract");
const SCHEMAS: Record<string, Json> = JSON.parse(readFileSync(join(HERE, "schemas.json"), "utf8")).schemas;
const GOLDENS: Record<string, Json> = Object.fromEntries(
  readdirSync(join(HERE, "golden"))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(join(HERE, "golden", f), "utf8"))]),
);
const LIVE = process.env.AGENTCOMPILE_CONTRACT_URL;
const KEY = "ack_acme.contract-test"; // the contract server's test key; not a secret

// Requests a golden holds that this SDK does not send as recorded, and why. Each is expected to
// fail: when the SDK starts sending it, the test fails until this entry goes.
const KNOWN_GAPS: Record<string, string> = {
  decide_end_user:
    "the SDK never sends the end user (OpenAI `user`, Anthropic metadata.user_id, or " +
    "x-agentcompiler-end-user) to /v1/decide: recipes keyed on the session's user hand off",
};

/** Why `value` doesn't match `schema` (schemas.json's subset of JSON Schema). */
export function problems(value: unknown, schema: Json, where = "$"): string[] {
  if (schema.$ref) return problems(value, SCHEMAS[schema.$ref], where);
  const is: Record<string, (v: unknown) => boolean> = {
    object: (v) => !!v && typeof v === "object" && !Array.isArray(v),
    array: Array.isArray,
    string: (v) => typeof v === "string",
    boolean: (v) => typeof v === "boolean",
    integer: (v) => Number.isInteger(v),
    number: (v) => typeof v === "number",
  };
  if (schema.type && !is[schema.type](value)) return [`${where}: expected ${schema.type}`];
  const found: string[] = [];
  if ("const" in schema && value !== schema.const) found.push(`${where}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) found.push(`${where}: not one of ${schema.enum}`);
  if (schema.minLength && typeof value === "string" && value.length < schema.minLength) {
    found.push(`${where}: shorter than ${schema.minLength}`);
  }
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    found.push(`${where}: below ${schema.minimum}`);
  }
  if (is.object(value)) {
    const v = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) if (!(name in v)) found.push(`${where}: missing ${name}`);
    for (const [name, item] of Object.entries(v)) {
      if (name in properties) found.push(...problems(item, properties[name], `${where}.${name}`));
      else if (schema.additionalProperties === false) found.push(`${where}: unexpected field ${name}`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => found.push(...problems(item, schema.items, `${where}[${i}]`)));
  }
  return found;
}

/** A decision request of the kind this SDK sends: a provider it speaks, its key, a conversation
 * id and its deadline (the others are what a proxy or a bug might send). */
function sdkShaped(golden: Json): boolean {
  const { path, headers, body } = golden.request;
  return (
    path === "/v1/decide" &&
    !!body &&
    ["openai", "anthropic"].includes(body.provider) &&
    "x-agentcompiler-key" in headers &&
    "x-agentcompiler-conversation" in headers &&
    "x-agentcompiler-deadline-ms" in headers
  );
}

const SENT = Object.keys(GOLDENS).filter((n) => sdkShaped(GOLDENS[n]));
const DECISIONS = Object.keys(GOLDENS).filter((n) => GOLDENS[n].request.path === "/v1/decide");
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fromModel = async (input: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  return json({
    id: "chatcmpl-model", object: "chat.completion", created: 1, model: body.model,
    choices: [{ index: 0, message: { role: "assistant", content: "from the model" }, finish_reason: "stop" }],
  });
};

describe("the vendored contract", () => {
  it("covers every route this SDK calls and every decision", () => {
    const paths = new Set(Object.values(GOLDENS).map((g) => g.request.path));
    for (const p of ["/v1/decide", "/v1/capture", "/v1/outcome"]) expect(paths.has(p)).toBe(true);
    const schemas = new Set(Object.values(GOLDENS).map((g) => g.response.schema));
    for (const s of ["decision.tool_call", "decision.say", "decision.forward"]) expect(schemas.has(s)).toBe(true);
  });
});

describe("the SDK sends each golden decision request", () => {
  for (const name of SENT) {
    const check = async () => {
      const { path, headers, body } = GOLDENS[name].request;
      let sent: { url: string; init: RequestInit } | undefined;
      const fetchSpy = async (url: unknown, init?: RequestInit) => {
        sent = { url: String(url), init: init! };
        return json({ action: "forward", reason: "x" });
      };
      await decide(
        {
          baseUrl: "http://ac.test",
          key: headers["x-agentcompiler-key"],
          timeoutMs: Number(headers["x-agentcompiler-deadline-ms"]),
          fetch: fetchSpy as typeof fetch,
          mode: headers["x-agentcompiler-mode"] ?? "live",
        },
        body.provider,
        headers["x-agentcompiler-conversation"],
        payload(body.request),
      );
      expect(sent!.url).toBe(`http://ac.test${path}`);
      const { "content-type": contentType, ...rest } = sent!.init.headers as Record<string, string>;
      expect(contentType).toBe("application/json");
      expect(rest).toEqual(headers);
      expect(JSON.parse(String(sent!.init.body))).toEqual(body);
    };
    if (name in KNOWN_GAPS) it.fails(`${name} (known gap: ${KNOWN_GAPS[name]})`, check);
    else it(name, check);
  }
});

describe("the SDK parses each golden decision response", () => {
  for (const name of DECISIONS) {
    it(name, () => {
      const { status, schema, example } = GOLDENS[name].response;
      expect(problems(example, SCHEMAS[schema])).toEqual([]);
      if (status !== 200) return; // a non-200 is never parsed: the SDK fails open on the status
      const decision = parseDecision(example)!;
      expect(decision.action).toBe(example.action);
      expect(decision.events).toEqual(example.events ?? []);
      if (decision.action === "tool_call") {
        expect([decision.tool, decision.args, decision.callId]).toEqual([example.tool, example.args, example.call_id]);
      } else if (decision.action === "say") {
        expect(decision.text).toBe(example.text);
      } else {
        expect(decision.reason).toBe(example.reason);
      }
    });
  }
});

describe("a wrapped client answers each golden decision", () => {
  for (const name of DECISIONS.filter((n) => GOLDENS[n].request.body?.provider === "openai")) {
    it(name, async () => {
      const { status, example } = GOLDENS[name].response;
      const client = wrap(new OpenAI({ apiKey: "sk-test", baseURL: "http://provider.test/v1", fetch: fromModel }), {
        key: KEY,
        baseUrl: "http://ac.test",
        trail: false,
        fetch: (async () => json(example, status)) as typeof fetch,
      });
      const sent = GOLDENS[name].request.body.request;
      const answer: Json = await client.chat.completions.create({ ...sent, conversation_id: "c1" } as Json);
      const message = answer.choices[0].message;
      if (status === 200 && example.action === "tool_call") {
        expect(message.tool_calls[0].function.name).toBe(example.tool);
        expect(JSON.parse(message.tool_calls[0].function.arguments)).toEqual(example.args);
      } else if (status === 200 && example.action === "say") {
        expect(message.content).toBe(example.text);
      } else {
        expect(message.content).toBe("from the model");
      }
    });
  }
});

describe("capture and outcome requests", () => {
  it("have the golden shape", async () => {
    const seen: Record<string, { headers: Record<string, string>; body: Json }> = {};
    const service = (async (url: unknown, init?: RequestInit) => {
      seen[new URL(String(url)).pathname] = {
        headers: init!.headers as Record<string, string>,
        body: JSON.parse(String(init!.body)),
      };
      return json({ kept: 1, dropped: 0 });
    }) as typeof fetch;
    const client = wrap(new OpenAI({ apiKey: "sk-test", baseURL: "http://provider.test/v1", fetch: fromModel }), {
      key: KEY, baseUrl: "http://ac.test", trail: false, capture: true, scrub: false, fetch: service,
    });
    await client.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
    outcome("golden-capture-1", "resolved", "refunded");
    await flush();

    const capture = GOLDENS.capture_batch.request;
    const sentCapture = seen["/v1/capture"];
    for (const [k, v] of Object.entries(capture.headers)) expect(sentCapture.headers[k]).toBe(v);
    for (const k of Object.keys(capture.body.exchanges[0])) expect(sentCapture.body.exchanges[0]).toHaveProperty(k);

    const golden = GOLDENS.outcome.request;
    const sentOutcome = seen["/v1/outcome"];
    for (const [k, v] of Object.entries(golden.headers)) expect(sentOutcome.headers[k]).toBe(v);
    const record = sentOutcome.body.outcomes[0];
    expect(Object.keys(record).sort()).toEqual(Object.keys(golden.body.outcomes[0]).sort());
    expect([record.conversation_id, record.outcome, record.note]).toEqual(["golden-capture-1", "resolved", "refunded"]);
  });
});

// --- against the real server (CI: the server's contract server) ----------------------------

const ORDERS: Record<string, Json> = {
  "#W1": { order_id: "#W1", status: "pending", items: [{ name: "Desk Lamp" }] },
  "#W2": { order_id: "#W2", status: "delivered", items: [{ name: "Kettle" }] },
};

/** The agent's own tools (the contract server's backend: one user, two orders). */
function runTool(name: string, args: Json): string {
  const user = "jo_park_1234";
  if (name.startsWith("find_user_id")) return user;
  if (name === "get_user_details") return JSON.stringify({ user_id: user, orders: Object.keys(ORDERS), payment_methods: {} });
  if (name === "get_order_details") return JSON.stringify({ ...ORDERS[args.order_id], user_id: user, payment_history: [] });
  if (name === "cancel_pending_order") return JSON.stringify({ ...ORDERS[args.order_id], status: "cancelled" });
  return "Error: unknown tool";
}

describe.skipIf(!LIVE)("against the server", () => {
  for (const name of Object.keys(GOLDENS)) {
    it(`answers ${name} as recorded`, async () => {
      const { request, response: expected } = GOLDENS[name];
      const headers: Record<string, string> = { ...request.headers };
      if (headers["x-agentcompiler-conversation"]) headers["x-agentcompiler-conversation"] += `-${name}-js-${process.pid}`;
      let response: Response;
      if (request.method === "GET") {
        response = await fetch(`${LIVE}${request.path}`, { headers });
      } else {
        headers["content-type"] = "application/json";
        const body = "raw_body" in request ? request.raw_body : JSON.stringify(request.body);
        response = await fetch(`${LIVE}${request.path}`, { method: "POST", headers, body });
      }
      expect(response.status).toBe(expected.status);
      const body = await response.json();
      expect(problems(body, SCHEMAS[expected.schema])).toEqual([]);
      for (const [k, v] of Object.entries(expected.expect)) expect(body[k]).toEqual(v);
      if (request.path === "/v1/decide" && response.status === 200) expect(parseDecision(body)).not.toBeNull();
    });
  }

  it("runs a whole job end to end: wrap -> decide -> tool call -> answer", async () => {
    let modelCalls = 0;
    const model = (async (input: unknown, init?: RequestInit) => {
      modelCalls += 1;
      return fromModel(input, init);
    }) as typeof fetch;
    const events: Json[] = [];
    const client = wrap(new OpenAI({ apiKey: "sk-test", baseURL: "http://provider.test/v1", fetch: model }), {
      key: KEY, baseUrl: LIVE, trail: join(mkdtempSync(join(tmpdir(), "ac-")), "t.jsonl"), onEvent: (e) => events.push(e),
    });
    const tools = ["find_user_id_by_email", "find_user_id_by_name_zip", "get_user_details", "get_order_details", "cancel_pending_order"]
      .map((name) => ({ type: "function" as const, function: { name, parameters: { type: "object" } } }));
    const messages: Json[] = [
      { role: "system", content: "You are acme's retail support agent." },
      { role: "user", content: "Please cancel my order with the desk lamp." },
    ];
    const conversationId = `e2e-js-${process.pid}`;
    const said: string[] = [];
    const ran: string[] = [];
    for (const reply of ["sure, it's jo@example.com", "I don't need it anymore", "yes", null]) {
      for (let i = 0; i < 12; i++) {
        const answer: Json = await client.chat.completions.create({
          model: "gpt-4o-mini", messages, tools, conversation_id: conversationId,
        } as Json);
        const message = answer.choices[0].message;
        messages.push(message);
        if (!message.tool_calls?.length) {
          said.push(message.content);
          break;
        }
        for (const call of message.tool_calls) {
          ran.push(call.function.name);
          messages.push({ role: "tool", tool_call_id: call.id, content: runTool(call.function.name, JSON.parse(call.function.arguments)) });
        }
      }
      if (reply) messages.push({ role: "user", content: reply });
    }
    expect(new Set(events.map((e) => e.route))).toEqual(new Set(["compiled"]));
    expect(modelCalls).toBe(0);
    expect(said[0]).toBe("To find your account, could you tell me your email?");
    expect(ran[0]).toBe("find_user_id_by_email");
    expect(ran.at(-1)).toBe("cancel_pending_order");
    expect(said.at(-1)).toMatch(/^Done: cancel pending order completed/);
  });
});
