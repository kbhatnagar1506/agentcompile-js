// Capture on its own: a full queue, a failing service, streams, and records that can't be built.

import { describe, expect, it } from "vitest";
import { Capturer } from "../src/capture.js";
import type { Settings } from "../src/decide.js";

const settings = (fetchImpl: typeof fetch): Settings => ({
  baseUrl: "http://ac.test/",
  key: "ack_acme.k",
  timeoutMs: 1000,
  fetch: fetchImpl,
});
const ok: typeof fetch = async () => new Response("{}", { status: 200 });

describe("Capturer", () => {
  it("drops the oldest when the queue is full", () => {
    const c = new Capturer(settings(ok), 2);
    for (const n of [0, 1, 2]) c.add("openai", `c${n}`, { messages: [] }, { n });
    expect(c.dropped).toBe(1);
    expect(c.queue.map((r) => r.conversation_id)).toEqual(["c1", "c2"]);
  });

  it("counts a failed send and never throws", async () => {
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const refused: typeof fetch = async () => new Response("{}", { status: 500 });
    for (const f of [down, refused]) {
      const c = new Capturer(settings(f));
      c.add("openai", "c1", { messages: [] }, {});
      await c.flush();
      expect(c.failed).toBe(1);
      expect(c.sent).toBe(0);
    }
  });

  it("sends to /v1/capture with the key and no conversation header", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const c = new Capturer(
      settings(async (input, init) => {
        seen.push({ url: String(input), headers: new Headers(init?.headers) });
        return new Response("{}", { status: 200 });
      }),
    );
    c.add("anthropic", "c1", { model: "m", messages: [], temperature: 1 }, { id: "r" });
    await c.flush();
    expect(c.sent).toBe(1);
    expect(seen[0].url).toBe("http://ac.test/v1/capture");
    expect(seen[0].headers.get("x-agentcompiler-key")).toBe("ack_acme.k");
    expect(seen[0].headers.get("x-agentcompiler-conversation")).toBeNull();
  });

  it("marks a streamed answer instead of recording it", () => {
    const c = new Capturer(settings(ok));
    c.add("openai", "c1", { messages: [], stream: true }, { not: "recorded" }, true);
    expect(c.queue[0]).toMatchObject({ response: null, stream: true });
  });

  it("sends a full batch without waiting for the timer", async () => {
    let posts = 0;
    const c = new Capturer(
      settings(async () => {
        posts += 1;
        return new Response("{}", { status: 200 });
      }),
    );
    for (let n = 0; n < 50; n++) c.add("openai", "c1", { messages: [] }, {});
    await c.flush();
    expect(posts).toBe(1);
    expect(c.sent).toBe(50);
  });

  it("drops a record that can't be built, quietly", () => {
    const c = new Capturer(settings(ok));
    const bad = { get messages() { throw new Error("boom"); } };
    c.add("openai", "c1", bad as unknown as Record<string, unknown>, {});
    expect(c.dropped).toBe(1);
  });
});
