// Capture beyond chat.completions and messages: the Responses API through wrap(), and any
// framework through captureFetch (no client to wrap).

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetCapturers } from "../src/capture.js";
import { ended, events, providerOf } from "../src/fetch.js";
import { assemble } from "../src/assemble.js";
import { captureFetch, conversation, flush, wrap } from "../src/index.js";

type Json = Record<string, any>;

const RESPONSE = {
  id: "resp_1",
  object: "response",
  created_at: 0,
  model: "gpt-x",
  status: "completed",
  output: [
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_order", arguments: '{"order_id":"#W1"}', status: "completed" },
  ],
  parallel_tool_calls: true,
  tool_choice: "auto",
  tools: [],
};
const RESPONSE_EVENTS = [
  { type: "response.created", response: { ...RESPONSE, status: "in_progress", output: [] } },
  { type: "response.output_item.added", output_index: 0, item: RESPONSE.output[0] },
  { type: "response.output_item.done", output_index: 0, item: RESPONSE.output[0] },
  { type: "response.completed", response: RESPONSE },
];
const COMPLETION = {
  id: "c1",
  object: "chat.completion",
  created: 0,
  model: "gpt-x",
  choices: [{ index: 0, message: { role: "assistant", content: "from the model" }, finish_reason: "stop" }],
};
const chunk = (choice: Json) => ({ id: "c1", object: "chat.completion.chunk", created: 0, model: "gpt-x", choices: [choice] });
const CHUNKS = [
  chunk({ index: 0, delta: { role: "assistant", content: "from " } }),
  chunk({ index: 0, delta: { content: "the model" } }),
  chunk({ index: 0, delta: {}, finish_reason: "stop" }),
];
const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-x",
  content: [{ type: "text", text: "from the model" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};
const ANTHROPIC_EVENTS = [
  { type: "message_start", message: { ...MESSAGE, content: [], stop_reason: null } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "from the model" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
];

const sse = (list: Json[], done = false) =>
  list.map((e) => `event: ${e.type ?? "message"}\ndata: ${JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");

/** A body on the wire, in small pieces. */
function wire(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + 7));
      at += 7;
    },
  });
}

class Provider {
  calls: Json[] = [];
  constructor(public status = 200) {}
  fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? "{}"));
    this.calls.push(body);
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: this.status, headers: { "content-type": "application/json" } });
    const stream = (text: string) => new Response(wire(text), { status: 200, headers: { "content-type": "text/event-stream" } });
    if (this.status !== 200) return json({ error: { message: "nope" } });
    if (url.endsWith("/responses")) return body.stream ? stream(sse(RESPONSE_EVENTS)) : json(RESPONSE);
    if (url.endsWith("/messages")) return body.stream ? stream(sse(ANTHROPIC_EVENTS)) : json(MESSAGE);
    if (url.endsWith("/chat/completions")) return body.stream ? stream(sse(CHUNKS, true)) : json(COMPLETION);
    return json({ data: [] });
  };
}

class Service {
  batches: Json[] = [];
  decides = 0;
  fetch: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/v1/capture")) {
      this.batches.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ kept: 1 }), { status: 200 });
    }
    this.decides += 1;
    return new Response(JSON.stringify({ action: "forward", reason: "x" }), { status: 200 });
  };
  get records(): Json[] {
    return this.batches.flatMap((b) => b.exchanges);
  }
}

/** Streams are captured once their copy is read, a tick after the agent's. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let dir = "";
beforeEach(() => {
  process.env.AGENTCOMPILE_SCRUB_KEY = "test-scrub-key";
  dir = mkdtempSync(join(tmpdir(), "ac-"));
});
afterEach(() => resetCapturers());

function wrapped(service: Service, provider: Provider): any {
  const real = new OpenAI({ apiKey: "sk-test", baseURL: "http://provider.test/v1", fetch: provider.fetch });
  return wrap(real, { key: "ack_acme.k", baseUrl: "http://ac.test", trail: join(dir, "trail.jsonl"), fetch: service.fetch, capture: true });
}
const trail = () => readFileSync(join(dir, "trail.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("the Responses API through wrap()", () => {
  it("captures a call in its own shape and never asks about it", async () => {
    const service = new Service();
    const provider = new Provider();
    const client = wrapped(service, provider);
    const resp = await client.responses.create({
      model: "gpt-x",
      input: [{ role: "user", content: "where is order #W1? I'm ann@example.com" }],
      instructions: "You are a support agent.",
      tools: [{ type: "function", name: "get_order", parameters: { type: "object" } }],
      previous_response_id: "resp_0",
      conversationId: "c1",
      customerId: "ann@example.com",
    });
    expect(resp.output[0].name).toBe("get_order");
    expect(provider.calls[0]).not.toHaveProperty("conversationId");
    await flush();
    const [record] = service.records;
    expect(service.decides).toBe(0);
    expect(record.conversation_id).toBe("c1");
    expect(Object.keys(record.request).sort()).toEqual(["input", "instructions", "model", "previous_response_id", "tools"]);
    expect(JSON.stringify(record)).not.toContain("ann@example.com");
    expect(record.end_user).toMatch(/^<email:/);
    expect(record.response.output[0].call_id).toBe("call_1");
    expect(trail()[0]).toMatchObject({ route: "unsupported", reason: "responses api" });
  });

  it("captures a streamed call whole", async () => {
    const service = new Service();
    const client = wrapped(service, new Provider());
    const stream = await client.responses.create({ model: "gpt-x", input: "where is my order?", stream: true, conversationId: "c1" });
    const kinds: string[] = [];
    for await (const event of stream) kinds.push(event.type);
    expect(kinds.at(-1)).toBe("response.completed");
    await flush();
    const [record] = service.records;
    expect(record).toMatchObject({ stream: true, stream_complete: true });
    expect(record.response.id).toBe("resp_1");
    expect(record.request.input).toBe("where is my order?");
  });

  it("keeps the items a stream stopped early finished", () => {
    const built = assemble("openai", RESPONSE_EVENTS.slice(0, 3)) as Json;
    expect(built.id).toBe("resp_1");
    expect(built.output[0].call_id).toBe("call_1");
  });

  it("still decides chat completions on the same client", async () => {
    const service = new Service();
    await wrapped(service, new Provider()).chat.completions.create({ model: "gpt-x", messages: [{ role: "user", content: "hi" }], conversationId: "c1" });
    expect(service.decides).toBe(1);
  });

  it("captures without a conversation, and says so", async () => {
    const service = new Service();
    await wrapped(service, new Provider()).responses.create({ model: "gpt-x", input: "hi" });
    await flush();
    expect(service.records[0].conversation_id).toBeNull();
    expect(trail()[0].route).toBe("no-conversation");
  });
});

describe("any framework through captureFetch", () => {
  const framework = (service: Service, provider: Provider) =>
    new OpenAI({
      apiKey: "sk-test",
      baseURL: "http://provider.test/v1",
      fetch: captureFetch({ key: "ack_acme.k", baseUrl: "http://ac.test", fetch: service.fetch, wrapped: provider.fetch, scrub: false }),
    });

  it("captures a call in the conversation it was made in", async () => {
    const service = new Service();
    const client = framework(service, new Provider());
    const resp = await conversation("t1", () => client.chat.completions.create({ model: "gpt-x", messages: [{ role: "user", content: "hi" }] }), { customer: "cust-7" });
    expect(resp.choices[0].message.content).toBe("from the model");
    await settle();
    await flush();
    const [record] = service.records;
    expect(record).toMatchObject({ conversation_id: "t1", end_user: "cust-7", provider: "openai" });
    expect(record.response.choices[0].message.content).toBe("from the model");
    expect(service.decides).toBe(0);
  });

  it("assembles streams in every shape, marked whole", async () => {
    const service = new Service();
    const client = framework(service, new Provider());
    await conversation("t2", async () => {
      const chat = await client.chat.completions.create({ model: "gpt-x", messages: [{ role: "user", content: "hi" }], stream: true });
      let pieces = 0;
      for await (const _ of chat) pieces += 1;
      expect(pieces).toBe(3);
      const responses = await client.responses.create({ model: "gpt-x", input: "hi", stream: true });
      for await (const _ of responses) {
      }
    });
    await settle();
    await flush();
    const [chat, responses] = service.records;
    expect(chat.response.choices[0].message.content).toBe("from the model");
    expect(chat.stream_complete).toBe(true);
    expect(responses.response.id).toBe("resp_1");
  });

  it("captures Anthropic calls", async () => {
    const service = new Service();
    const client = new Anthropic({
      apiKey: "sk-test",
      baseURL: "http://provider.test",
      fetch: captureFetch({ key: "ack_acme.k", baseUrl: "http://ac.test", fetch: service.fetch, wrapped: new Provider().fetch, scrub: false }),
    });
    await conversation("t4", async () => {
      await client.messages.create({ model: "claude-x", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
      const stream = client.messages.stream({ model: "claude-x", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
      expect(await stream.finalText()).toBe("from the model");
    });
    await settle();
    await flush();
    const [whole, streamed] = service.records;
    expect(whole.provider).toBe("anthropic");
    expect(streamed.response.content[0].text).toBe("from the model");
    expect(streamed.stream_complete).toBe(true);
  });

  it("leaves other calls and failures alone", async () => {
    const service = new Service();
    await framework(service, new Provider()).models.list();
    await expect(
      framework(service, new Provider(400)).chat.completions.create({ model: "gpt-x", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow();
    await settle();
    await flush();
    expect(service.records).toEqual([]);
  });

  it("reads a Request object's body", async () => {
    const service = new Service();
    const provider = new Provider();
    const capture = captureFetch({ key: "ack_acme.k", baseUrl: "http://ac.test", fetch: service.fetch, wrapped: async (input) => provider.fetch("http://provider.test/v1/chat/completions", { body: await (input as Request).text() }), scrub: false });
    await conversation("t8", () =>
      capture(new Request("http://provider.test/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-x", messages: [] }) })),
    );
    await settle();
    await flush();
    expect(service.records[0].conversation_id).toBe("t8");
  });
});

describe("the pieces", () => {
  it.each([
    ["POST", "http://x/v1/chat/completions", "openai"],
    ["POST", "http://x/v1beta/openai/chat/completions", "openai"],
    ["POST", "http://x/v1/responses", "openai"],
    ["POST", "http://x/v1/messages", "anthropic"],
    ["POST", "http://x/v1/messages/count_tokens", null],
    ["POST", "http://x/v1/threads/t1/messages", null],
    ["GET", "http://x/v1/responses", null],
    ["POST", "not a url", null],
  ])("%s %s is %s", (method, url, expected) => {
    expect(providerOf(method, url)).toBe(expected);
  });

  it("reads server-sent events and their end markers", () => {
    const text = 'event: a\ndata: {"x": 1}\n\n: comment\n\ndata: [DONE]\n\ndata: not json\n\ndata: {"y":\ndata: 2}\n\n';
    expect(events(text)).toEqual([{ x: 1 }, { y: 2 }]);
    expect(ended(text, [])).toBe(true);
    expect(ended("", [{ type: "message_stop" }])).toBe(true);
    expect(ended("", [{ choices: [{ finish_reason: "stop" }] }])).toBe(true);
    expect(ended("", [{ choices: [{ delta: {} }] }])).toBe(false);
  });
});
