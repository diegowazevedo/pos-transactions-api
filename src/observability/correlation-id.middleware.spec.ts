import { Request, Response } from 'express';
import {
  CORRELATION_HEADER,
  CorrelationIdMiddleware,
} from './correlation-id.middleware';
import {
  enrichRequestContext,
  getCorrelationId,
  getRequestContext,
} from './correlation.context';

function makeReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

function makeRes() {
  const headers: Record<string, string> = {};
  return {
    res: {
      setHeader: (name: string, value: string) => {
        headers[name.toLowerCase()] = value;
      },
    } as unknown as Response,
    headers,
  };
}

describe('CorrelationIdMiddleware', () => {
  const middleware = new CorrelationIdMiddleware();

  it('reuses an incoming X-Correlation-Id and exposes it on the response', (done) => {
    const req = makeReq({ [CORRELATION_HEADER]: 'caller-supplied-123' });
    const { res, headers } = makeRes();

    middleware.use(req, res, () => {
      expect(getCorrelationId()).toBe('caller-supplied-123');
      expect(headers[CORRELATION_HEADER]).toBe('caller-supplied-123');
      done();
    });
  });

  it('generates a correlation id when none is provided', (done) => {
    const req = makeReq();
    const { res, headers } = makeRes();

    middleware.use(req, res, () => {
      const generated = getCorrelationId();
      expect(generated).toBeDefined();
      expect(generated).toHaveLength(26); // ULID
      expect(headers[CORRELATION_HEADER]).toBe(generated);
      done();
    });
  });

  it('isolates contexts between concurrent requests', async () => {
    const seen: string[] = [];
    const run = (id: string) =>
      new Promise<void>((resolve) => {
        const req = makeReq({ [CORRELATION_HEADER]: id });
        const { res } = makeRes();
        middleware.use(req, res, async () => {
          // Yield to make sure the two contexts overlap
          await new Promise((r) => setImmediate(r));
          seen.push(getCorrelationId() ?? 'missing');
          resolve();
        });
      });

    await Promise.all([run('A'), run('B'), run('C')]);
    expect(seen.sort()).toEqual(['A', 'B', 'C']);
  });

  it('lets downstream code enrich the context (terminalId, transactionId, …)', (done) => {
    const req = makeReq({ [CORRELATION_HEADER]: 'corr-1' });
    const { res } = makeRes();

    middleware.use(req, res, () => {
      enrichRequestContext({ terminalId: 'T9', nsu: '0042' });
      const ctx = getRequestContext();
      expect(ctx).toMatchObject({
        correlationId: 'corr-1',
        terminalId: 'T9',
        nsu: '0042',
      });
      done();
    });
  });

  it('returns undefined outside of a request scope', () => {
    expect(getCorrelationId()).toBeUndefined();
    expect(getRequestContext()).toBeUndefined();
  });
});
