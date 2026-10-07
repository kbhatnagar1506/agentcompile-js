// Capture: each model call's request and answer, sent to AgentCompile in the background so it
// can find the jobs your agent repeats (opt-in: `wrap(client, { capture: true })`).
//
// Never in the way: calls are queued and sent in batches on a timer that doesn't keep the
// process alive; a full queue drops the oldest, a send that fails for a passing reason (no
// connection, 408, 429, 5xx) is retried a few times with backoff, one that still fails is dropped
// and counted, and nothing here ever throws into your agent. Each record is the exchange-log shape AgentCompile's
// importer reads: {provider, conversation_id, timestamp, request, response}.

import { type Provider, type Settings, endpoint, headers } from "./decide.js";
import { jsonable, requestOf } from "./payload.js";
import { assemble } from "./assemble.js";
import { scrubCall, scrubValue } from "./scrub.js";

export const MAX_QUEUE = 2000;
export const BATCH = 50;
// The server takes up to 8 MiB a request: batches stay under 4 MiB, and a call bigger than
// limits.record on its own (a huge history) is dropped and counted.
export const limits = { batch: 4 * 1024 * 1024, record: 7 * 1024 * 1024 };
export const INTERVAL_MS = 1000;
// A failed batch is tried `times` more, waiting backoffMs, then twice that, ... (or what the
// server's Retry-After asks, up to maxWaitMs); about 3.5 s in all before it is dropped.
export const retry = {
  times: 3,
  backoffMs: 500,
  maxWaitMs: 10_000,
  sleep: (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      (timer as { unref?: () => void }).unref?.(); // never keeps the process alive
    }),
};
const PASSING = new Set([408, 425, 429, 500, 502, 503, 504]);

const all = new Set<Capturer>();
const reused = new Map<unknown, Map<string, Capturer>>();

/** One sender (one queue, one timer) per destination: wrapping a client per request, as some
 * apps do, reuses it instead of starting another each time. */
export function capturerFor(settings: Settings, fetchKey: unknown, scrubKey: Buffer | null): Capturer {
  const key = [settings.baseUrl, settings.key ?? "", settings.company ?? "", scrubKey?.toString("hex") ?? ""].join("\u0000");
  let forFetch = reused.get(fetchKey);
  if (!forFetch) reused.set(fetchKey, (forFetch = new Map()));
  let found = forFetch.get(key);
  if (!found) forFetch.set(key, (found = new Capturer(settings, undefined, scrubKey)));
  return found;
}

/** Tests: forget every sender. */
export function resetCapturers(): void {
  all.clear();
  reused.clear();
}

export async function flushAll(): Promise<void> {
  await Promise.all([...all].map((c) => c.flush()));
}

export class Capturer {
  sent = 0;
  dropped = 0;
  /** Calls dropped after their send failed (and was retried, if it could be). */
  failed = 0;
  /** Batch sends tried again. */
  retried = 0;
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
      let request: unknown = requestOf(params);
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

  /** Send everything queued now (short scripts, tests, before exit); retries never wait past
   * timeoutMs from now. */
  async flush(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length && Date.now() < deadline) await this.send(deadline);
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.send(), INTERVAL_MS);
    // Never keep the customer's process alive just to send capture.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private send(deadline?: number): Promise<void> {
    this.sending = this.sending.then(() => this.sendBatch(deadline));
    return this.sending;
  }

  /** Up to BATCH queued calls, encoded, under limits.batch bytes together (the first alone may
   * be up to limits.record); what doesn't fit stays at the front of the queue. */
  private take(): string[] {
    const records = this.queue.splice(0, BATCH);
    const batch: string[] = [];
    let size = 0;
    for (let i = 0; i < records.length; i++) {
      let line: string;
      try {
        line = JSON.stringify(records[i]);
      } catch {
        this.dropped += 1;
        continue;
      }
      const bytes = Buffer.byteLength(line);
      if (bytes > limits.record) {
        this.dropped += 1;
        continue;
      }
      if (batch.length && size + bytes > limits.batch) {
        this.putBack(records.slice(i)); // the rest waits for the next batch, in order
        break;
      }
      batch.push(line);
      size += bytes;
    }
    return batch;
  }

  /** Calls taken for a batch that didn't fit, back at the front, in order. They are the oldest:
   * when newer calls filled the queue meanwhile, they are the ones dropped, and counted. */
  putBack(rest: Record<string, unknown>[]): void {
    const room = Math.max(this.maxQueue - this.queue.length, 0);
    const keep = rest.slice(rest.length - Math.min(room, rest.length));
    this.dropped += rest.length - keep.length;
    this.queue.unshift(...keep);
  }

  /** Send one batch, retrying a passing failure with backoff; never past `deadline`, when given. */
  private async sendBatch(deadline?: number): Promise<void> {
    const batch = this.take();
    if (!batch.length) return;
    const body = `{"exchanges": [${batch.join(", ")}]}`;
    for (let attempt = 0; ; attempt++) {
      const asked = await this.post(body);
      if (asked === null) {
        this.sent += batch.length;
        return;
      }
      if (asked < 0 || attempt >= retry.times) break;
      const wait = Math.min(Math.max(asked, retry.backoffMs * 2 ** attempt), retry.maxWaitMs);
      if (deadline !== undefined && Date.now() + wait > deadline) break;
      this.retried += 1;
      await retry.sleep(wait);
    }
    this.failed += batch.length;
  }

  /** null when the batch was taken; else how long the server asks us to wait before trying
   * again (0: no preference), or -1 for a failure retrying won't fix. */
  private async post(body: string): Promise<number | null> {
    let response: Response;
    try {
      response = await this.settings.fetch(endpoint(this.settings, "/v1/capture"), {
        method: "POST",
        headers: headers(this.settings),
        body,
      });
    } catch {
      return 0;
    }
    if (response.status === 200) return null;
    if (!PASSING.has(response.status)) return -1;
    const seconds = Number(response.headers?.get?.("retry-after") ?? 0);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  }
}
