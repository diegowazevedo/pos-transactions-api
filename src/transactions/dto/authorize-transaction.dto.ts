import { z } from 'zod';

const amountString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'amount must be a decimal with up to 2 places');

export const authorizeTransactionSchema = z.object({
  terminalId: z.string().min(1).max(50),
  nsu: z.string().min(1).max(50),
  amount: amountString,
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO code')
    .default('BRL'),
});

export type AuthorizeTransactionDto = z.infer<typeof authorizeTransactionSchema>;
