import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import * as crypto from 'crypto';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { RedisService } from '../../redis/redis.service';
import { HmacGuard } from './hmac.guard';

const SECRET = 'super-secret-test-key-1234567890';
const TOLERANCE = 300;

function buildSignature(
  method: string,
  path: string,
  body: string,
  timestamp: string,
  secret = SECRET,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${method.toUpperCase()}.${path}.${body}`)
    .digest('hex');
}

function makeContext(opts: {
  method?: string;
  path?: string;
  body?: string;
  headers?: Record<string, string>;
}): ExecutionContext {
  const req = {
    method: opts.method ?? 'POST',
    originalUrl: opts.path ?? '/v1/pos/transactions/authorize',
    headers: opts.headers ?? {},
    rawBody: Buffer.from(opts.body ?? ''),
  };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function makeGuard(skip = false) {
  const config = {
    getOrThrow: (key: string) => {
      if (key === 'hmac.secret') return SECRET;
      if (key === 'hmac.timestampToleranceSeconds') return TOLERANCE;
      throw new Error(`unexpected key ${key}`);
    },
  } as unknown as ConfigService;

  const reflector = {
    getAllAndOverride: () => skip,
  } as unknown as Reflector;

  const client = new RedisMock() as unknown as Redis;
  const redisService = new RedisService(client);

  return new HmacGuard(config, reflector, redisService);
}

describe('HmacGuard', () => {
  it('allows requests when @SkipHmac() is set', async () => {
    const guard = makeGuard(true);
    const ctx = makeContext({ headers: {} });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects when X-Signature or X-Timestamp is missing', async () => {
    const guard = makeGuard();
    const ctx = makeContext({ headers: {} });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects timestamps outside tolerance window', async () => {
    const guard = makeGuard();
    const stale = String(Math.floor(Date.now() / 1000) - TOLERANCE - 10);
    const sig = buildSignature('POST', '/x', '', stale);
    const ctx = makeContext({
      path: '/x',
      headers: { 'x-signature': sig, 'x-timestamp': stale },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(
      /tolerance/i,
    );
  });

  it('accepts a correctly signed request', async () => {
    const guard = makeGuard();
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{"foo":"bar"}';
    const sig = buildSignature('POST', '/v1/x', body, ts);
    const ctx = makeContext({
      method: 'POST',
      path: '/v1/x',
      body,
      headers: { 'x-signature': sig, 'x-timestamp': ts },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects a tampered body', async () => {
    const guard = makeGuard();
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = buildSignature('POST', '/v1/x', 'original', ts);
    const ctx = makeContext({
      method: 'POST',
      path: '/v1/x',
      body: 'tampered',
      headers: { 'x-signature': sig, 'x-timestamp': ts },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(/signature/i);
  });

  it('rejects a request signed with the wrong secret', async () => {
    const guard = makeGuard();
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = buildSignature('POST', '/v1/x', '', ts, 'other-secret');
    const ctx = makeContext({
      method: 'POST',
      path: '/v1/x',
      headers: { 'x-signature': sig, 'x-timestamp': ts },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(/signature/i);
  });

  it('rejects replays of a previously seen signature', async () => {
    const guard = makeGuard();
    const ts = String(Math.floor(Date.now() / 1000));
    const body = 'payload';
    const sig = buildSignature('POST', '/v1/x', body, ts);
    const make = () =>
      makeContext({
        method: 'POST',
        path: '/v1/x',
        body,
        headers: { 'x-signature': sig, 'x-timestamp': ts },
      });

    await expect(guard.canActivate(make())).resolves.toBe(true);
    await expect(guard.canActivate(make())).rejects.toThrow(/replay/i);
  });
});
