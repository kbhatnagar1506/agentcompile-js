// What a wrapped create() returns: a promise like the SDKs' own APIPromise, so `await create()`,
// `.withResponse()` and `.asResponse()` all work. Like theirs, a forwarded answer is parsed only
// when something asks for the data, so `.asResponse()` hands back a body nobody has read.

import type { Provider } from "./decide.js";

/** Where a call went: answered here, or sent to the model (`api` is what the real create()
 * returned; `finish` turns its parsed data into what the caller gets). */
export type Stage =
  | { kind: "compiled"; data: unknown; stream: boolean; done: () => void }
  | { kind: "forward"; api: unknown; finish: (data: unknown) => unknown; done: () => void };

export class AgentCompilePromise<T = unknown> extends Promise<T> {
  private parsed: Promise<T> | null = null;

  constructor(
    private readonly stage: Promise<Stage>,
    private readonly provider: Provider,
  ) {
    // A no-op, as in the SDKs' APIPromise: then/catch/finally below do the work.
    super((resolve) => resolve(null as T));
  }

  // Promise.prototype methods build new promises with the species: plain ones.
  static get [Symbol.species]() {
    return Promise;
  }

  private parse(): Promise<T> {
    if (!this.parsed) {
      this.parsed = this.stage.then((s) =>
        s.kind === "compiled" ? (s.data as T) : Promise.resolve(s.api).then((data) => s.finish(data) as T),
      );
    }
    return this.parsed;
  }

  override then<A = T, B = never>(
    onfulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.parse().then(onfulfilled, onrejected);
  }

  override catch<B = never>(onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<T | B> {
    return this.parse().catch(onrejected);
  }

  override finally(onfinally?: (() => void) | null): Promise<T> {
    return this.parse().finally(onfinally);
  }

  /** The raw Response, its body unread. A compiled answer comes as the response the provider
   * would have sent (JSON, or an event stream when streamed). */
  async asResponse(): Promise<Response> {
    const s = await this.stage;
    if (s.kind === "compiled") {
      s.done();
      return compiledResponse(this.provider, s.data, s.stream);
    }
    const api = s.api as { asResponse?: () => Promise<Response> };
    if (typeof api?.asResponse !== "function") throw new TypeError("this client's create() has no asResponse()");
    const response = await api.asResponse();
    s.done();
    return response;
  }

  /** The data and the raw Response, as the SDKs' withResponse() gives them. */
  async withResponse(): Promise<{ data: T; response: Response; request_id: string | null }> {
    const s = await this.stage;
    if (s.kind === "compiled") {
      s.done();
      return { data: s.data as T, response: compiledResponse(this.provider, s.data, s.stream), request_id: null };
    }
    const api = s.api as { withResponse?: () => Promise<{ data: unknown; response: Response; request_id?: string | null }> };
    if (typeof api?.withResponse !== "function") throw new TypeError("this client's create() has no withResponse()");
    const got = await api.withResponse();
    return { ...got, data: s.finish(got.data) as T, request_id: got.request_id ?? null };
  }
}

const COMPILED_HEADERS = { "x-agentcompile-route": "compiled" };

function compiledResponse(provider: Provider, data: unknown, stream: boolean): Response {
  if (!stream) {
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json", ...COMPILED_HEADERS },
    });
  }
  const items = (data as { items?: unknown[] }).items ?? [];
  return new Response(eventStream(provider, items), {
    status: 200,
    headers: { "content-type": "text/event-stream", ...COMPILED_HEADERS },
  });
}

/** The provider's own server-sent events for a stream's chunks. */
export function eventStream(provider: Provider, items: unknown[]): string {
  if (provider === "openai") {
    return `${items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("")}data: [DONE]\n\n`;
  }
  return items
    .map((item) => `event: ${(item as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(item)}\n\n`)
    .join("");
}
