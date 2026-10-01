/**
 * AgentCompile: wrap your agent's model client.
 *
 *   import OpenAI from "openai";
 *   import { wrap, conversation } from "agentcompile";
 *   const client = wrap(new OpenAI(), { key: "ack_..." });
 *   await conversation(ticket.id, () => runAgent(client, ticket));
 *
 * Known jobs run compiled (no model call); everything else goes to your model unchanged, with
 * your own provider key. If AgentCompile is down or slow, calls go straight to your model.
 * Every call is written to the trail (~/.agentcompile/trail.jsonl).
 */

import { buildAnthropic, buildOpenAI } from "./build.js";
import { Capturer, flushAll } from "./capture.js";
import { currentConversation } from "./conversation.js";
import { type Decision, type Provider, type Settings, decide } from "./decide.js";
import { payload } from "./payload.js";
import { loadScrubKey } from "./scrub.js";
import { type OnEvent, Trail } from "./trail.js";

export { conversation } from "./conversation.js";
export type { Decision } from "./decide.js";
export const VERSION = "0.1.0"; // x-release-please-version
export const DEFAULT_URL = "https://api.tryagentcompile.com";

export type Mode = "live" | "shadow";

export interface WrapOptions {
  /** Your AgentCompile key (or AGENTCOMPILE_KEY). */
  key?: string;
  /** AGENTCOMPILE_URL or the default. */
  baseUrl?: string;
  /** "live" answers known jobs; "shadow" decides but always calls your model. */
  mode?: Mode;
  /** How long to wait for a decision before failing open (default 2000 ms). */
  timeoutMs?: number;
  /** A path, true for ~/.agentcompile/trail.jsonl, or false. */
  trail?: string | boolean;
  /** Called with each trail event. */
  onEvent?: OnEvent;
  /** Optional: the key names the company. */
  company?: string;
  /** Send each call's request and answer to AgentCompile in the background (opt-in; or
   * AGENTCOMPILE_CAPTURE=1). Never slows a call. */
  capture?: boolean;
  /** With capture: turn emails, cards, phones and account numbers into keyed tokens on this
   * machine before anything is sent (default true; key: AGENTCOMPILE_SCRUB_KEY, else one
   * created once in ~/.agentcompile/scrub.key). */
  scrub?: boolean;
  /** For tests and proxies: the fetch used to reach AgentCompile. */
  fetch?: typeof fetch;
}

/** Wrap an OpenAI- or Anthropic-style client; returns an object you use exactly like it. */
export function wrap<T extends object>(client: T, options: WrapOptions = {}): T {
  const mode = options.mode ?? "live";
  if (mode !== "live" && mode !== "shadow") throw new Error("mode must be 'live' or 'shadow'");
  const settings: Settings = {
    baseUrl: options.baseUrl ?? process.env.AGENTCOMPILE_URL ?? DEFAULT_URL,
    key: options.key ?? process.env.AGENTCOMPILE_KEY,
    company: options.company ?? process.env.AGENTCOMPILE_COMPANY,
    timeoutMs: options.timeoutMs ?? 2000,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
  };
  const trail = new Trail(options.trail ?? true, options.onEvent);
  const captureOn = options.capture ?? ["1", "true", "yes"].includes(process.env.AGENTCOMPILE_CAPTURE ?? "");
  const capturer = captureOn
    ? new Capturer(settings, undefined, options.scrub === false ? null : loadScrubKey())
    : null;
  const router = { settings, trail, mode, capturer };

  const anyClient = client as Record<string, any>;
  const completions = anyClient.chat?.completions;
  if (completions && typeof completions.create === "function") {
    const create = wrapCreate(router, "openai", completions, buildOpenAI);
    return override(client, {
      chat: override(anyClient.chat, { completions: override(completions, { create }) }),
    });
  }
  const messages = anyClient.messages;
  if (messages && typeof messages.create === "function") {
    const create = wrapCreate(router, "anthropic", messages, buildAnthropic);
    return override(client, { messages: override(messages, { create }) });
  }
  throw new TypeError("agentcompile.wrap expects an OpenAI- or Anthropic-style client");
}

/** Send every captured call still queued (short scripts and tests). */
export async function flush(): Promise<void> {
  await flushAll();
}

interface Router {
  settings: Settings;
  trail: Trail;
  mode: Mode;
  capturer: Capturer | null;
}

type Build = (decision: Decision, params: Record<string, unknown>, stream: boolean) => unknown;

function wrapCreate(router: Router, provider: Provider, resource: Record<string, any>, build: Build) {
  const original = resource.create as (...args: unknown[]) => Promise<unknown>;
  return async function create(params: Record<string, unknown>, ...rest: unknown[]): Promise<unknown> {
    const started = performance.now();
    const { conversationId: ownId, conversation_id: snakeId, ...realParams } = params ?? {};
    const conversationId = (ownId ?? snakeId ?? currentConversation()) as string | undefined;
    let decision: Decision | null = null;
    let decideMs: number | undefined;
    let error: string | undefined;
    if (conversationId) {
      ({ decision, ms: decideMs, error } = await decide(
        router.settings,
        provider,
        conversationId,
        payload(realParams),
      ));
    }
    let route: string;
    let answer: Decision | null = null;
    if (!conversationId) route = "no-conversation";
    else if (!decision) route = "fail-open";
    else if (decision.action === "forward") route = "forwarded";
    else if (router.mode === "shadow") route = "shadow";
    else ((route = "compiled"), (answer = decision));
    const stream = Boolean(realParams.stream);
    const record = () =>
      router.trail.record({
        conversation: conversationId,
        provider,
        model: realParams.model,
        route,
        action: decision?.action,
        tool: decision?.tool,
        reason: (decision?.action === "forward" ? decision.reason : undefined) || error,
        events: decision?.events.length ? decision.events : undefined,
        decide_ms: decideMs === undefined ? undefined : Math.round(decideMs * 10) / 10,
        total_ms: Math.round((performance.now() - started) * 10) / 10,
        stream: stream || undefined,
      });
    if (answer) {
      try {
        const result = build(answer, realParams, stream);
        record();
        router.capturer?.add(provider, conversationId, realParams, result, stream);
        return result;
      } catch (err) {
        // fail open: a compiled answer we can't shape goes to the model
        route = "fail-open";
        error = `build: ${err instanceof Error ? err.name : "Error"}`;
      }
    }
    const result = await original.call(resource, realParams, ...rest);
    record();
    router.capturer?.add(provider, conversationId, realParams, result, stream);
    return result;
  };
}

/** A view of `target` with some properties replaced; everything else is the real thing. */
function override<T extends object>(target: T, replaced: Record<string, unknown>): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "string" && prop in replaced) return replaced[prop];
      const value = Reflect.get(t, prop, t);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}

