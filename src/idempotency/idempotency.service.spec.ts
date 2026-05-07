import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { RedisService } from '../redis/redis.service';
import { IdempotencyService, LockBusyError } from './idempotency.service';

function makeService(): { service: IdempotencyService; client: Redis } {
  const client = new RedisMock() as unknown as Redis;
  const redisService = new RedisService(client);
  const service = new IdempotencyService(redisService);
  return { service, client };
}

describe('IdempotencyService', () => {
  describe('acquireLock / releaseLock', () => {
    it('grants the lock to the first caller and rejects the second', async () => {
      const { service } = makeService();

      const first = await service.acquireLock('order-1', { ttlSeconds: 30 });
      const second = await service.acquireLock('order-1', { ttlSeconds: 30 });

      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });

    it('releases the lock so a subsequent caller can acquire it', async () => {
      const { service } = makeService();

      const token = await service.acquireLock('order-2', { ttlSeconds: 30 });
      expect(token).not.toBeNull();

      const released = await service.releaseLock('order-2', token!);
      expect(released).toBe(true);

      const retake = await service.acquireLock('order-2', { ttlSeconds: 30 });
      expect(retake).not.toBeNull();
    });

    it('refuses to release a lock owned by another worker', async () => {
      const { service } = makeService();

      await service.acquireLock('order-3', { ttlSeconds: 30 });
      const released = await service.releaseLock('order-3', 'wrong-token');

      expect(released).toBe(false);
    });
  });

  describe('runOnce', () => {
    it('returns the cached response on the second call without re-running the producer', async () => {
      const { service } = makeService();
      const producer = jest.fn().mockResolvedValue({
        status: 201,
        body: { transactionId: 'tx-abc' },
      });

      const first = await service.runOnce('terminal-1:nsu-1', producer, {
        lockTtlSeconds: 30,
        cacheTtlSeconds: 3600,
      });
      const second = await service.runOnce('terminal-1:nsu-1', producer, {
        lockTtlSeconds: 30,
        cacheTtlSeconds: 3600,
      });

      expect(producer).toHaveBeenCalledTimes(1);
      expect(first).toEqual(second);
      expect(first.body).toEqual({ transactionId: 'tx-abc' });
    });

    it('throws LockBusyError when another worker holds the lock and no cache appears', async () => {
      const { service } = makeService();
      await service.acquireLock('terminal-1:nsu-2', { ttlSeconds: 30 });

      await expect(
        service.runOnce(
          'terminal-1:nsu-2',
          async () => ({ status: 200, body: {} }),
          { lockTtlSeconds: 30, cacheTtlSeconds: 60 },
        ),
      ).rejects.toBeInstanceOf(LockBusyError);
    });

    it('does not cache the response when the producer throws', async () => {
      const { service } = makeService();
      const failing = jest.fn().mockRejectedValue(new Error('external down'));

      await expect(
        service.runOnce('terminal-1:nsu-3', failing, {
          lockTtlSeconds: 30,
          cacheTtlSeconds: 60,
        }),
      ).rejects.toThrow('external down');

      const cached = await service.getCachedResponse('terminal-1:nsu-3');
      expect(cached).toBeNull();
    });
  });
});
