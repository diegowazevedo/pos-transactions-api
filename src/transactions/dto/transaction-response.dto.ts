import { Transaction, TransactionStatus } from '../entities/transaction.entity';

export interface TransactionResponse {
  transactionId: string;
  terminalId: string;
  nsu: string;
  amount: string;
  currency: string;
  status: TransactionStatus;
  externalAuthCode: string | null;
  externalTransactionId: string | null;
  createdAt: string;
  confirmedAt: string | null;
  voidedAt: string | null;
}

export function toTransactionResponse(tx: Transaction): TransactionResponse {
  return {
    transactionId: tx.transactionId,
    terminalId: tx.terminalId,
    nsu: tx.nsu,
    amount: tx.amount,
    currency: tx.currency,
    status: tx.status,
    externalAuthCode: tx.externalAuthCode,
    externalTransactionId: tx.externalTransactionId,
    createdAt: tx.createdAt.toISOString(),
    confirmedAt: tx.confirmedAt?.toISOString() ?? null,
    voidedAt: tx.voidedAt?.toISOString() ?? null,
  };
}
