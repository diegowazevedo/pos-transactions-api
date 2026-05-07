import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  correlationId: string;
  /** Optional fields populated as the request progresses through the stack. */
  terminalId?: string;
  nsu?: string;
  transactionId?: string;
}

/**
 * Per-request scoped context. Anything we want to propagate (correlation id,
 * IDs of the current transaction, etc.) without threading it through every
 * function signature lives here.
 */
export const correlationStorage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return correlationStorage.getStore();
}

export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}

/** Mutates the current context (no-op if there is no active request). */
export function enrichRequestContext(patch: Partial<RequestContext>): void {
  const ctx = correlationStorage.getStore();
  if (ctx) Object.assign(ctx, patch);
}
