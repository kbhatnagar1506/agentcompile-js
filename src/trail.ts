// The trail: one JSON line per model call, so you can see what AgentCompile did with each one.
// Routes: compiled, forwarded, fail-open, shadow, no-conversation, unsupported (a request a
// compiled answer couldn't honour: sent to your model without asking).
// Kept under 10 MB: past that the file moves to trail.jsonl.1 (replacing the one before).

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type OnEvent = (event: Record<string, unknown>) => void;

export function defaultTrailPath(): string {
  return process.env.AGENTCOMPILE_TRAIL ?? join(homedir(), ".agentcompile", "trail.jsonl");
}

export const MAX_TRAIL_BYTES = 10 * 1024 * 1024;

export class Trail {
  readonly path: string | null;
  maxBytes = MAX_TRAIL_BYTES;
  private size: number | null = null;
  constructor(
    path: string | boolean = true,
    private readonly onEvent?: OnEvent,
  ) {
    this.path = path === true ? defaultTrailPath() : path === false ? null : path;
  }

  record(fields: Record<string, unknown>): Record<string, unknown> {
    const event: Record<string, unknown> = { ts: Math.round(Date.now()) / 1000 };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) event[k] = v;
    if (this.path) {
      try {
        mkdirSync(dirname(this.path), { recursive: true });
        if (this.size === null) this.size = sizeOf(this.path);
        const line = `${JSON.stringify(event)}\n`;
        appendFileSync(this.path, line);
        this.size += Buffer.byteLength(line);
        if (this.size > this.maxBytes) {
          renameSync(this.path, `${this.path}.1`);
          this.size = 0;
        }
      } catch {
        // the trail never breaks the agent
      }
    }
    try {
      this.onEvent?.(event);
    } catch {
      // nor does a callback
    }
    return event;
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
