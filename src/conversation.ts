// The conversation id: a `conversationId` on create(), or a block run inside conversation().

import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string>();

/** Every model call made inside `fn` (awaited or not) belongs to this conversation:
 *
 *    await conversation(ticket.id, () => runAgent(ticket));
 */
export function conversation<T>(conversationId: string, fn: () => T): T {
  return store.run(conversationId, fn);
}

export function currentConversation(): string | undefined {
  return store.getStore();
}
