import { z } from 'zod';

export const confirmTransactionSchema = z.object({
  transactionId: z.string().length(26, 'transactionId must be a ULID (26 chars)'),
});

export type ConfirmTransactionDto = z.infer<typeof confirmTransactionSchema>;
