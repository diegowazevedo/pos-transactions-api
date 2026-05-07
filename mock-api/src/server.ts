/**
 * Mock externo simples — implementa o contrato esperado por
 * `src/external-api/external-api.client.ts` do projeto principal:
 *
 *   POST /transactions/authorize                       → 200 { externalTransactionId, authCode }
 *   POST /transactions/:externalTransactionId/confirm  → 204
 *   POST /transactions/:externalTransactionId/void     → 204
 *
 * Tem dois superpoderes úteis para testes manuais:
 *   1. Idempotência por header `Idempotency-Key` — chamadas repetidas com a
 *      mesma chave retornam exatamente a mesma resposta.
 *   2. Caos configurável via env vars (latência fixa + taxa de falha aleatória)
 *      para validar o pipeline de resiliência (retry / breaker / timeout)
 *      sem precisar de um upstream "de verdade".
 */
import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';

const PORT = parseInt(process.env.PORT ?? '4000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const LATENCY_MS = parseInt(process.env.MOCK_LATENCY_MS ?? '0', 10);
const FAILURE_RATE = parseFloat(process.env.MOCK_FAILURE_RATE ?? '0'); // 0..1
const FAILURE_STATUS = parseInt(
  process.env.MOCK_FAILURE_STATUS ?? '503',
  10,
);

interface AuthorizeBody {
  terminalId: string;
  nsu: string;
  amount: string;
  currency?: string;
}

interface AuthorizeResponse {
  externalTransactionId: string;
  authCode: string;
}

const responseCache = new Map<string, AuthorizeResponse>();

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
});

async function applyChaos(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (LATENCY_MS > 0) {
    await new Promise((r) => setTimeout(r, LATENCY_MS));
  }
  if (FAILURE_RATE > 0 && Math.random() < FAILURE_RATE) {
    req.log.warn({ failureStatus: FAILURE_STATUS }, 'chaos: forçando falha');
    reply.code(FAILURE_STATUS).send({ error: 'chaos_injected_failure' });
    return true;
  }
  return false;
}

function getIdempotencyKey(req: FastifyRequest): string | undefined {
  const raw = req.headers['idempotency-key'];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.post<{ Body: AuthorizeBody }>(
  '/transactions/authorize',
  async (req, reply) => {
    if (await applyChaos(req, reply)) return;

    const body = req.body;
    if (!body?.terminalId || !body?.nsu || !body?.amount) {
      return reply
        .code(400)
        .send({ error: 'missing_required_fields', required: ['terminalId', 'nsu', 'amount'] });
    }

    const idempotencyKey = getIdempotencyKey(req);
    if (idempotencyKey) {
      const cached = responseCache.get(idempotencyKey);
      if (cached) {
        req.log.info({ idempotencyKey }, 'returning cached authorize response');
        return cached;
      }
    }

    const response: AuthorizeResponse = {
      externalTransactionId: `ext-${randomUUID()}`,
      authCode: Math.floor(Math.random() * 1_000_000)
        .toString()
        .padStart(6, '0'),
    };

    if (idempotencyKey) responseCache.set(idempotencyKey, response);
    return response;
  },
);

fastify.post<{ Params: { externalTransactionId: string } }>(
  '/transactions/:externalTransactionId/confirm',
  async (req, reply) => {
    if (await applyChaos(req, reply)) return;
    req.log.info(
      { externalTransactionId: req.params.externalTransactionId },
      'confirm',
    );
    reply.code(204).send();
  },
);

fastify.post<{ Params: { externalTransactionId: string } }>(
  '/transactions/:externalTransactionId/void',
  async (req, reply) => {
    if (await applyChaos(req, reply)) return;
    req.log.info(
      { externalTransactionId: req.params.externalTransactionId },
      'void',
    );
    reply.code(204).send();
  },
);

async function start() {
  try {
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(
      { latencyMs: LATENCY_MS, failureRate: FAILURE_RATE },
      `mock-external-api ouvindo em http://${HOST}:${PORT}`,
    );
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
