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
import { type Capturer, capturerFor, flushAll } from "./capture.js";
import { capturingStream } from "./assemble.js";
import { currentConversation, currentCustomer } from "./conversation.js";
import { flushOutcomes, remember } from "./outcome.js";
import { Breaker, type Decision, type Provider, type Settings, decide } from "./decide.js";
import { payload } from "./payload.js";
import { AgentCompilePromise, type Stage } from "./promise.js";
import { offered, unsupported } from "./shape.js";
import { loadScrubKey } from "./scrub.js";
import { DEFAULT_URL } from "./defaults.js";
import { type OnEvent, Trail } from "./trail.js";

export { conversation } from "./conversation.js";
export { AgentCompilePromise } from "./promise.js";
export { OUTCOMES, type Outcome, outcome } from "./outcome.js";
export type { Decision } from "./decide.js";
export const VERSION = "0.1.0"; // x-release-please-version
export { DEFAULT_URL } from "./defaults.js";
export { type CaptureFetchOptions, captureFetch } from "./fetch.js";

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
    mode,
  };
  const trail = new Trail(options.trail ?? true, options.onEvent);
  const captureOn = options.capture ?? ["1", "true", "yes"].includes(process.env.AGENTCOMPILE_CAPTURE ?? "");
  const capturer = captureOn
    ? capturerFor(settings, options.fetch ?? globalThis.fetch, options.scrub === false ? null : loadScrubKey())
    : null;
  const router = { settings, trail, mode, capturer, breaker: new Breaker() };
  remember(settings); // outcome() sends with the client wrapped last

  const anyClient = client as Record<string, any>;
  const completions = anyClient.chat?.completions;
  if (completions && typeof completions.create === "function") {
    const create = wrapCreate(router, "openai", completions, buildOpenAI);
    const replaced: Record<string, unknown> = {
      chat: override(anyClient.chat, { completions: override(completions, { create }) }),
    };
    const responses = anyClient.responses;
    if (responses && typeof responses.create === "function") {
      // The Responses API (the OpenAI Agents SDK's default): captured, always the model's.
      replaced.responses = override(responses, { create: wrapForward(router, responses) });
    }
    return override(client, replaced);
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
  await flushOutcomes();
}

interface Router {
  settings: Settings;
  trail: Trail;
  mode: Mode;
  capturer: Capturer | null;
  breaker: Breaker;
}

type Build = (decision: Decision, params: Record<string, unknown>, stream: boolean) => unknown;

/** Our keywords taken off a call (they never reach the model): its conversation and customer. */
function split(params: Record<string, unknown>) {
  const {
    conversationId: ownId,
    conversation_id: snakeId,
    customerId,
    customer_id: snakeCustomer,
    ...realParams
  } = params ?? {};
  return {
    conversationId: (ownId ?? snakeId ?? currentConversation()) as string | undefined,
    customer: (customerId ?? snakeCustomer ?? currentCustomer()) as string | undefined,
    realParams,
    stream: Boolean(realParams.stream),
  };
}

/** Queue a call's answer for capture; returns what to hand back (a stream comes back wrapped, so
 * its answer is captured once the agent has read it). */
function capturing(router: Router, provider: Provider, call: ReturnType<typeof split>) {
  const { conversationId, customer, realParams, stream } = call;
  return (result: unknown): unknown => {
    const capturer = router.capturer;
    if (!capturer) return result;
    if (!stream || !result || typeof result !== "object") {
      capturer.add(provider, conversationId, realParams, result, stream, { customer });
      return result;
    }
    return capturingStream(result, (chunks, complete) =>
      capturer.addStream(provider, conversationId, realParams, chunks, complete, customer),
    );
  };
}

/** Why a Responses API call is never asked about: compiled answers come in Chat Completions' and
 * Anthropic's shapes, so these calls go to the model, captured like any other. */
export const RESPONSES_API = "responses api";

/** create() for an API we capture but don't answer: straight to the model. */
function wrapForward(router: Router, resource: Record<string, any>) {
  const original = resource.create as (...args: unknown[]) => unknown;
  return function create(params: Record<string, unknown>, ...rest: unknown[]): AgentCompilePromise {
    const started = performance.now();
    const call = split(params);
    const capture = capturing(router, "openai", call);
    let recorded = false;
    const done = () => {
      if (recorded) return;
      recorded = true;
      router.trail.record({
        conversation: call.conversationId,
        provider: "openai",
        model: call.realParams.model,
        route: call.conversationId ? "unsupported" : "no-conversation",
        reason: call.conversationId ? RESPONSES_API : undefined,
        total_ms: Math.round((performance.now() - started) * 10) / 10,
        stream: call.stream || undefined,
      });
    };
    const api = original.call(resource, call.realParams, ...rest);
    const finish = (data: unknown) => {
      done();
      return capture(data);
    };
    return new AgentCompilePromise(Promise.resolve<Stage>({ kind: "forward", api, finish, done }), "openai");
  };
}

function wrapCreate(router: Router, provider: Provider, resource: Record<string, any>, build: Build) {
  const original = resource.create as (...args: unknown[]) => unknown;
  return function create(params: Record<string, unknown>, ...rest: unknown[]): AgentCompilePromise {
    const started = performance.now();
    const call = split(params);
    const { conversationId, realParams, stream } = call;
    const capture = capturing(router, provider, call);
    const stage = (async (): Promise<Stage> => {
      let decision: Decision | null = null;
      let decideMs: number | undefined;
      let error: string | undefined;
      const why = conversationId ? unsupported(realParams) : undefined;
      if (conversationId && !why) {
        ({ decision, ms: decideMs, error } = await decide(
          router.settings,
          provider,
          conversationId,
          payload(realParams),
          router.breaker,
        ));
      }
      let route: string;
      let answer: Decision | null = null;
      if (!conversationId) route = "no-conversation";
      else if (why) ((route = "unsupported"), (error = why));
      else if (!decision) route = "fail-open";
      else if (decision.action === "forward") route = "forwarded";
      else if (router.mode === "shadow") route = "shadow";
      else if (decision.action === "tool_call" && !offered(realParams, decision.tool)) {
        // A tool the agent didn't offer this turn: its loop couldn't run it.
        ((route = "fail-open"), (error = "tool not offered"));
      } else ((route = "compiled"), (answer = decision));
      let recorded = false;
      const done = () => {
        if (recorded) return;
        recorded = true;
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
      };
      if (answer) {
        try {
          const result = build(answer, realParams, stream);
          done();
          return { kind: "compiled", data: capture(result), stream, done };
        } catch (err) {
          // fail open: a compiled answer we can't shape goes to the model
          route = "fail-open";
          error = `build: ${err instanceof Error ? err.name : "Error"}`;
        }
      }
      const api = original.call(resource, realParams, ...rest);
      const finish = (data: unknown) => {
        done();
        return capture(data);
      };
      return { kind: "forward", api, finish, done };
    })();
    return new AgentCompilePromise(stage, provider);
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

