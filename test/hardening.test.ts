// What keeps the wrapper safe in production: a decision is bounded in time and tells the server
// how long it waits, a sick service is skipped, a request a compiled answer couldn't honour goes
// to the model, create() returns what the SDKs return, and nothing grows without bound.

import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { Capturer, capturerFor, limits, resetCapturers } from "../src/capture.js";
import { Breaker, type Settings } from "../src/decide.js";
import { wrap } from "../src/index.js";
import { Trail } from "../src/trail.js";

const MESSAGES = [{ role: "user" as const, content: "cancel order #W1" }];
const CALL = { action: "tool_call", tool: "get_order_details", args: { order_id: "#W1" }, call_id: "call_1" };
const SAY = { action: "say", text: "Order #W1 is cancelled." };
const TOOLS = [{ type: "function", function: { name: "get_order_details", parameters: { type: "object" } } }];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

class Service {
  decides: { headers: Headers }[] = [];
  captures: any[] = [];
  providerCalls: any[] = [];
  constructor(
    public decision: unknown = CALL,
    public status = 200,
    public slowMs = 0,
  ) {}
  agentcompile: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/v1/capture")) {
      this.captures.push(JSON.parse(String(init?.body)));
      return json({ kept: 1 });
    }
    this.decides.push({ headers: new Headers(init?.headers) });
    if (this.slowMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.slowMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    return json(this.decision, this.status);
  };
  provider: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    this.providerCalls.push(body);
    if (String(input).endsWith("/messages")) {
      return json({
        id: "msg_real", type: "message", role: "assistant", model: body.model,
        content: [{ type: "text", text: "from the model" }], stop_reason: "end_turn",
        stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    return new Response(
      JSON.stringify({
        id: "c1", object: "chat.completion", created: 0, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "from the model" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_1" } },
    );
  };
}

let dir = "";
const trailPath = () => join(dir, "trail.jsonl");
const trail = () => readFileSync(trailPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));

function openai(service: Service, extra: Record<string, unknown> = {}): any {
  dir = mkdtempSync(join(tmpdir(), "ac-"));
  const real = new OpenAI({ apiKey: "sk-test", baseURL: "http://provider.test/v1", fetch: service.provider });
  return wrap(real, { key: "ack_acme.k", baseUrl: "http://ac.test", trail: trailPath(), fetch: service.agentcompile, ...extra });
}

function anthropic(service: Service): any {
  dir = mkdtempSync(join(tmpdir(), "ac-"));
  const real = new Anthropic({ apiKey: "sk-test", baseURL: "http://provider.test", fetch: service.provider });
  return wrap(real, { key: "ack_acme.k", baseUrl: "http://ac.test", trail: trailPath(), fetch: service.agentcompile });
}

const ask = (client: any, extra: Record<string, unknown> = {}) =>
  client.chat.completions.create({ model: "m", messages: MESSAGES, tools: TOOLS, conversation_id: "c", ...extra });

afterEach(() => resetCapturers());

describe("what the server is told", () => {
  it("hears how long we wait and whether it is shadow", async () => {
    const service = new Service();
    await ask(openai(service, { timeoutMs: 1500 }));
    await ask(openai(service, { mode: "shadow" }));
    const [live, shadow] = service.decides;
    expect(live.headers.get("x-agentcompiler-deadline-ms")).toBe("1500");
    expect(live.headers.get("x-agentcompiler-mode")).toBeNull();
    expect(shadow.headers.get("x-agentcompiler-mode")).toBe("shadow");
  });
});

describe("requests a compiled answer can't honour", () => {
  it.each([
    [{ n: 2 }, "n"],
    [{ tool_choice: "required" }, "tool_choice"],
    [{ tool_choice: { type: "function", function: { name: "x" } } }, "tool_choice"],
    [{ response_format: { type: "json_object" } }, "response_format"],
  ])("%j goes to the model unasked", async (extra, why) => {
    const service = new Service();
    const resp = await ask(openai(service), extra);
    expect(resp.choices[0].message.content).toBe("from the model");
    expect(service.decides).toEqual([]);
    expect(trail()[0]).toMatchObject({ route: "unsupported", reason: why });
  });

  it("still answers auto tool choice and a text format", async () => {
    const service = new Service();
    const resp = await ask(openai(service), { tool_choice: "auto", response_format: { type: "text" }, n: 1 });
    expect(resp.choices[0].message.tool_calls).toHaveLength(1);
    expect(service.providerCalls).toEqual([]);
  });

  it("never answers with a tool the agent didn't offer", async () => {
    const service = new Service();
    const resp = await ask(openai(service), { tools: [{ type: "function", function: { name: "cancel_order" } }] });
    expect(resp.choices[0].message.content).toBe("from the model");
    expect(trail()[0]).toMatchObject({ route: "fail-open", reason: "tool not offered" });
  });
});

describe("bounded in time", () => {
  it("costs at most the timeout when the service is slow", async () => {
    const service = new Service(CALL, 200, 1000);
    const started = performance.now();
    const resp = await ask(openai(service, { timeoutMs: 100 }));
    expect(performance.now() - started).toBeLessThan(500);
    expect(resp.choices[0].message.content).toBe("from the model");
    expect(trail()[0]).toMatchObject({ route: "fail-open", reason: "deadline" });
  });

  it("skips a sick service, then tries again", async () => {
    const service = new Service(CALL, 503);
    const client = openai(service);
    for (let i = 0; i < 5; i++) await ask(client);
    expect(service.decides).toHaveLength(5);
    await ask(client); // open: straight to the model, not asked
    expect(service.decides).toHaveLength(5);
    expect(service.providerCalls).toHaveLength(6);
    expect(trail().at(-1).reason).toBe("circuit open");
  });

  it("lets one call through after a while", () => {
    let now = 0;
    const breaker = new Breaker(2, 10, () => now);
    breaker.record(false);
    expect(breaker.allow()).toBe(true);
    breaker.record(false);
    expect(breaker.allow()).toBe(false);
    now = 11;
    expect(breaker.allow()).toBe(true);
    expect(breaker.allow()).toBe(false); // one trial at a time
    breaker.record(true);
    expect(breaker.allow()).toBe(true);
  });
});

describe("create() returns what the SDKs return", () => {
  it("withResponse() on a forwarded call gives the model's data and response, one call", async () => {
    const service = new Service({ action: "forward", reason: "no job" });
    const { data, response, request_id } = await ask(openai(service)).withResponse();
    expect(data.choices[0].message.content).toBe("from the model");
    expect(response.status).toBe(200);
    expect(request_id).toBe("req_1");
    expect(service.providerCalls).toHaveLength(1);
    expect(trail()[0].route).toBe("forwarded");
  });

  it("asResponse() on a forwarded call gives a body nobody has read", async () => {
    const service = new Service({ action: "forward", reason: "no job" });
    const response = await ask(openai(service)).asResponse();
    expect((await response.json()).choices[0].message.content).toBe("from the model");
    expect(service.providerCalls).toHaveLength(1);
  });

  it("withResponse() and asResponse() on a compiled answer", async () => {
    const { data, response } = await ask(openai(new Service())).withResponse();
    expect(data.choices[0].message.tool_calls[0].function.name).toBe("get_order_details");
    expect(response.headers.get("x-agentcompile-route")).toBe("compiled");
    expect((await response.json()).id).toBe(data.id);
    const raw = await ask(openai(new Service()), { stream: true }).asResponse();
    expect(raw.headers.get("content-type")).toBe("text/event-stream");
    const text = await raw.text();
    expect(text).toContain('"get_order_details"');
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("anthropic too", async () => {
    const { data } = await anthropic(new Service(SAY))
      .messages.create({ model: "claude", max_tokens: 10, messages: MESSAGES, conversation_id: "c" })
      .withResponse();
    expect(data.content[0].text).toBe("Order #W1 is cancelled.");
    const raw = await anthropic(new Service(SAY))
      .messages.create({ model: "claude", max_tokens: 10, messages: MESSAGES, conversation_id: "c", stream: true })
      .asResponse();
    expect(await raw.text()).toContain("event: message_stop");
  });

  it("is still a promise", async () => {
    const pending = ask(openai(new Service()));
    expect(pending).toBeInstanceOf(Promise);
    const [resp] = await Promise.all([pending]);
    expect(resp.choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("nothing grows without bound", () => {
  it("moves the trail aside when it is full", () => {
    dir = mkdtempSync(join(tmpdir(), "ac-"));
    const t = new Trail(trailPath());
    t.maxBytes = 200;
    for (let n = 0; n < 20; n++) t.record({ route: "forwarded", n });
    const moved = `${trailPath()}.1`;
    expect(existsSync(moved) && statSync(moved).size <= 300).toBe(true);
    expect(!existsSync(trailPath()) || statSync(trailPath()).size <= 300).toBe(true);
  });

  it("keeps capture batches under the byte limit, in order", async () => {
    const service = new Service();
    const settings: Settings = { baseUrl: "http://ac.test", key: "ack_acme.k", timeoutMs: 1000, fetch: service.agentcompile };
    const saved = { ...limits };
    Object.assign(limits, { batch: 1100, record: 2000 });
    try {
      const capturer = new Capturer(settings);
      for (let n = 0; n < 4; n++) {
        capturer.add("openai", `c${n}`, { messages: [{ content: "x".repeat(300) }] }, { n });
      }
      capturer.add("openai", "huge", { messages: [{ content: "x".repeat(3000) }] }, {});
      await capturer.flush();
      const sent = service.captures.flatMap((b) => b.exchanges.map((r: any) => r.conversation_id));
      expect(sent).toEqual(["c0", "c1", "c2", "c3"]);
      expect(service.captures).toHaveLength(2);
      expect(capturer.dropped).toBe(1);
    } finally {
      Object.assign(limits, saved);
    }
  });

  it("reuses one sender per destination", () => {
    const f: typeof fetch = async () => json({});
    const settings: Settings = { baseUrl: "http://ac.test", key: "k", timeoutMs: 1000, fetch: f };
    expect(capturerFor(settings, f, null)).toBe(capturerFor({ ...settings }, f, null));
    expect(capturerFor(settings, f, null)).not.toBe(capturerFor({ ...settings, key: "other" }, f, null));
  });
});

describe("a full queue", () => {
  it("drops the oldest, counted, when a batch goes back", () => {
    const settings: Settings = { baseUrl: "http://ac.test", key: "k", timeoutMs: 1000, fetch: async () => json({}) };
    const capturer = new Capturer(settings, 4);
    capturer.queue.push({ id: 4 }, { id: 5 }, { id: 6 });
    capturer.putBack([{ id: 2 }, { id: 3 }]); // older, one free place
    expect(capturer.queue.map((r) => r.id)).toEqual([3, 4, 5, 6]);
    expect(capturer.dropped).toBe(1);
    capturer.putBack([{ id: 1 }]); // no room: the oldest goes
    expect(capturer.queue.map((r) => r.id)).toEqual([3, 4, 5, 6]);
    expect(capturer.dropped).toBe(2);
  });
});
