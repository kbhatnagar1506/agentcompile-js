// Capture: each model call's request and answer, sent to AgentCompile in the background so it
// can find the jobs your agent repeats (opt-in: `wrap(client, { capture: true })`).
//
// Never in the way: calls are queued and sent in batches on a timer that doesn't keep the
// process alive; a full queue drops the oldest, a failed send is dropped and counted, nothing
// here ever throws into your agent. Each record is the exchange-log shape AgentCompile's
// importer reads: {provider, conversation_id, timestamp, request, response}.

import { type Provider, type Settings, endpoint, headers } from "./decide.js";
import { jsonable, payload } from "./payload.js";
import { assemble } from "./assemble.js";
import { scrubCall, scrubValue } from "./scrub.js";

export const MAX_QUEUE = 2000;
export const BATCH = 50;
export const INTERVAL_MS = 1000;

const all = new Set<Capturer>();

export async function flushAll(): Promise<void> {
  await Promise.all([...all].map((c) => c.flush()));
}

export class Capturer {
  sent = 0;
  dropped = 0;
  failed = 0;
  readonly queue: Record<string, unknown>[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private sending: Promise<void> = Promise.resolve();

  constructor(
    private readonly settings: Settings,
    private readonly maxQueue = MAX_QUEUE,
    /** null: send as is (scrub: false). Otherwise personal data is tokenized before queueing. */
    private readonly scrubKey: Buffer | null = null,
  ) {
    all.add(this);
  }

  add(
    provider: Provider,
    conversationId: string | undefined,
    params: Record<string, unknown>,
    response: unknown,
    stream = false,
    extra: { customer?: string; streamed?: { complete: boolean } } = {},
  ): void {
    try {
      let request: unknown = payload(params);
      // A streamed answer is not captured yet: the record keeps the request and says so.
      let answer: unknown = stream ? null : jsonable(response);
      if (this.scrubKey) {
        request = scrubCall(request, this.scrubKey);
        answer = scrubCall(answer, this.scrubKey);
      }
      const record: Record<string, unknown> = {
        provider,
        conversation_id: conversationId ?? null,
        timestamp: new Date().toISOString(),
        request,
        response: answer,
      };
      if (extra.customer) {
        // The customer's id, scrubbed like everything else (an email becomes a token).
        record.end_user = this.scrubKey ? scrubValue(extra.customer, this.scrubKey, "customer") : extra.customer;
      }
      if (extra.streamed) {
        record.stream = true;
        record.stream_complete = extra.streamed.complete;
      }
      if (this.scrubKey) record.scrubbed = true;
      if (stream) record.stream = true;
      if (this.queue.length >= this.maxQueue) {
        this.queue.shift();
        this.dropped += 1;
      }
      this.queue.push(record);
      this.start();
      if (this.queue.length >= BATCH) void this.send();
    } catch {
      this.dropped += 1;
    }
  }

  /** Queue a streamed call once its stream is done: the chunks assembled into the answer a
   * non-streamed call would have had. A stream stopped early is kept and marked. */
  addStream(
    provider: Provider,
    conversationId: string | undefined,
    params: Record<string, unknown>,
    chunks: unknown[],
    complete: boolean,
    customer?: string,
  ): void {
    this.add(provider, conversationId, params, assemble(provider, chunks), false, {
      customer,
      streamed: { complete },
    });
  }

  /** Send everything queued now (short scripts, tests, before exit). */
  async flush(): Promise<void> {
    while (this.queue.length) await this.send();
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.send(), INTERVAL_MS);
    // Never keep the customer's process alive just to send capture.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private send(): Promise<void> {
    this.sending = this.sending.then(() => this.sendBatch());
    return this.sending;
  }

  private async sendBatch(): Promise<void> {
    const batch = this.queue.splice(0, BATCH);
    if (!batch.length) return;
    try {
      const response = await this.settings.fetch(endpoint(this.settings, "/v1/capture"), {
        method: "POST",
        headers: headers(this.settings),
        body: JSON.stringify({ exchanges: batch }),
      });
      if (response.status === 200) this.sent += batch.length;
      else this.failed += batch.length;
    } catch {
      this.failed += batch.length;
    }
  }
}
