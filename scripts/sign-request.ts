/**
 * CLI helper to sign a request body for manual testing.
 *
 * Usage:
 *   ts-node scripts/sign-request.ts <method> <path> [bodyJson]
 *
 * Examples:
 *   ts-node scripts/sign-request.ts POST /v1/pos/transactions/authorize \
 *     '{"terminalId":"T1","nsu":"0001","amount":"10.00"}'
 *
 *   ts-node scripts/sign-request.ts POST /v1/pos/transactions/confirm \
 *     '{"transactionId":"01HY..."}'
 *
 * Prints `curl` flags ready to paste.
 */
import * as crypto from 'crypto';
import { resolve as resolvePath } from 'path';
import { config as loadDotenv } from 'dotenv';

// Carrega .env (ou ENV_FILE) da raiz do projeto, sem sobrescrever vars já definidas no shell.
loadDotenv({
  path: process.env.ENV_FILE ?? resolvePath(__dirname, '..', '.env'),
});

const [, , methodArg, pathArg, bodyArg = ''] = process.argv;
if (!methodArg || !pathArg) {
  console.error(
    'Usage: ts-node scripts/sign-request.ts <method> <path> [bodyJson]',
  );
  process.exit(1);
}

const secret = process.env.HMAC_SECRET;
if (!secret) {
  console.error('HMAC_SECRET env var is required.');
  process.exit(1);
}

/**
 * Git Bash on Windows (MSYS) converts arguments that start with `/` into
 * Windows paths prefixed with the Git install dir, e.g.:
 *   /v1/pos/transactions/authorize  →  C:/Program Files/Git/v1/pos/transactions/authorize
 * Detect the pattern and revert it to the original Unix-style path.
 */
function unmangleMsysPath(raw: string): string {
  const m = /^[A-Za-z]:[\\/](?:.*?[\\/])?Git[\\/](.+)$/i.exec(raw);
  if (m) return '/' + m[1].replace(/\\/g, '/');
  return raw;
}

const method = methodArg.toUpperCase();
const path = unmangleMsysPath(pathArg);
// Normalize JSON spacing so the signature matches what JSON.stringify produces.
const body = bodyArg ? JSON.stringify(JSON.parse(bodyArg)) : '';
const ts = Math.floor(Date.now() / 1000).toString();

const payload = `${ts}.${method}.${path}.${body}`;
const sig = crypto
  .createHmac('sha256', secret)
  .update(payload)
  .digest('hex');

const host = process.env.API_HOST ?? 'http://localhost:3000';

console.log('# Signed request — copy/paste:');
console.log();
console.log(
  [
    `curl -i -X ${method} ${host}${path}`,
    `-H 'content-type: application/json'`,
    `-H 'x-timestamp: ${ts}'`,
    `-H 'x-signature: ${sig}'`,
    body && `-d '${body}'`,
  ]
    .filter(Boolean)
    .join(' \\\n  '),
);
