import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { QueryFailedError, Repository } from 'typeorm';
import { ExternalApiClient } from '../external-api/external-api.client';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { RedisService } from '../redis/redis.service';
import { Transaction, TransactionStatus } from './entities/transaction.entity';
import { TransactionsService } from './transactions.service';
import {
  InvalidStateTransitionError,
  TransactionNotFoundError,
} from './transactions.errors';

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    transactionId: '01HYABC0123456789012345678',
    terminalId: 'T1',
    nsu: '0001',
    amount: '10.00',
    currency: 'BRL',
    status: TransactionStatus.AUTHORIZED,
    externalAuthCode: 'AUTH-1',
    externalTransactionId: 'ext-1',
    createdAt: now,
    updatedAt: now,
    confirmedAt: null,
    voidedAt: null,
    version: 1,
    ...overrides,
  } as Transaction;
}

function makeRepo() {
  const findOne = jest.fn();
  const findOneOrFail = jest.fn();
  const save = jest.fn();
  const create = jest.fn((data: Partial<Transaction>) => ({ ...data }) as Transaction);
  return {
    repo: { findOne, findOneOrFail, save, create } as unknown as Repository<Transaction>,
    findOne,
    findOneOrFail,
    save,
    create,
  };
}

function makeExternalApi() {
  return {
    authorize: jest.fn(),
    confirm: jest.fn(),
    void: jest.fn(),
  } as unknown as jest.Mocked<ExternalApiClient>;
}

function makeIdempotency(): { service: IdempotencyService; client: Redis } {
  const client = new RedisMock() as unknown as Redis;
  return { service: new IdempotencyService(new RedisService(client)), client };
}

async function buildService() {
  const { repo, ...repoFns } = makeRepo();
  const externalApi = makeExternalApi();
  const { service: idempotency, client: redisClient } = makeIdempotency();
  // ioredis-mock shares its in-memory store across instances by default — wipe
  // it explicitly so cache state from previous tests doesn't leak in.
  await redisClient.flushall();
  const service = new TransactionsService(repo, externalApi, idempotency);
  return { service, repo, externalApi, idempotency, ...repoFns };
}

const AUTHORIZE_DTO = {
  terminalId: 'T1',
  nsu: '0001',
  amount: '10.00',
  currency: 'BRL',
};

describe('TransactionsService - authorize', () => {
  it('creates a new AUTHORIZED transaction on the first call', async () => {
    const ctx = await buildService();
    ctx.findOne.mockResolvedValue(null);
    (ctx.externalApi.authorize as jest.Mock).mockResolvedValue({
      externalTransactionId: 'ext-1',
      authCode: 'AUTH-1',
    });
    ctx.save.mockImplementation(async (entity: Transaction) =>
      makeTx({ ...entity, createdAt: new Date(), updatedAt: new Date() }),
    );

    const result = await ctx.service.authorize(AUTHORIZE_DTO);

    expect(result.created).toBe(true);
    expect(result.transaction.status).toBe(TransactionStatus.AUTHORIZED);
    expect(result.transaction.externalAuthCode).toBe('AUTH-1');
    expect(ctx.externalApi.authorize).toHaveBeenCalledTimes(1);
    expect(ctx.save).toHaveBeenCalledTimes(1);
  });

  it('returns the cached response on a second identical call without re-touching DB or external', async () => {
    const ctx = await buildService();
    ctx.findOne.mockResolvedValue(null);
    (ctx.externalApi.authorize as jest.Mock).mockResolvedValue({
      externalTransactionId: 'ext-1',
      authCode: 'AUTH-1',
    });
    ctx.save.mockImplementation(async (entity: Transaction) =>
      makeTx({ ...entity, createdAt: new Date(), updatedAt: new Date() }),
    );

    const first = await ctx.service.authorize(AUTHORIZE_DTO);
    const second = await ctx.service.authorize(AUTHORIZE_DTO);

    expect(first).toEqual(second);
    expect(ctx.externalApi.authorize).toHaveBeenCalledTimes(1);
    expect(ctx.save).toHaveBeenCalledTimes(1);
  });

  it('returns the existing transaction when (terminalId, nsu) is already persisted', async () => {
    const ctx = await buildService();
    const existing = makeTx();
    ctx.findOne.mockResolvedValue(existing);

    const result = await ctx.service.authorize(AUTHORIZE_DTO);

    expect(result.created).toBe(false);
    expect(result.transaction.transactionId).toBe(existing.transactionId);
    expect(ctx.externalApi.authorize).not.toHaveBeenCalled();
    expect(ctx.save).not.toHaveBeenCalled();
  });

  it('does not persist or cache when the external API fails', async () => {
    const ctx = await buildService();
    ctx.findOne.mockResolvedValue(null);
    (ctx.externalApi.authorize as jest.Mock).mockRejectedValue(
      new Error('boom'),
    );

    await expect(ctx.service.authorize(AUTHORIZE_DTO)).rejects.toThrow('boom');
    expect(ctx.save).not.toHaveBeenCalled();

    // A subsequent call should retry — cache must NOT be populated.
    (ctx.externalApi.authorize as jest.Mock).mockResolvedValue({
      externalTransactionId: 'ext-1',
      authCode: 'AUTH-1',
    });
    ctx.save.mockImplementation(async (entity: Transaction) =>
      makeTx({ ...entity }),
    );
    const result = await ctx.service.authorize(AUTHORIZE_DTO);
    expect(result.created).toBe(true);
  });

  it('falls back to the existing record when a unique violation races us after the lock', async () => {
    const ctx = await buildService();
    const winner = makeTx({ transactionId: 'winner-id' });
    ctx.findOne.mockResolvedValueOnce(null); // initial check
    (ctx.externalApi.authorize as jest.Mock).mockResolvedValue({
      externalTransactionId: 'ext-1',
      authCode: 'AUTH-1',
    });
    const uniqueErr = new QueryFailedError('q', [], new Error('dup'));
    (uniqueErr as QueryFailedError & { code: string }).code = '23505';
    ctx.save.mockRejectedValue(uniqueErr);
    ctx.findOneOrFail.mockResolvedValue(winner);

    const result = await ctx.service.authorize(AUTHORIZE_DTO);

    expect(result.created).toBe(false);
    expect(result.transaction.transactionId).toBe('winner-id');
  });
});

