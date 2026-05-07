/**
 * Contracts the external acquirer/processor API is expected to honour.
 * Real implementations vary — these shapes are intentionally minimal so the
 * orchestrator stays decoupled from upstream-specific quirks.
 */

export interface ExternalAuthorizeRequest {
  idempotencyKey: string;
  terminalId: string;
  nsu: string;
  amount: string;
  currency: string;
}

export interface ExternalAuthorizeResponse {
  externalTransactionId: string;
  authCode: string;
}

export interface ExternalConfirmRequest {
  idempotencyKey: string;
  externalTransactionId: string;
}

export interface ExternalVoidRequest {
  idempotencyKey: string;
  externalTransactionId: string;
}
