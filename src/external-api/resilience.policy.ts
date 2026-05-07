import { Logger } from '@nestjs/common';
import {
  BrokenCircuitError,
  BulkheadRejectedError as CockatielBulkheadRejected,
  ConsecutiveBreaker,
  ExponentialBackoff,
  IPolicy,
  TaskCancelledError,
  bulkhead,
  circuitBreaker,
  handleType,
  retry,
  timeout,
  TimeoutStrategy,
  wrap,
} from 'cockatiel';
import {
  BulkheadRejectedError,
  CircuitOpenError,
  ExternalApiError,
  ExternalApiTimeoutError,
  ExternalApiTransientError,
} from './errors';

export interface ResilienceConfig {
  timeoutMs: number;
  retry: {
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
  };
  breaker: {
    consecutiveFailures: number;
    halfOpenAfterMs: number;
  };
  bulkhead: {
    maxConcurrent: number;
    maxQueue: number;
  };
}

export interface ResiliencePolicy {
  policy: IPolicy;
  remap: (err: unknown) => Error;
  isCircuitOpen: () => boolean;
}

/**
 * Builds the composed resilience pipeline:
 *
 *   bulkhead  →  circuitBreaker  →  retry  →  timeout  →  fn()
 *
 * - bulkhead OUTER: caps total concurrent + queued in-flight calls
 * - breaker: short-circuits when the upstream is unhealthy
 * - retry: only on transient errors, with exponential backoff + jitter
 * - timeout INNER: enforces per-attempt deadline (so retry can fire on hang)
 */
export function buildResiliencePolicy(
  cfg: ResilienceConfig,
  logger?: Logger,
): ResiliencePolicy {
  const handleTransient = handleType(ExternalApiTransientError);

  const timeoutPolicy = timeout(cfg.timeoutMs, TimeoutStrategy.Aggressive);

  const retryPolicy = retry(handleTransient, {
    // cockatiel `maxAttempts` means *additional* attempts after the first
    maxAttempts: cfg.retry.maxAttempts,
    backoff: new ExponentialBackoff({
      initialDelay: cfg.retry.initialDelayMs,
      maxDelay: cfg.retry.maxDelayMs,
    }),
  });

  const breakerPolicy = circuitBreaker(handleTransient, {
    halfOpenAfter: cfg.breaker.halfOpenAfterMs,
    breaker: new ConsecutiveBreaker(cfg.breaker.consecutiveFailures),
  });

  const bulkheadPolicy = bulkhead(
    cfg.bulkhead.maxConcurrent,
    cfg.bulkhead.maxQueue,
  );

  if (logger) {
    breakerPolicy.onBreak(() =>
      logger.warn(
        `Circuit OPEN — upstream considered unhealthy (after ${cfg.breaker.consecutiveFailures} consecutive failures)`,
      ),
    );
    breakerPolicy.onHalfOpen(() =>
      logger.log('Circuit HALF-OPEN — probing upstream'),
    );
    breakerPolicy.onReset(() => logger.log('Circuit CLOSED — upstream healthy'));
    retryPolicy.onRetry(({ attempt, delay }) =>
      logger.warn(`Retry attempt #${attempt} after ${delay}ms`),
    );
  }

  const policy = wrap(bulkheadPolicy, breakerPolicy, retryPolicy, timeoutPolicy);

  const remap = (err: unknown): Error => {
    if (err instanceof ExternalApiError) return err;
    if (err instanceof BrokenCircuitError) {
      return new CircuitOpenError(cfg.breaker.halfOpenAfterMs);
    }
    if (err instanceof CockatielBulkheadRejected) {
      return new BulkheadRejectedError();
    }
    if (err instanceof TaskCancelledError) {
      return new ExternalApiTimeoutError(cfg.timeoutMs);
    }
    if (err instanceof Error) return err;
    return new ExternalApiError(String(err));
  };

  return {
    policy,
    remap,
    isCircuitOpen: () => breakerPolicy.state === 1, // 1 === Open in cockatiel
  };
}
