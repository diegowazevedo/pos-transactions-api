# mock-external-api

Servidor Fastify minimalista que simula o upstream consumido pelo módulo `external-api` da API principal. Existe para permitir teste manual e validação do pipeline de resiliência sem depender de um adquirente real.

## Rotas implementadas

| Método | Rota                                                | Resposta                                          |
| ------ | --------------------------------------------------- | ------------------------------------------------- |
| GET    | `/health`                                           | `200 { "status": "ok" }`                          |
| POST   | `/transactions/authorize`                           | `200 { externalTransactionId, authCode }`         |
| POST   | `/transactions/:externalTransactionId/confirm`      | `204 No Content`                                  |
| POST   | `/transactions/:externalTransactionId/void`         | `204 No Content`                                  |

## Idempotência

Se o request trouxer o header `Idempotency-Key`, a resposta é memorizada em memória e devoluções subsequentes com a mesma chave retornam **exatamente o mesmo body** (incluindo o `authCode` aleatório). Isso replica o comportamento esperado de um adquirente que sabe deduplicar.

## Caos configurável

Ajuste via env vars para validar o pipeline `bulkhead → breaker → retry → timeout` da API principal:

| Variável                | Default | Descrição                                                       |
| ----------------------- | ------- | --------------------------------------------------------------- |
| `PORT`                  | `4000`  | Porta do servidor.                                              |
| `MOCK_LATENCY_MS`       | `0`     | Latência fixa (ms) injetada em cada resposta — útil para timeouts. |
| `MOCK_FAILURE_RATE`     | `0`     | Probabilidade de falha em `[0, 1]` — ex.: `0.3` falha 30% das chamadas. |
| `MOCK_FAILURE_STATUS`   | `503`   | Status HTTP usado quando o caos dispara.                        |
| `LOG_LEVEL`             | `info`  | Nível do logger (Pino).                                         |

## Como rodar

Standalone:

```bash
cd mock-api
npm install
npm run start:dev
```

Via Docker (já incluído no `docker-compose.yml` da raiz):

```bash
docker compose -f docker/docker-compose.yml up mock-api
```

A API principal aponta para esta instância através de `EXTERNAL_API_URL=http://mock-api:4000` no `.env.example`.
