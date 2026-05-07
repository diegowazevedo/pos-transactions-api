import { HttpServer } from '@nestjs/common';
import request, { Response } from 'supertest';
import { TestApp, buildTestApp } from './app.factory';
import { signRequest } from './sign';

const SECRET = 'e2e-test-secret-please-replace-1234567890';

function postSigned(server: HttpServer, path: string, body: unknown) {
  const raw = JSON.stringify(body);
  const headers = signRequest({
    secret: SECRET,
    method: 'POST',
    path,
    body: raw,
  });
  return request(server as any)
    .post(path)
    .set('content-type', 'application/json')
    .set('x-signature', headers['x-signature'])
    .set('x-timestamp', headers['x-timestamp'])
    .send(raw);
}

describe('Transactions E2E', () => {
  let ctx: TestApp;
  let server: HttpServer;

  beforeAll(async () => {
    ctx = await buildTestApp();
    server = ctx.app.getHttpServer();
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  beforeEach(async () => {
    await ctx.cleanDatabase();
    await ctx.cleanRedis();
    jest.clearAllMocks();
  });

  describe('POST /v1/pos/transactions/authorize', () => {
    it('rejects requests missing the HMAC headers', async () => {
      await request(server as any)
        .post('/v1/pos/transactions/authorize')
        .send({ terminalId: 'T1', nsu: '0001', amount: '10.00' })
        .expect(401);
    });

    it('rejects tampered bodies', async () => {
      const path = '/v1/pos/transactions/authorize';
      const headers = signRequest({
        secret: SECRET,
        method: 'POST',
        path,
        body: JSON.stringify({ terminalId: 'T1', nsu: '0001', amount: '10.00' }),
      });
      await request(server as any)
        .post(path)
        .set('x-signature', headers['x-signature'])
        .set('x-timestamp', headers['x-timestamp'])
        .send({ terminalId: 'T1', nsu: '0001', amount: '99999.99' })
        .expect(401);
    });

    it('creates a new transaction (201) on first call and replays cached response (200) on retry', async () => {
      ctx.externalApi.authorize.mockResolvedValue({
        externalTransactionId: 'ext-1',
        authCode: 'AUTH-A',
      });

      const body = { terminalId: 'T1', nsu: '0001', amount: '10.00' };
      const path = '/v1/pos/transactions/authorize';

      const first = await postSigned(server, path, body).expect(201);
      expect(first.body.status).toBe('AUTHORIZED');
      expect(first.body.externalAuthCode).toBe('AUTH-A');
      expect(first.body.transactionId).toHaveLength(26);

      const second = await postSigned(server, path, body).expect(200);
      expect(second.body.transactionId).toBe(first.body.transactionId);

      // External API was called exactly once — replay served from cache.
      expect(ctx.externalApi.authorize).toHaveBeenCalledTimes(1);
    });

    it('forwards a deterministic Idempotency-Key to the upstream', async () => {
      ctx.externalApi.authorize.mockResolvedValue({
        externalTransactionId: 'ext-2',
        authCode: 'AUTH-B',
      });
      await postSigned(server, '/v1/pos/transactions/authorize', {
        terminalId: 'T9',
        nsu: '0042',
        amount: '5.00',
      }).expect(201);

      expect(ctx.externalApi.authorize).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: 'T9:0042' }),
      );
    });

    it('returns 502 when the upstream rejects with 4xx', async () => {
      const { ExternalApiClientError } = require('../src/external-api/errors');
      ctx.externalApi.authorize.mockRejectedValue(
        new ExternalApiClientError('rejected', 400, { error: 'invalid' }),
      );
      await postSigned(server, '/v1/pos/transactions/authorize', {
        terminalId: 'T2',
        nsu: '0001',
        amount: '10.00',
      }).expect(502);
    });

    it('returns 503 with Retry-After when the upstream circuit is open', async () => {
      const { CircuitOpenError } = require('../src/external-api/errors');
      ctx.externalApi.authorize.mockRejectedValue(new CircuitOpenError(10_000));

      const res = await postSigned(server, '/v1/pos/transactions/authorize', {
        terminalId: 'T3',
        nsu: '0001',
        amount: '10.00',
      }).expect(503);

      expect(res.headers['retry-after']).toBe('10');
      expect(res.body.error).toBe('UpstreamCircuitOpen');
    });

    it('rejects invalid payloads with 400 and structured error details', async () => {
      const res = await postSigned(server, '/v1/pos/transactions/authorize', {
        terminalId: '',
        nsu: '0001',
        amount: 'not-a-number',
      }).expect(400);
      expect(Array.isArray(res.body.details)).toBe(true);
    });
  });

  describe('Full lifecycle: authorize → confirm → void', () => {
    it('walks the happy path and is idempotent at every step', async () => {
      ctx.externalApi.authorize.mockResolvedValue({
        externalTransactionId: 'ext-99',
        authCode: 'AUTH-99',
      });
      ctx.externalApi.confirm.mockResolvedValue(undefined);
      ctx.externalApi.void.mockResolvedValue(undefined);

      const authorize = await postSigned(
        server,
        '/v1/pos/transactions/authorize',
        { terminalId: 'T7', nsu: '0007', amount: '42.00' },
      ).expect(201);
      const transactionId = authorize.body.transactionId as string;

      // confirm: 204 first time, 204 again on replay (no extra external call)
      await postSigned(server, '/v1/pos/transactions/confirm', {
        transactionId,
      }).expect(204);
      await postSigned(server, '/v1/pos/transactions/confirm', {
        transactionId,
      }).expect(204);
      expect(ctx.externalApi.confirm).toHaveBeenCalledTimes(1);

      // void: 204 first time, 204 again on replay
      await postSigned(server, '/v1/pos/transactions/void', {
        transactionId,
      }).expect(204);
      await postSigned(server, '/v1/pos/transactions/void', {
        transactionId,
      }).expect(204);
      expect(ctx.externalApi.void).toHaveBeenCalledTimes(1);
    });

    it('refuses to confirm a previously voided transaction (409)', async () => {
      ctx.externalApi.authorize.mockResolvedValue({
        externalTransactionId: 'ext-11',
        authCode: 'AUTH-11',
      });
      ctx.externalApi.void.mockResolvedValue(undefined);

      const auth = await postSigned(server, '/v1/pos/transactions/authorize', {
        terminalId: 'T8',
        nsu: '0008',
        amount: '20.00',
      }).expect(201);
      const transactionId = auth.body.transactionId as string;

      await postSigned(server, '/v1/pos/transactions/void', {
        transactionId,
      }).expect(204);

      await postSigned(server, '/v1/pos/transactions/confirm', {
        transactionId,
      }).expect(409);
    });

    it('voids by (terminalId, nsu) when transactionId is unknown to the caller', async () => {
      ctx.externalApi.authorize.mockResolvedValue({
        externalTransactionId: 'ext-22',
        authCode: 'AUTH-22',
      });
      ctx.externalApi.void.mockResolvedValue(undefined);

      await postSigned(server, '/v1/pos/transactions/authorize', {
        terminalId: 'T9',
        nsu: '0009',
        amount: '15.00',
      }).expect(201);

      await postSigned(server, '/v1/pos/transactions/void', {
        terminalId: 'T9',
        nsu: '0009',
      }).expect(204);
    });
  });

  describe('Concurrency / race conditions', () => {
    it('serialises concurrent authorizes for the same (terminalId, nsu) — exactly one external call', async () => {
      // Slow the upstream so requests genuinely overlap.
      ctx.externalApi.authorize.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { externalTransactionId: 'ext-race', authCode: 'AUTH-RACE' };
      });

      const body = { terminalId: 'TR', nsu: '0001', amount: '10.00' };
      const path = '/v1/pos/transactions/authorize';
      const responses = await Promise.all([
        postSigned(server, path, body),
        postSigned(server, path, body),
        postSigned(server, path, body),
      ]);

      // External upstream called exactly once.
      expect(ctx.externalApi.authorize).toHaveBeenCalledTimes(1);

      // All responses point to the same transactionId.
      const ids = new Set(responses.map((r: Response) => r.body.transactionId));
      expect(ids.size).toBe(1);

      // Status mix: one 201 (creator) plus 200/409 for the runners-up
      // (depending on whether they hit the cache or the lock-busy fallback).
      const statuses = responses.map((r: Response) => r.status).sort();
      expect(statuses).toContain(201);
      statuses
        .filter((s: number) => s !== 201)
        .forEach((s: number) => expect([200, 409]).toContain(s));
    });
  });
});
