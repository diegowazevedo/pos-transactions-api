import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, QueryFailedError } from 'typeorm';
import { ulid } from 'ulid';
import { ExternalApiClient } from '../external-api/external-api.client';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { enrichRequestContext } from '../observability/correlation.context';
import { AuthorizeTransactionDto } from './dto/authorize-transaction.dto';
import { VoidTransactionDto } from './dto/void-transaction.dto';
import {
  TransactionResponse,
  toTransactionResponse,
} from './dto/transaction-response.dto';
import { Transaction, TransactionStatus } from './entities/transaction.entity';
import {
  InvalidStateTransitionError,
  TransactionNotFoundError,
} from './transactions.errors';

const PG_UNIQUE_VIOLATION = '23505';
const AUTHORIZE_LOCK_TTL_SECONDS = 30;
const AUTHORIZE_CACHE_TTL_SECONDS = 3600;
const STATE_LOCK_TTL_SECONDS = 30;

export interface AuthorizeResult {
  transaction: TransactionResponse;
  created: boolean;
}

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    @InjectRepository(Transaction)
    private readonly repo: Repository<Transaction>,
    private readonly externalApi: ExternalApiClient,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Authorize: idempotent by (terminalId, nsu).
   *
   * Flow:
   *  1. Idempotency cache hit? → return cached response.
   *  2. Acquire distributed lock on (terminalId, nsu).
   *  3. Re-check DB inside the critical section (covers a previous successful run).
   *  4. Call external API (with idempotency-key forwarded).
   *  5. Persist with status AUTHORIZED.
   *  6. On `unique_violation` (race lost to another worker after lock TTL),
   *     fetch the existing row and return it.
   */
  async authorize(dto: AuthorizeTransactionDto): Promise<AuthorizeResult> {
    enrichRequestContext({ terminalId: dto.terminalId, nsu: dto.nsu });
    const key = `authorize:${dto.terminalId}:${dto.nsu}`;
    const cached = await this.idempotency.runOnce<AuthorizeResult>(
      key,
      async () => {
        const existing = await this.repo.findOne({
          where: { terminalId: dto.terminalId, nsu: dto.nsu },
        });
        if (existing) {
          return {
            status: 200,
            body: { transaction: toTransactionResponse(existing), created: false },
          };
        }

        const transactionId = ulid();
        const externalResp = await this.externalApi.authorize({
          idempotencyKey: `${dto.terminalId}:${dto.nsu}`,
          terminalId: dto.terminalId,
          nsu: dto.nsu,
          amount: dto.amount,
          currency: dto.currency,
        });

        try {
          const tx = await this.repo.save(
            this.repo.create({
              transactionId,
              terminalId: dto.terminalId,
              nsu: dto.nsu,
              amount: dto.amount,
              currency: dto.currency,
              status: TransactionStatus.AUTHORIZED,
              externalAuthCode: externalResp.authCode,
              externalTransactionId: externalResp.externalTransactionId,
            }),
          );
          return {
            status: 201,
            body: { transaction: toTransactionResponse(tx), created: true },
          };
        } catch (err) {
          if (this.isUniqueViolation(err)) {
            this.logger.warn(
              `Race detected on authorize for ${dto.terminalId}:${dto.nsu}; falling back to existing record`,
            );
            const winner = await this.repo.findOneOrFail({
              where: { terminalId: dto.terminalId, nsu: dto.nsu },
            });
            return {
              status: 200,
              body: {
                transaction: toTransactionResponse(winner),
                created: false,
              },
            };
          }
          throw err;
        }
      },
      {
        lockTtlSeconds: AUTHORIZE_LOCK_TTL_SECONDS,
        cacheTtlSeconds: AUTHORIZE_CACHE_TTL_SECONDS,
      },
    );

    return cached.body;
  }

  /**
   * Confirm: transitions AUTHORIZED → CONFIRMED.
   * Idempotent: if already CONFIRMED, returns silently.
   * Rejects if VOIDED (invalid transition).
   */
  async confirm(transactionId: string): Promise<void> {
    enrichRequestContext({ transactionId });
    const lockKey = `confirm:${transactionId}`;
    const token = await this.idempotency.acquireLock(lockKey, {
      ttlSeconds: STATE_LOCK_TTL_SECONDS,
    });
    if (!token) {
      throw new InvalidStateTransitionError(
        'IN_PROGRESS',
        'CONFIRMED',
        transactionId,
      );
    }

    try {
      const tx = await this.repo.findOne({ where: { transactionId } });
      if (!tx) throw new TransactionNotFoundError(transactionId);
      if (tx.status === TransactionStatus.CONFIRMED) return; // idempotent replay
      if (tx.status !== TransactionStatus.AUTHORIZED) {
        throw new InvalidStateTransitionError(
          tx.status,
          TransactionStatus.CONFIRMED,
          transactionId,
        );
      }

      await this.externalApi.confirm({
        idempotencyKey: `confirm:${transactionId}`,
        externalTransactionId: tx.externalTransactionId!,
      });

      tx.status = TransactionStatus.CONFIRMED;
      tx.confirmedAt = new Date();
      await this.repo.save(tx); // optimistic lock via @VersionColumn
    } finally {
      await this.idempotency.releaseLock(lockKey, token);
    }
  }

  /**
   * Void: transitions AUTHORIZED|CONFIRMED → VOIDED.
   * Idempotent: if already VOIDED, returns silently.
   * Supports lookup by transactionId OR (terminalId, nsu).
   */
  async void(input: VoidTransactionDto): Promise<void> {
    const tx = await this.resolveForVoid(input);
    enrichRequestContext({
      transactionId: tx.transactionId,
      terminalId: tx.terminalId,
      nsu: tx.nsu,
    });

    const lockKey = `void:${tx.transactionId}`;
    const token = await this.idempotency.acquireLock(lockKey, {
      ttlSeconds: STATE_LOCK_TTL_SECONDS,
    });
    if (!token) {
      throw new InvalidStateTransitionError(
        'IN_PROGRESS',
        TransactionStatus.VOIDED,
        tx.transactionId,
      );
    }

    try {
      // Re-fetch under the lock — state may have changed between resolve and lock.
      const fresh = await this.repo.findOneOrFail({
        where: { transactionId: tx.transactionId },
      });

      if (fresh.status === TransactionStatus.VOIDED) return; // idempotent

      await this.externalApi.void({
        idempotencyKey: `void:${fresh.transactionId}`,
        externalTransactionId: fresh.externalTransactionId!,
      });

      fresh.status = TransactionStatus.VOIDED;
      fresh.voidedAt = new Date();
      await this.repo.save(fresh);
    } finally {
      await this.idempotency.releaseLock(lockKey, token);
    }
  }

  private async resolveForVoid(input: VoidTransactionDto): Promise<Transaction> {
    if (input.transactionId) {
      const tx = await this.repo.findOne({
        where: { transactionId: input.transactionId },
      });
      if (!tx) throw new TransactionNotFoundError(input.transactionId);
      return tx;
    }
    const tx = await this.repo.findOne({
      where: { terminalId: input.terminalId!, nsu: input.nsu! },
    });
    if (!tx) {
      throw new TransactionNotFoundError(
        `${input.terminalId}:${input.nsu}`,
      );
    }
    return tx;
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof QueryFailedError &&
      // node-postgres surfaces the SQLSTATE in `code`
      (err as QueryFailedError & { code?: string }).code === PG_UNIQUE_VIOLATION
    );
  }
}
