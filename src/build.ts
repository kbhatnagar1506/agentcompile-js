// Compiled answers shaped exactly like the providers' own results, so the agent can't tell
// them apart: chat.completions.create() for OpenAI-style clients, messages.create() for
// Anthropic-style ones, streamed or not.

import { randomUUID } from "node:crypto";
import type { Decision } from "./decide.js";

const hex = (n: number) => randomUUID().replace(/-/g, "").slice(0, n);

/** A finished stream: what `for await (const chunk of stream)` reads, plus the bits of the
 * SDKs' Stream objects agents commonly touch. */
export class CompiledStream<T> implements AsyncIterable<T> {
  readonly controller = new AbortController();
  constructor(private readonly items: T[]) {}
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (const item of this.items) yield item;
  }
  toReadableStream(): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const items = this.items;
    return new ReadableStream({
      start(c) {
        for (const item of items) c.enqueue(encoder.encode(`${JSON.stringify(item)}\n`));
        c.close();
      },
    });
  }
}

export function buildOpenAI(decision: Decision, params: Record<string, unknown>, stream: boolean): unknown {
  const model = String(params.model ?? "agentcompile");
  const id = `chatcmpl-ac-${hex(16)}`;
  const created = Math.floor(Date.now() / 1000);
  const message: Record<string, unknown> =
    decision.action === "tool_call"
      ? {
          role: "assistant",
          content: null,
          refusal: null,
          tool_calls: [
            {
              id: decision.callId || `call_ac_${hex(12)}`,
              type: "function",
              function: { name: decision.tool, arguments: JSON.stringify(decision.args ?? {}) },
            },
          ],
        }
      : { role: "assistant", content: decision.text ?? "", refusal: null };
  const finish = decision.action === "tool_call" ? "tool_calls" : "stop";
  if (!stream) {
    return {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: finish, logprobs: null }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
  const delta: Record<string, unknown> = { role: "assistant", content: message.content };
  if (message.tool_calls) {
    delta.tool_calls = (message.tool_calls as Record<string, unknown>[]).map((call, index) => ({
      ...call,
      index,
    }));
  }
  const base = { id, object: "chat.completion.chunk", created, model };
  return new CompiledStream([
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
  ]);
}

export function buildAnthropic(decision: Decision, params: Record<string, unknown>, stream: boolean): unknown {
  const model = String(params.model ?? "agentcompile");
  const block: Record<string, unknown> =
    decision.action === "tool_call"
      ? { type: "tool_use", id: decision.callId || `toolu_ac_${hex(12)}`, name: decision.tool, input: decision.args ?? {} }
      : { type: "text", text: decision.text ?? "" };
  const stop = decision.action === "tool_call" ? "tool_use" : "end_turn";
  const message = {
    id: `msg_ac_${hex(16)}`,
    type: "message",
    role: "assistant",
    model,
    content: [block],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  if (!stream) return message;
  const toolUse = block.type === "tool_use";
  const startBlock = toolUse ? { ...block, input: {} } : { type: "text", text: "" };
  const delta = toolUse
    ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
    : { type: "text_delta", text: block.text };
  return new CompiledStream([
    { type: "message_start", message: { ...message, content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: startBlock },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 0 } },
    { type: "message_stop" },
  ]);
}
