// Streamed answers, captured whole: each chunk reaches your agent untouched as it arrives, a
// copy is kept, and when the stream ends the pieces are assembled into the shape a non-streamed
// answer has (a chat completion, or an Anthropic message). Same rules as the Python SDK.

import { jsonable } from "./payload.js";

type Json = Record<string, any>;

export function assemble(provider: string, chunks: unknown[]): Json | null {
  try {
    return provider === "openai" ? assembleOpenAI(chunks as Json[]) : assembleAnthropic(chunks as Json[]);
  } catch {
    return null; // never break the agent over a shape we didn't expect
  }
}

function assembleOpenAI(chunks: Json[]): Json {
  const first = chunks[0] ?? {};
  const content: string[] = [];
  const calls = new Map<number, Json>();
  let finish: unknown = null;
  let usage: unknown = null;
  for (const chunk of chunks) {
    usage = chunk.usage ?? usage;
    if (chunk.choices !== undefined && !Array.isArray(chunk.choices)) throw new Error("bad chunk");
    for (const choice of chunk.choices ?? []) {
      if ((choice.index ?? 0) !== 0) continue;
      const delta = choice.delta ?? {};
      if (delta.content) content.push(delta.content);
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        const slot = calls.get(index) ?? { id: null, type: "function", function: { name: "", arguments: "" } };
        slot.id = call.id ?? slot.id;
        slot.function.name += call.function?.name ?? "";
        slot.function.arguments += call.function?.arguments ?? "";
        calls.set(index, slot);
      }
      finish = choice.finish_reason ?? finish;
    }
  }
  const message: Json = { role: "assistant", content: content.join("") || null };
  if (calls.size) message.tool_calls = [...calls.keys()].sort((a, b) => a - b).map((i) => calls.get(i));
  const out: Json = {
    id: first.id ?? null,
    object: "chat.completion",
    created: first.created ?? null,
    model: first.model ?? null,
    choices: [{ index: 0, message, finish_reason: finish }],
  };
  if (usage) out.usage = usage;
  return out;
}

function assembleAnthropic(events: Json[]): Json {
  let message: Json = {};
  const blocks = new Map<number, Json>();
  const partial = new Map<number, string[]>();
  for (const event of events) {
    switch (event.type) {
      case "message_start":
        message = { ...(event.message ?? {}) };
        break;
      case "content_block_start":
        blocks.set(event.index, { ...(event.content_block ?? {}) });
        break;
      case "content_block_delta": {
        if (event.index === undefined) throw new Error("delta without an index");
        const block = blocks.get(event.index) ?? { type: "text", text: "" };
        const delta = event.delta ?? {};
        if (delta.type === "text_delta") block.text = (block.text ?? "") + (delta.text ?? "");
        else if (delta.type === "input_json_delta") {
          partial.set(event.index, [...(partial.get(event.index) ?? []), delta.partial_json ?? ""]);
        } else if (delta.type === "thinking_delta") {
          block.thinking = (block.thinking ?? "") + (delta.thinking ?? "");
        }
        blocks.set(event.index, block);
        break;
      }
      case "message_delta":
        message.stop_reason = event.delta?.stop_reason ?? message.stop_reason;
        message.stop_sequence = event.delta?.stop_sequence ?? null;
        message.usage = { ...(message.usage ?? {}), ...(event.usage ?? {}) };
        break;
    }
  }
  for (const [index, pieces] of partial) {
    const text = pieces.join("");
    (blocks.get(index) as Json).input = text ? JSON.parse(text) : {};
  }
  message.content = [...blocks.keys()].sort((a, b) => a - b).map((i) => blocks.get(i));
  return message;
}

export type OnDone = (chunks: unknown[], complete: boolean) => void;

/** Your stream, unchanged, with a copy of each chunk kept for capture. Reading it with
 * `for await` is captured; everything else on it (controller, tee, ...) is the real stream's. */
export function capturingStream<T extends object>(stream: T, onDone: OnDone): T {
  const chunks: unknown[] = [];
  let finished = false;
  const finish = (complete: boolean) => {
    if (!finished) {
      finished = true;
      onDone(chunks, complete);
    }
  };
  return new Proxy(stream, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return async function* () {
          let complete = false;
          try {
            for await (const item of target as AsyncIterable<unknown>) {
              chunks.push(jsonable(item));
              yield item;
            }
            complete = true;
          } finally {
            finish(complete);
          }
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
