// Scrubbing on your machine: personal data in captured calls becomes keyed tokens before
// anything is sent (on by default with capture; `wrap(client, { scrub: false })` turns it off).
//
// The same rules and token format as AgentCompile's server and the Python SDK
// (`<email:3f9a1c2e>`: the first 8 hex characters of HMAC-SHA256(key, normalized value)),
// checked against shared vectors, so the same value always becomes the same token. Emails
// always; payment cards (13-19 digits passing Luhn); phone-shaped numbers; values under keys
// that name a card, phone or account outright. Ids are left alone.
//
// The key never leaves your machine: AGENTCOMPILE_SCRUB_KEY (set the same one on every server),
// else a random key created once in ~/.agentcompile/scrub.key (owner-only).

import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Python's \w in a str is Unicode-aware: [\p{L}\p{N}_] here, with the u flag.
const W = "[\\p{L}\\p{N}_]";
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CARD = /(?<![\d-])(?:\d{13,19}|\d{4}(?:[ -]\d{4}){2,3}(?:[ -]\d{1,3})?)(?![\d-])/g;
const PHONE = new RegExp(
  `(?<!(?:${W}|\\+))(?:` +
    "\\+\\d{1,3}[ .-]?(?:\\(\\d{1,4}\\)[ .-]?)?\\d{2,4}(?:[ .-]\\d{2,4}){1,4}" +
    "|\\+\\d{10,15}" +
    "|\\(\\d{3}\\)[ .-]?\\d{3}[ .-]\\d{4}" +
    "|\\d{3}[.-]\\d{3}[.-]\\d{4}" +
    `)(?!${W})`,
  "gu",
);
const ID_KEY = /(^|_)(id|ids|number|no|sku|code|ref|reference|timestamp|ts)$/i;
const PHONE_KEY = /(phone|mobile|cell|tel|fax|whatsapp)/i;
const ACCOUNT_KEY =
  /(account_?(number|no|num)|accountnumber|iban|routing|sort_?code|ssn|social_?security)/i;

export function loadScrubKey(): Buffer {
  const env = process.env.AGENTCOMPILE_SCRUB_KEY;
  if (env) return Buffer.from(env);
  const path = join(process.env.AGENTCOMPILE_HOME ?? join(homedir(), ".agentcompile"), "scrub.key");
  try {
    return Buffer.from(readFileSync(path, "utf8").trim());
  } catch {
    mkdirSync(join(path, ".."), { recursive: true });
    const key = randomBytes(32).toString("hex");
    try {
      writeFileSync(path, key, { mode: 0o600, flag: "wx" });
    } catch {
      return Buffer.from(readFileSync(path, "utf8").trim()); // another process made it first
    }
    return Buffer.from(key);
  }
}

const token = (kind: string, normalized: string, key: Buffer) =>
  `<${kind}:${createHmac("sha256", key).update(normalized).digest("hex").slice(0, 8)}>`;

const digitsOf = (s: string) => s.replace(/\D/g, "");

function luhnOk(digits: string): boolean {
  let total = 0;
  [...digits].reverse().forEach((ch, i) => {
    let d = Number(ch);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  });
  return total % 10 === 0;
}

export function scrubText(text: string, key: Buffer, numbers = true): string {
  let out = text.replace(EMAIL, (m) => token("email", m.trim().toLowerCase(), key));
  if (!numbers) return out;
  out = out.replace(CARD, (m) => {
    const d = digitsOf(m);
    return d.length >= 13 && d.length <= 19 && luhnOk(d) ? token("card", d, key) : m;
  });
  return out.replace(PHONE, (m) => {
    const d = digitsOf(m);
    return d.length >= 10 && d.length <= 15 ? token("phone", d, key) : m;
  });
}

const hasEmail = (s: string) => new RegExp(EMAIL.source).test(s);

function phoneField(value: string, key: Buffer): string {
  const d = digitsOf(value);
  return d.length >= 7 && d.length <= 15 && !hasEmail(value) ? token("phone", d, key) : scrubText(value, key);
}

function isCardField(field: string): boolean {
  const words = new Set((field.match(/[A-Za-z][a-z]*/g) ?? []).map((w) => w.toLowerCase()));
  return !!field && ["card", "cc", "pan"].some((w) => words.has(w));
}

function sensitiveField(value: unknown, field: string, key: Buffer): string | null {
  const raw = typeof value === "number" ? pyNumber(value) : value;
  if (typeof raw !== "string" || !field) return null;
  const d = digitsOf(raw);
  if (ACCOUNT_KEY.test(field) && d.length >= 4) return token("account", d, key);
  if (isCardField(field) && d.length >= 13 && d.length <= 19 && luhnOk(d)) return token("card", d, key);
  if (PHONE_KEY.test(field) && d.length >= 7 && d.length <= 15 && !hasEmail(raw)) return token("phone", d, key);
  return null;
}

export function scrubValue(value: unknown, key: Buffer, field = ""): unknown {
  const sensitive = sensitiveField(value, field, key);
  if (sensitive !== null) return sensitive;
  if (typeof value === "string") {
    if (field && PHONE_KEY.test(field)) return phoneField(value, key);
    const idLike = !!field && ID_KEY.test(field) && !isCardField(field);
    return scrubText(value, key, !idLike);
  }
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, key, field));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v, key, k)]));
  }
  return value;
}

/** A tool result or arguments string: JSON scrubbed field by field, text as text. */
export function scrubToolOutput(output: string, key: Buffer): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return scrubText(output, key);
  }
  const spaced = output.includes(", ") || output.includes(": ");
  return pyDumps(scrubValue(parsed, key), spaced ? ", " : ",", spaced ? ": " : ":");
}

/** A captured request or answer: every string scrubbed; a string holding JSON (tool
 * arguments, tool results) scrubbed as JSON, field names included. */
export function scrubCall(value: unknown, key: Buffer, field = ""): unknown {
  if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
    return scrubToolOutput(value, key);
  }
  if (Array.isArray(value)) return value.map((v) => scrubCall(v, key, field));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubCall(v, key, k)]));
  }
  return scrubValue(value, key, field);
}

// Python's json.dumps (ensure_ascii), so a re-written tool output is byte-identical to the
// server's and the Python SDK's.
function pyDumps(v: unknown, item: string, kv: string): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return pyNumber(v);
  if (typeof v === "string") return pyString(v);
  if (Array.isArray(v)) return `[${v.map((x) => pyDumps(x, item, kv)).join(item)}]`;
  return `{${Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => `${pyString(k)}${kv}${pyDumps(x, item, kv)}`)
    .join(item)}}`;
}

function pyNumber(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? "Infinity" : n < 0 ? "-Infinity" : "NaN";
  return String(n);
}

function pyString(s: string): string {
  const escaped = JSON.stringify(s).slice(1, -1);
  return `"${escaped.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}
