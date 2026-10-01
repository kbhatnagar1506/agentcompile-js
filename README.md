# agentcompile

Wrap your agent's model client. AgentCompile finds the jobs your agent repeats, compiles them
into verified routines, and answers those calls without a model call. Everything else goes to
your model unchanged, with your own provider key.

```bash
npm install agentcompile
```

```ts
import OpenAI from "openai";
import { wrap, conversation } from "agentcompile";

const client = wrap(new OpenAI(), { key: process.env.AGENTCOMPILE_KEY });

// Every model call your agent makes inside this block belongs to one conversation:
await conversation(ticket.id, () => runAgent(client, ticket));
```

Works the same with Anthropic:

```ts
import Anthropic from "@anthropic-ai/sdk";
const client = wrap(new Anthropic(), { key: process.env.AGENTCOMPILE_KEY });
```

## What happens on each call

| Route | When | Your model called? |
| --- | --- | --- |
| `compiled` | A known job: AgentCompile answers with a verified routine's next step | No |
| `forwarded` | Anything else | Yes, unchanged, your key |
| `fail-open` | AgentCompile is slow (over `timeoutMs`) or unreachable | Yes |
| `shadow` | `mode: "shadow"`: AgentCompile decides, but your model always answers | Yes |
| `no-conversation` | No conversation id | Yes |

Compiled answers have exactly the shape of `chat.completions.create()` or `messages.create()`,
streamed or not, so your agent loop doesn't change. Your provider key never reaches us.

## Options

| Option | Default | |
| --- | --- | --- |
| `key` | `AGENTCOMPILE_KEY` | Your AgentCompile key (`ack_<company>.<secret>`) |
| `baseUrl` | `AGENTCOMPILE_URL` or `https://api.tryagentcompile.com` | |
| `mode` | `"live"` | `"shadow"` to watch without acting |
| `timeoutMs` | `2000` | Wait this long for a decision, then fail open |
| `trail` | `true` | `~/.agentcompile/trail.jsonl`, a path, or `false` |
| `onEvent` | | Called with each trail event |
| `capture` | `false` (or `AGENTCOMPILE_CAPTURE=1`) | Send each call's request and answer so AgentCompile can find repeated jobs. Sent in the background; never slows a call |

The conversation id can also be passed per call as `conversationId` (or `conversation_id`).
Call `await flush()` before a short script exits to send captured calls still queued.

## Requirements

Node 20 or newer (uses the built-in `fetch`). Works with `openai` and `@anthropic-ai/sdk`, and
any client shaped like them. ESM and CommonJS.

## License

Apache-2.0

## Privacy

With `capture: true`, personal data is scrubbed on your machine before anything is sent:
emails, payment cards, phone numbers and account numbers become keyed tokens
(`<email:3f9a1c2e>`), the same value always giving the same token, so AgentCompile can still
match values across a conversation without seeing them. The key stays with you:
`AGENTCOMPILE_SCRUB_KEY` (set the same one on all your servers), else one created once in
`~/.agentcompile/scrub.key`. `scrub: false` turns it off. Live decisions (`/v1/decide`) need
real values to act on a customer's request; they are used in memory and stored scrubbed.
