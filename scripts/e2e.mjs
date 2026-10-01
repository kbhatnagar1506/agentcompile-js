// End to end: the built SDK against a real AgentCompile server on 127.0.0.1:8791.
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { conversation, flush, wrap } from "../dist/index.js";

const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fakeModel = async (input, init) => {
  const body = JSON.parse(init.body);
  if (String(input).endsWith("/messages")) {
    return reply({ id: "m1", type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text: "anthropic model says hi" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } });
  }
  const turns = body.messages.filter((m) => m.role === "assistant").length;
  const message = turns === 0
    ? { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "get_order_details", arguments: '{"order_id":"#W1"}' } }] }
    : { role: "assistant", content: "Your order #W1 is pending." };
  return reply({ id: `c${turns}`, object: "chat.completion", created: 0, model: body.model,
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] });
};
const events = [];
const opts = { key: "ack_acme.secret", baseUrl: "http://127.0.0.1:8791", capture: true, trail: false, onEvent: (e) => events.push(e) };
const oa = wrap(new OpenAI({ apiKey: "sk", baseURL: "http://provider.test/v1", fetch: fakeModel }), opts);
const an = wrap(new Anthropic({ apiKey: "sk", baseURL: "http://provider.test", fetch: fakeModel }), opts);

await conversation("e2e-openai-1", async () => {
  const history = [{ role: "user", content: "where is order #W1?" }];
  const first = await oa.chat.completions.create({ model: "gpt-x", messages: history });
  history.push(first.choices[0].message, { role: "tool", tool_call_id: "t1", content: '{"order_id":"#W1","status":"pending"}' });
  await oa.chat.completions.create({ model: "gpt-x", messages: history });
});
await an.messages.create({ model: "claude-x", max_tokens: 50, messages: [{ role: "user", content: "hi" }], conversation_id: "e2e-anthropic-1" });
await flush();
console.log(JSON.stringify({ routes: events.map((e) => e.route), reasons: events.map((e) => e.reason) }));
