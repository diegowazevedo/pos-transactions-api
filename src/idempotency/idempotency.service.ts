import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from '../redis/redis.service';

export interface AcquireOptions {
  /** Lock TTL in seconds. Should exceed the worst-case operation latency. */
  ttlSeconds: number;
}

export interface CachedResponse<T> {
  status: number;
  body: T;
}

const RELEASE_LOCK_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Tries to acquire a distributed lock. Returns the owner token on success,
   * or null if another worker already holds the lock.
   */
  async acquireLock(
    key: string,
    opts: AcquireOptions,
  ): Promise<string | null> {
    const token = randomUUID();
    const result = await this.redis.client.set(
      this.lockKey(key),
      token,
      'EX',
      opts.ttlSeconds,
      'NX',
    );
    return result === 'OK' ? token : null;
  }

  /**
   * Releases the lock atomically — only if the caller still owns it.
   * Avoids the classic "release someone else's lock after my TTL expired" bug.
   */
  async releaseLock(key: string, token: string): Promise<boolean> {
    const released = (await this.redis.client.eval(
      RELEASE_LOCK_LUA,
      1,
      this.lockKey(key),
      token,
    )) as number;
    return released === 1;
  }

  async getCachedResponse<T>(key: string): Promise<CachedResponse<T> | null> {
    const raw = await this.redis.client.get(this.cacheKey(key));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CachedResponse<T>;
    } catch (err) {
      this.logger.warn(`Corrupt idempotency cache for ${key}: ${String(err)}`);
      return null;
    }
  }

  async setCachedResponse<T>(
    key: string,
    response: CachedResponse<T>,
    ttlSeconds: number,
  ): Promise<void> {
    await this.redis.client.set(
      this.cacheKey(key),
      JSON.stringify(response),
      'EX',
      ttlSeconds,
    );
  }

  /**
   * High-level helper that wraps the full idempotency flow:
   *  1. Returns the cached response if one already exists.
   *  2. Acquires a distributed lock to keep concurrent callers from racing.
   *  3. Re-checks the cache after acquiring the lock (double-checked locking).
   *  4. Runs the producer, caches the result, releases the lock.
   *
   * If the lock cannot be acquired AND no cached response shows up while
   * waiting briefly, a `LockBusyError` is thrown so the caller can decide
   * how to surface it (typically 409 or retry-after).
   */
  async runOnce<T>(
    key: string,
    producer: () => Promise<CachedResponse<T>>,
    opts: { lockTtlSeconds: number; cacheTtlSeconds: number },
  ): Promise<CachedResponse<T>> {
    const cached = await this.getCachedResponse<T>(key);
    if (cached) return cached;

    const token = await this.acquireLock(key, {
      ttlSeconds: opts.lockTtlSeconds,
    });
    if (!token) {
      const fromPeer = await this.waitForCachedResponse<T>(key, 2000);
      if (fromPeer) return fromPeer;
      throw new LockBusyError(key);
    }

    try {
      const recheck = await this.getCachedResponse<T>(key);
      if (recheck) return recheck;

      const response = await producer();
      await this.setCachedResponse(key, response, opts.cacheTtlSeconds);
      return response;
    } finally {
      await this.releaseLock(key, token).catch((err) => {
        this.logger.warn(`Failed to release lock ${key}: ${String(err)}`);
      });
    }
  }

  private async waitForCachedResponse<T>(
    key: string,
    maxWaitMs: number,
  ): Promise<CachedResponse<T> | null> {
    const deadline = Date.now() + maxWaitMs;
    const intervalMs = 100;
    while (Date.now() < deadline) {
      const cached = await this.getCachedResponse<T>(key);
      if (cached) return cached;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return null;
  }

  private lockKey(key: string): string {
    return `idem:lock:${key}`;
  }

  private cacheKey(key: string): string {
    return `idem:cache:${key}`;
  }
}

export class LockBusyError extends Error {
  constructor(public readonly key: string) {
    super(`Idempotency lock busy for key=${key}`);
    this.name = 'LockBusyError';
  }
}
