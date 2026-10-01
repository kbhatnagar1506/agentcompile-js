// The conversation id: a `conversationId` on create(), or a block run inside conversation().

import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<{ id: string; customer?: string }>();

/** Every model call made inside `fn` (awaited or not) belongs to this conversation, and
 * optionally to this customer (a stable id for the person, so repeat jobs are counted per
 * customer):
 *
 *    await conversation(ticket.id, () => runAgent(ticket), { customer: ticket.customerId });
 */
export function conversation<T>(
  conversationId: string,
  fn: () => T,
  options: { customer?: string } = {},
): T {
  return store.run({ id: conversationId, customer: options.customer }, fn);
}

export function currentConversation(): string | undefined {
  return store.getStore()?.id;
}

export function currentCustomer(): string | undefined {
  return store.getStore()?.customer;
}
