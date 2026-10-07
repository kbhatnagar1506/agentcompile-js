// Capture from any framework: a fetch that sees the model calls a framework makes (the Vercel AI
// SDK, LangChain.js, Mastra, your own loop) and captures them, with no client to wrap. Capture
// only: every call goes to the model unchanged and is never answered compiled (that takes wrap).
//
//   const openai = createOpenAI({ fetch: captureFetch({ key: "ack_..." }) });   // Vercel AI SDK
//   await conversation(ticket.id, () => generateText({ model: openai("gpt-5"), prompt }));
//
// Seen: POSTs to /chat/completions, /responses (OpenAI and anything OpenAI-compatible) and
// /messages (Anthropic). Everything else passes through untouched. Failed calls (not 2xx) are not
// captured. Nothing here ever throws into the framework. Same rules as the Python SDK's transport.

import { capturerFor } from "./capture.js";
import { currentConversation, currentCustomer } from "./conversation.js";
import type { Provider, Settings } from "./decide.js";
import { DEFAULT_URL } from "./defaults.js";
import { remember } from "./outcome.js";
import { loadScrubKey } from "./scrub.js";

type Json = Record<string, any>;

export interface CaptureFetchOptions {
  /** Your AgentCompile key (or AGENTCOMPILE_KEY). */
  key?: string;
  /** AGENTCOMPILE_URL or the default. */
  baseUrl?: string;
  /** Optional: the key names the company. */
  company?: string;
  /** Tokenize emails, cards, phones and account numbers on this machine first (default true). */
  scrub?: boolean;
  /** Bounds each capture send, not your calls (default 5000 ms). */
  timeoutMs?: number;
  /** The fetch model calls go through (default globalThis.fetch). */
  wrapped?: typeof fetch;
  /** For tests and proxies: the fetch used to reach AgentCompile. */
  fetch?: typeof fetch;
}

/** Which provider's shape a call is, or null for a call we don't capture. */
export function providerOf(method: string, url: string): Provider | null {
  if (method.toUpperCase() !== "POST") return null;
  let path: string;
  try {
    path = new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
  if (path.endsWith("/chat/completions") || path.endsWith("/responses")) return "openai";
  // Anthropic's create; not OpenAI's Assistants threads, which also end in /messages.
  if (path.endsWith("/messages") && !path.includes("/threads/")) return "anthropic";
  return null;
}

/** The JSON objects in a server-sent event stream, in order ([DONE] and comments skipped). */
export function events(text: string): Json[] {
  const found: Json[] = [];
  for (const block of text.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const value = JSON.parse(data);
      if (value && typeof value === "object" && !Array.isArray(value)) found.push(value);
    } catch {
      // not JSON: skipped
    }
  }
  return found;
}

const ENDS = ["response.completed", "response.incomplete", "response.failed", "message_stop"];

/** Whether a stream reached its own end marker (SDKs may stop reading there). */
export function ended(text: string, chunks: Json[]): boolean {
  if (text.includes("data: [DONE]") || chunks.some((c) => ENDS.includes(c.type))) return true;
  const last = chunks.at(-1) ?? {};
  return (last.choices ?? []).some((choice: Json) => Boolean(choice?.finish_reason));
}

async function bodyText(input: RequestInfo | URL, init?: RequestInit): Promise<string | null> {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body === undefined && typeof Request !== "undefined" && input instanceof Request) {
    return input.clone().text();
  }
  return null;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** A fetch whose model calls are captured: pass it as the framework's `fetch`. */
export function captureFetch(options: CaptureFetchOptions = {}): typeof fetch {
  const wrapped = options.wrapped ?? globalThis.fetch.bind(globalThis);
  const settings: Settings = {
    baseUrl: options.baseUrl ?? process.env.AGENTCOMPILE_URL ?? DEFAULT_URL,
    key: options.key ?? process.env.AGENTCOMPILE_KEY,
    company: options.company ?? process.env.AGENTCOMPILE_COMPANY,
    timeoutMs: options.timeoutMs ?? 5000,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
  };
  remember(settings);
  const capturer = capturerFor(
    settings,
    options.fetch ?? globalThis.fetch,
    options.scrub === false ? null : loadScrubKey(),
  );

  return async function capturingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET");
    const provider = providerOf(method, urlOf(input));
    let body: Json | null = null;
    if (provider) {
      try {
        const parsed = JSON.parse((await bodyText(input, init)) ?? "");
        if (parsed && typeof parsed === "object" && ("messages" in parsed || "input" in parsed)) body = parsed;
      } catch {
        body = null;
      }
    }
    const response = await wrapped(input, init);
    if (!provider || !body || !response.ok) return response;
    const conversationId = currentConversation();
    const customer = currentCustomer();
    try {
      if (body.stream && response.body) {
        const [mine, theirs] = response.body.tee();
        void new Response(mine)
          .text()
          .then((text) => {
            const chunks = events(text);
            capturer.addStream(provider, conversationId, body, chunks, ended(text, chunks), customer);
          })
          .catch(() => {
            capturer.dropped += 1;
          });
        return new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      void response
        .clone()
        .json()
        .then((data) => capturer.add(provider, conversationId, body, data, false, { customer }))
        .catch(() => {
          capturer.dropped += 1;
        });
    } catch {
      capturer.dropped += 1;
    }
    return response;
  };
}
