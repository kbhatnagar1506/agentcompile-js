// Requests a compiled answer can't honour, and tools the agent didn't offer: both go to the
// model.

/** Why a compiled answer couldn't honour this request (then it goes to the model, and no
 * decision is asked for): several answers, a forced or forbidden tool, a fixed output shape. */
export function unsupported(params: Record<string, unknown>): string | undefined {
  const n = params.n;
  if (n !== undefined && n !== null && n !== 1) return "n";
  if (params.functions !== undefined && params.functions !== null) return "functions";
  const shape = params.response_format as { type?: unknown } | undefined | null;
  if (shape !== undefined && shape !== null && !(typeof shape === "object" && shape.type === "text")) {
    return "response_format";
  }
  const choice = params.tool_choice as { type?: unknown } | string | undefined | null;
  const auto =
    choice === undefined || choice === null || choice === "auto" || (typeof choice === "object" && choice.type === "auto");
  return auto ? undefined : "tool_choice";
}

/** Whether the request offers `tool` (OpenAI's {function: {name}}, or a top-level name). */
export function offered(params: Record<string, unknown>, tool: string | undefined): boolean {
  const tools = Array.isArray(params.tools) ? params.tools : [];
  return tools.some((spec) => {
    if (!spec || typeof spec !== "object") return false;
    const s = spec as { name?: unknown; function?: { name?: unknown } };
    const name = s.function && typeof s.function === "object" ? s.function.name : s.name;
    return name === tool;
  });
}
