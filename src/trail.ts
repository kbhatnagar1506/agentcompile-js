// The trail: one JSON line per model call, so you can see what AgentCompile did with each one.
// Routes: compiled, forwarded, fail-open, shadow, no-conversation.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type OnEvent = (event: Record<string, unknown>) => void;

export function defaultTrailPath(): string {
  return process.env.AGENTCOMPILE_TRAIL ?? join(homedir(), ".agentcompile", "trail.jsonl");
}

export class Trail {
  readonly path: string | null;
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
        appendFileSync(this.path, `${JSON.stringify(event)}\n`);
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