describe('TransactionsService - confirm', () => {
  it('confirms an AUTHORIZED transaction and calls external', async () => {
    const ctx = await buildService();
    ctx.findOne.mockResolvedValue(makeTx({ status: TransactionStatus.AUTHORIZED }));
    ctx.save.mockImplementation(async (e: Transaction) => e);
    (ctx.externalApi.confirm as jest.Mock).mockResolvedValue(undefined);

    await ctx.service.confirm('01HYABC0123456789012345678');

    expect(ctx.externalApi.confirm).toHaveBeenCalledTimes(1);
    expect(ctx.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: TransactionStatus.CONFIRMED }),
    );
  });

  it('is idempotent when already CONFIRMED — no external call', async () => {
    const ctx = await buildService();
    ctx.findOne.mockResolvedValue(makeTx({ status: TransactionStatus.CONFIRMED }));

    await ctx.service.confirm('01HYABC0123456789012345678');

    expect(ctx.externalApi.confirm).not.toHaveBeenCalled();
    expect(ctx.save).not.toHaveBeenCalled();
  });

  it('rejects confirming a VOIDED transaction', async () => {
    const ctx = await buildService();
    ctx.findOne.mockResolvedValue(makeTx({ status: TransactionStatus.VOIDED }));

    await expect(
      ctx.service.confirm('01HYABC0123456789012345678'),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it('throws TransactionNotFoundError when the id does not exist', async () => {
    const ctx = await buildService();
    ctx.findOne.mockResolvedValue(null);

    await expect(
      ctx.service.confirm('01HYABC0123456789012345678'),
    ).rejects.toBeInstanceOf(TransactionNotFoundError);
  });
});

describe('TransactionsService - void', () => {
  it('voids by transactionId', async () => {
    const ctx = await buildService();
    const tx = makeTx({ status: TransactionStatus.AUTHORIZED });
    ctx.findOne.mockResolvedValue(tx);
    ctx.findOneOrFail.mockResolvedValue(tx);
    (ctx.externalApi.void as jest.Mock).mockResolvedValue(undefined);
    ctx.save.mockImplementation(async (e: Transaction) => e);

    await ctx.service.void({ transactionId: tx.transactionId });

    expect(ctx.externalApi.void).toHaveBeenCalledTimes(1);
    expect(ctx.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: TransactionStatus.VOIDED }),
    );
  });

  it('voids by (terminalId, nsu)', async () => {
    const ctx = await buildService();
    const tx = makeTx({ status: TransactionStatus.CONFIRMED });
    ctx.findOne.mockResolvedValue(tx);
    ctx.findOneOrFail.mockResolvedValue(tx);
    (ctx.externalApi.void as jest.Mock).mockResolvedValue(undefined);
    ctx.save.mockImplementation(async (e: Transaction) => e);

    await ctx.service.void({ terminalId: 'T1', nsu: '0001' });

    expect(ctx.externalApi.void).toHaveBeenCalledTimes(1);
  });

  it('is idempotent when already VOIDED', async () => {
    const ctx = await buildService();
    const tx = makeTx({ status: TransactionStatus.VOIDED });
    ctx.findOne.mockResolvedValue(tx);
    ctx.findOneOrFail.mockResolvedValue(tx);

    await ctx.service.void({ transactionId: tx.transactionId });

    expect(ctx.externalApi.void).not.toHaveBeenCalled();
    expect(ctx.save).not.toHaveBeenCalled();
  });

  it('throws TransactionNotFoundError when nothing matches', async () => {
    const ctx = await buildService();
    ctx.findOne.mockResolvedValue(null);

    await expect(
      ctx.service.void({ terminalId: 'T1', nsu: 'unknown' }),
    ).rejects.toBeInstanceOf(TransactionNotFoundError);
  });
});
