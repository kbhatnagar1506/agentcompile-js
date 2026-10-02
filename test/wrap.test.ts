// wrap() against a fake AgentCompile and a fake provider (custom fetch): no network, the
// official openai and @anthropic-ai/sdk clients end to end.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { conversation, flush, wrap } from "../src/index.js";

const MESSAGES = [{ role: "user" as const, content: "cancel order #W1" }];
const CALL = { action: "tool_call", tool: "get_order_details", args: { order_id: "#W1" }, call_id: "call_1" };
const SAY = { action: "say", text: "Order #W1 is cancelled." };
const FORWARD = { action: "forward", reason: "no job matched" };
const TOOLS = [{ type: "function", function: { name: "get_order_details", parameters: { type: "object" } } }];
const ANTHROPIC_TOOLS = [{ name: "get_order_details", input_schema: { type: "object" } }];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

class Fake {
  decideRequests: { headers: Headers; body: any }[] = [];
  captureBatches: any[] = [];
  providerRequests: any[] = [];
  constructor(
    public decision: unknown = FORWARD,
    public decideStatus = 200,
    public decideThrows = false,
  ) {}
  agentcompile: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.endsWith("/v1/capture")) {
      this.captureBatches.push(body);
      return json({ kept: body.exchanges.length });
    }
    this.decideRequests.push({ headers: new Headers(init?.headers), body });
    if (this.decideThrows) throw new TypeError("fetch failed");
    return json(this.decision, this.decideStatus);
  };
  provider: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    this.providerRequests.push(body);
    if (String(input).endsWith("/messages")) {
      return json({
        id: "msg_real", type: "message", role: "assistant", model: body.model,
        content: [{ type: "text", text: "from the model" }], stop_reason: "end_turn",
        stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    return json({
      id: "c1", object: "chat.completion", created: 0, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "from the model" }, finish_reason: "stop" }],
    });
  };
}

let dir = "";
const trailPath = () => join(dir, "trail.jsonl");
const trail = () => readFileSync(trailPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));

function openai(fake: Fake, extra: Record<string, unknown> = {}) {
  dir = mkdtempSync(join(tmpdir(), "ac-"));
  const real = new OpenAI({ apiKey: "sk-test", baseURL: "http://provider.test/v1", fetch: fake.provider });
  return wrap(real, { key: "ack_acme.k", baseUrl: "http://ac.test", trail: trailPath(), fetch: fake.agentcompile, ...extra });
}

function anthropic(fake: Fake) {
  dir = mkdtempSync(join(tmpdir(), "ac-"));
  const real = new Anthropic({ apiKey: "sk-test", baseURL: "http://provider.test", fetch: fake.provider });
  return wrap(real, { key: "ack_acme.k", baseUrl: "http://ac.test", trail: trailPath(), fetch: fake.agentcompile });
}

afterEach(async () => {
  await flush();
});

