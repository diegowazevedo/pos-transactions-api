import { ConfigService } from '@nestjs/config';
import {
  CircuitOpenError,
  ExternalApiClientError,
  ExternalApiTimeoutError,
  ExternalApiTransientError,
} from './errors';
import { ExternalApiClient, FetchFn } from './external-api.client';

interface ConfigOverrides {
  retryMaxAttempts?: number;
  breakerConsecutiveFailures?: number;
  timeoutMs?: number;
}

function makeConfig(overrides: ConfigOverrides = {}): ConfigService {
  const values: Record<string, unknown> = {
    'externalApi.url': 'http://upstream.test',
    'externalApi.timeoutMs': overrides.timeoutMs ?? 1000,
    'externalApi.retry': {
      maxAttempts: overrides.retryMaxAttempts ?? 0,
      initialDelayMs: 10,
      maxDelayMs: 50,
    },
    'externalApi.breaker': {
      consecutiveFailures: overrides.breakerConsecutiveFailures ?? 5,
      halfOpenAfterMs: 1000,
    },
    'externalApi.bulkhead': {
      maxConcurrent: 10,
      maxQueue: 20,
    },
  };
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error(`missing config ${key}`);
      return values[key];
    },
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const REQ = {
  idempotencyKey: 'idem-1',
  terminalId: 'T1',
  nsu: '0001',
  amount: '10.00',
  currency: 'BRL',
};

describe('ExternalApiClient', () => {
  it('returns the parsed body on 2xx and forwards the idempotency-key header', async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse({ externalTransactionId: 'ext-1', authCode: 'A1' }),
    ) as unknown as FetchFn;
    const client = new ExternalApiClient(makeConfig(), fetchMock);

    const result = await client.authorize(REQ);

    expect(result).toEqual({ externalTransactionId: 'ext-1', authCode: 'A1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = (fetchMock as jest.Mock).mock.calls[0];
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe('idem-1');
  });

  it('throws a client error on 4xx without retrying', async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse({ error: 'invalid_amount' }, 400),
    ) as unknown as FetchFn;
    const client = new ExternalApiClient(
      makeConfig({ retryMaxAttempts: 3 }),
      fetchMock,
    );

    await expect(client.authorize(REQ)).rejects.toBeInstanceOf(
      ExternalApiClientError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx and surfaces a transient error after exhausting attempts', async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse({ error: 'upstream_down' }, 503),
    ) as unknown as FetchFn;
    const client = new ExternalApiClient(
      makeConfig({ retryMaxAttempts: 2, breakerConsecutiveFailures: 100 }),
      fetchMock,
    );

    await expect(client.authorize(REQ)).rejects.toBeInstanceOf(
      ExternalApiTransientError,
    );
    // 1 initial + 2 retries = 3 calls
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('classifies a network failure as transient and retries it', async () => {
    const fetchMock = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as FetchFn;
    const client = new ExternalApiClient(
      makeConfig({ retryMaxAttempts: 1, breakerConsecutiveFailures: 100 }),
      fetchMock,
    );

    await expect(client.authorize(REQ)).rejects.toBeInstanceOf(
      ExternalApiTransientError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('opens the circuit after N consecutive transient failures', async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse({ error: 'boom' }, 500),
    ) as unknown as FetchFn;
    const client = new ExternalApiClient(
      makeConfig({ retryMaxAttempts: 0, breakerConsecutiveFailures: 2 }),
      fetchMock,
    );

    await expect(client.authorize(REQ)).rejects.toBeInstanceOf(
      ExternalApiTransientError,
    );
    await expect(client.authorize(REQ)).rejects.toBeInstanceOf(
      ExternalApiTransientError,
    );

    expect(client.isCircuitOpen()).toBe(true);

    const callsBefore = (fetchMock as jest.Mock).mock.calls.length;
    await expect(client.authorize(REQ)).rejects.toBeInstanceOf(CircuitOpenError);
    // Circuit is open — no extra fetch call should have been made.
    expect((fetchMock as jest.Mock).mock.calls.length).toBe(callsBefore);
  });

  it('aborts the request when the per-attempt timeout fires', async () => {
    const fetchMock = jest.fn(
      (_url, init: RequestInit | undefined) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ) as unknown as FetchFn;
    const client = new ExternalApiClient(
      makeConfig({ timeoutMs: 50, retryMaxAttempts: 0 }),
      fetchMock,
    );

    await expect(client.authorize(REQ)).rejects.toBeInstanceOf(
      ExternalApiTimeoutError,
    );
  });
});
