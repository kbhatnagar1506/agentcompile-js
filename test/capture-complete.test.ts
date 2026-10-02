// Capture, completed: streamed answers captured whole, the customer id, and outcomes.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { assemble } from "../src/assemble.js";
import { conversation, flush, outcome, wrap } from "../src/index.js";

const MESSAGES = [{ role: "user" as const, content: "cancel order #W1" }];

const sse = (events: [string | null, unknown][]) =>
  events
    .map(([name, data]) => `${name ? `event: ${name}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`)
    .join("");

const chunk = (delta: object, finish: string | null = null) => ({
  id: "s1",
  object: "chat.completion.chunk",
  created: 1,
  model: "m",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const OPENAI_STREAM = sse([
  [null, chunk({ role: "assistant", content: "Let me " })],
  [null, chunk({ content: "check." })],
  [null, chunk({ tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "get_order", arguments: '{"id":' } }] })],
  [null, chunk({ tool_calls: [{ index: 0, function: { arguments: '"#W1"}' } }] })],
  [null, chunk({}, "tool_calls")],
  [null, "[DONE]"],
]);

const ANTHROPIC_STREAM = sse([
  ["message_start", { type: "message_start", message: { id: "msg1", type: "message", role: "assistant", model: "claude", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "On it." } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "get_order", input: {} } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"id": "#W1"}' } }],
  ["content_block_stop", { type: "content_block_stop", index: 1 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 9 } }],
  ["message_stop", { type: "message_stop" }],
]);

class Service {
  captured: any[] = [];
  outcomes: any[] = [];
  constructor(private readonly decision: object = { action: "forward", reason: "x" }) {}
  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.endsWith("/v1/capture")) this.captured.push(...body.exchanges);
    else if (url.endsWith("/v1/outcome")) this.outcomes.push(...body.outcomes);
    else return new Response(JSON.stringify(this.decision), { status: 200 });
    return new Response("{}", { status: 200 });
  };
}

const streaming = (body: string): typeof fetch => async () =>
  new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

function openai(service: Service) {
  process.env.AGENTCOMPILE_SCRUB_KEY = "k";
  return wrap(new OpenAI({ apiKey: "sk", baseURL: "http://p.test/v1", fetch: streaming(OPENAI_STREAM) }), {
    baseUrl: "http://ac.test",
    trail: false,
    capture: true,
    fetch: service.fetch,
  });
}

afterEach(async () => {
  await flush();
});

describe("streamed answers", () => {
  it("are captured whole while the agent reads the stream as always", async () => {
    const service = new Service();
    const stream: any = await openai(service).chat.completions.create({ model: "m", messages: MESSAGES, stream: true, conversationId: "c1" } as any);
    const seen: unknown[] = [];
    for await (const c of stream) seen.push(c);
    expect(seen).toHaveLength(5);
    await flush();
    const [record] = service.captured;
    const message = record.response.choices[0].message;
    expect(message.content).toBe("Let me check.");
    expect(message.tool_calls[0].function).toEqual({ name: "get_order", arguments: '{"id":"#W1"}' });
    expect(record.response.choices[0].finish_reason).toBe("tool_calls");
    expect(record.stream).toBe(true);
    expect(record.stream_complete).toBe(true);
  });

  it("are marked incomplete when the agent stops reading", async () => {
    const service = new Service();
    const stream: any = await openai(service).chat.completions.create({ model: "m", messages: MESSAGES, stream: true, conversationId: "c1" } as any);
    for await (const _ of stream) break;
    await flush();
    expect(service.captured[0].stream_complete).toBe(false);
  });

  it("from Anthropic are captured whole", async () => {
    const service = new Service();
    const client = wrap(new Anthropic({ apiKey: "sk", baseURL: "http://p.test", fetch: streaming(ANTHROPIC_STREAM) }), {
      baseUrl: "http://ac.test",
      trail: false,
      capture: true,
      fetch: service.fetch,
    });
    const stream: any = await client.messages.create({ model: "claude", max_tokens: 50, messages: MESSAGES, stream: true, conversationId: "c1" } as any);
    const kinds: string[] = [];
    for await (const e of stream) kinds.push(e.type);
    expect(kinds.at(0)).toBe("message_start");
    expect(kinds.at(-1)).toBe("message_stop");
    await flush();
    const response = service.captured[0].response;
    expect(response.content[0]).toEqual({ type: "text", text: "On it." });
    expect(response.content[1].input).toEqual({ id: "#W1" });
    expect(response.stop_reason).toBe("tool_use");
    expect(response.usage.output_tokens).toBe(9);
  });

  it("answered compiled are captured whole too", async () => {
    const service = new Service({ action: "say", text: "Done." });
    const stream: any = await openai(service).chat.completions.create({ model: "m", messages: MESSAGES, stream: true, conversationId: "c1" } as any);
    for await (const _ of stream) {
      // read it all
    }
    await flush();
    expect(service.captured[0].response.choices[0].message.content).toBe("Done.");
  });

  it("keep the rest of the real stream", async () => {
    const stream: any = await openai(new Service()).chat.completions.create({ model: "m", messages: MESSAGES, stream: true, conversationId: "c1" } as any);
    expect(stream.controller).toBeInstanceOf(AbortController);
  });
});

describe("customers", () => {
  it("are captured, scrubbed, from conversation() or the call", async () => {
    const service = new Service();
    const client = openai(service);
    await conversation(
      "c1",
      async () => {
        const s: any = await client.chat.completions.create({ model: "m", messages: MESSAGES, stream: true } as any);
        for await (const _ of s);
      },
      { customer: "mia@example.com" },
    );
    const s: any = await client.chat.completions.create({ model: "m", messages: MESSAGES, stream: true, conversationId: "c2", customerId: "cust_42" } as any);
    for await (const _ of s);
    await flush();
    const [first, second] = service.captured;
    expect(first.end_user.startsWith("<email:")).toBe(true);
    expect(JSON.stringify(first)).not.toContain("mia");
    expect(second.end_user).toBe("cust_42");
  });
});

describe("outcomes", () => {
  it("are reported in the background", async () => {
    const service = new Service();
    openai(service);
    outcome("c1", "escalated", "wanted a human");
    await flush();
    expect(service.outcomes).toHaveLength(1);
    expect(service.outcomes[0]).toMatchObject({ conversation_id: "c1", outcome: "escalated", note: "wanted a human" });
  });

  it("refuse an unknown label", () => {
    expect(() => outcome("c1", "fine" as any)).toThrow();
  });
});

it("assembly never breaks the agent", () => {
  expect(assemble("openai", [{ choices: "nonsense" }])).toBeNull();
  expect(assemble("anthropic", [{ type: "content_block_delta" }])).toBeNull();
});