describe("openai", () => {
  it("answers a compiled tool call without calling the model", async () => {
    const fake = new Fake(CALL);
    const client = openai(fake);
    const resp: any = await client.chat.completions.create({ model: "gpt-x", messages: MESSAGES, tools: TOOLS, conversation_id: "c1" } as any);
    const call = resp.choices[0].message.tool_calls[0];
    expect(resp.choices[0].finish_reason).toBe("tool_calls");
    expect(call.function.name).toBe("get_order_details");
    expect(JSON.parse(call.function.arguments)).toEqual({ order_id: "#W1" });
    expect(fake.providerRequests).toEqual([]);
    const sent = fake.decideRequests[0];
    expect(sent.headers.get("x-agentcompiler-key")).toBe("ack_acme.k");
    expect(sent.headers.get("x-agentcompiler-conversation")).toBe("c1");
    expect(sent.headers.get("x-agentcompiler-company")).toBeNull();
    expect(sent.body).toEqual({ provider: "openai", request: { model: "gpt-x", messages: MESSAGES, tools: TOOLS } });
    expect(trail()[0].route).toBe("compiled");
  });

  it("answers a compiled message", async () => {
    const resp: any = await openai(new Fake(SAY)).chat.completions.create({ model: "m", messages: MESSAGES, conversationId: "c1" } as any);
    expect(resp.choices[0].message.content).toBe("Order #W1 is cancelled.");
    expect(resp.choices[0].finish_reason).toBe("stop");
  });

  it("forwards to the model with our keyword removed, and keeps the events", async () => {
    const events = [{ decision: "forward", reason: "question" }];
    const fake = new Fake({ ...FORWARD, events });
    const resp: any = await openai(fake).chat.completions.create({ model: "m", messages: MESSAGES, conversation_id: "c1" } as any);
    expect(resp.choices[0].message.content).toBe("from the model");
    expect(fake.providerRequests[0].conversation_id).toBeUndefined();
    const event = trail()[0];
    expect(event.route).toBe("forwarded");
    expect(event.reason).toBe("no job matched");
    expect(event.events).toEqual(events);
  });

  it.each([
    ["a server error", new Fake(FORWARD, 500)],
    ["a network error", new Fake(FORWARD, 200, true)],
    ["nonsense", new Fake({ action: "nonsense" })],
  ])("fails open to the model on %s", async (_name, fake) => {
    const resp: any = await openai(fake).chat.completions.create({ model: "m", messages: MESSAGES, conversation_id: "c1" } as any);
    expect(resp.choices[0].message.content).toBe("from the model");
    expect(trail()[0].route).toBe("fail-open");
  });

  it("fails open when the decision is too slow", async () => {
    const fake = new Fake(SAY);
    const slow: typeof fetch = (input, init) =>
      new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        setTimeout(() => resolve(json(SAY)), 1000);
      });
    const client = wrap(new OpenAI({ apiKey: "k", baseURL: "http://provider.test/v1", fetch: fake.provider }), {
      baseUrl: "http://ac.test", trail: false, fetch: slow, timeoutMs: 20,
    });
    const resp: any = await client.chat.completions.create({ model: "m", messages: MESSAGES, conversation_id: "c1" } as any);
    expect(resp.choices[0].message.content).toBe("from the model");
  });

  it("skips the decision with no conversation id", async () => {
    const fake = new Fake(SAY);
    const resp: any = await openai(fake).chat.completions.create({ model: "m", messages: MESSAGES });
    expect(resp.choices[0].message.content).toBe("from the model");
    expect(fake.decideRequests).toEqual([]);
    expect(trail()[0].route).toBe("no-conversation");
  });

  it("takes the id from conversation()", async () => {
    const fake = new Fake(FORWARD);
    const client = openai(fake);
    await conversation("ticket-9", () => client.chat.completions.create({ model: "m", messages: MESSAGES }));
    expect(fake.decideRequests[0].headers.get("x-agentcompiler-conversation")).toBe("ticket-9");
  });

  it("shadow mode always calls the model and records what it would have done", async () => {
    const fake = new Fake(CALL);
    const resp: any = await openai(fake, { mode: "shadow" }).chat.completions.create({ model: "m", messages: MESSAGES, conversation_id: "c1" } as any);
    expect(resp.choices[0].message.content).toBe("from the model");
    expect(trail()[0]).toMatchObject({ route: "shadow", action: "tool_call", tool: "get_order_details" });
  });

  it("streams a compiled tool call", async () => {
    const stream: any = await openai(new Fake(CALL)).chat.completions.create({ model: "m", messages: MESSAGES, tools: TOOLS, stream: true, conversation_id: "c1" } as any);
    const chunks: any[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks[0].choices[0].delta.tool_calls[0].function.name).toBe("get_order_details");
    expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });

  it("leaves everything else on the client alone", () => {
    const client = openai(new Fake());
    expect(client.baseURL).toBe("http://provider.test/v1");
    expect(typeof client.embeddings.create).toBe("function");
  });

  it("rejects a client it can't wrap", () => {
    expect(() => wrap({} as object)).toThrow(TypeError);
  });

  it("captures each call in the importer's exchange shape when asked", async () => {
    const fake = new Fake(FORWARD);
    const client = openai(fake, { capture: true });
    for (let i = 0; i < 3; i++) {
      await client.chat.completions.create({ model: "m", messages: MESSAGES, conversation_id: "c1" } as any);
    }
    await flush();
    const sent = fake.captureBatches.flatMap((b) => b.exchanges);
    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({ provider: "openai", conversation_id: "c1", request: { model: "m", messages: MESSAGES } });
    expect(sent[0].response.choices[0].message.content).toBe("from the model");
    expect(sent[0].request.conversation_id).toBeUndefined();
  });

  it("captures nothing unless asked", async () => {
    const fake = new Fake(FORWARD);
    await openai(fake).chat.completions.create({ model: "m", messages: MESSAGES, conversation_id: "c1" } as any);
    await flush();
    expect(fake.captureBatches).toEqual([]);
  });
});

describe("anthropic", () => {
  it("answers a compiled message shaped like messages.create()", async () => {
    const resp: any = await anthropic(new Fake(SAY)).messages.create({ model: "claude", max_tokens: 100, messages: MESSAGES, conversation_id: "c1" } as any);
    expect(resp.type).toBe("message");
    expect(resp.content[0]).toEqual({ type: "text", text: "Order #W1 is cancelled." });
    expect(resp.stop_reason).toBe("end_turn");
  });

  it("streams a compiled tool use", async () => {
    const stream: any = await anthropic(new Fake(CALL)).messages.create({ model: "claude", max_tokens: 100, messages: MESSAGES, tools: ANTHROPIC_TOOLS, stream: true, conversation_id: "c1" } as any);
    const types: string[] = [];
    let partial = "";
    for await (const event of stream) {
      types.push(event.type);
      if (event.type === "content_block_delta") partial = event.delta.partial_json;
    }
    expect(types).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(JSON.parse(partial)).toEqual({ order_id: "#W1" });
  });

  it("forwards to the model", async () => {
    const fake = new Fake(FORWARD);
    const resp: any = await anthropic(fake).messages.create({ model: "claude", max_tokens: 100, messages: MESSAGES, conversation_id: "c1" } as any);
    expect(resp.content[0].text).toBe("from the model");
    expect(fake.decideRequests[0].body.provider).toBe("anthropic");
  });
});
