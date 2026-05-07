export class TransactionNotFoundError extends Error {
  constructor(public readonly identifier: string) {
    super(`Transaction not found: ${identifier}`);
    this.name = 'TransactionNotFoundError';
  }
}

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
    public readonly transactionId: string,
  ) {
    super(
      `Invalid state transition for ${transactionId}: ${from} → ${to}`,
    );
    this.name = 'InvalidStateTransitionError';
  }
}
