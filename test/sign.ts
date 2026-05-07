import * as crypto from 'crypto';

/**
 * Builds the headers needed to satisfy `HmacGuard` for a given request.
 * Mirrors the canonical-string format implemented in src/common/guards/hmac.guard.ts.
 */
export function signRequest(opts: {
  secret: string;
  method: string;
  path: string;
  body: string;
  timestamp?: number;
}): { 'x-signature': string; 'x-timestamp': string } {
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const payload = `${ts}.${opts.method.toUpperCase()}.${opts.path}.${opts.body}`;
  const sig = crypto
    .createHmac('sha256', opts.secret)
    .update(payload)
    .digest('hex');
  return {
    'x-signature': sig,
    'x-timestamp': ts,
  };
}
