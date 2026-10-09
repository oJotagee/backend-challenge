# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`)
recebidas por **HTTP** e por **SQS**, correto com mensagens duplicadas, fora de ordem e processadas
simultaneamente por **várias instâncias**.

**Stack:** Bun 1.4 · TypeScript estrito · NestJS 12 · PostgreSQL 17 · MikroORM 7 · AWS SQS (LocalStack) · Docker Compose

- Decisões, trade-offs e limitações: [`ARCHITECTURE.md`](ARCHITECTURE.md)

---

## Pré-requisitos

- [Bun](https://bun.sh) 1.4+
- Docker com Docker Compose

Portas usadas: `5433` (PostgreSQL), `4566` (LocalStack), `3000` (app) e `3000–3002` (3 réplicas).

## Setup

```bash
cp .env.example .env
```

```bash
bun install
```

```bash
bun run infra:up
```

```bash
bun run migrate
```

`infra:up` sobe PostgreSQL e LocalStack e cria as filas `wager-transactions.fifo`,
`wager-transactions-dlq.fifo` e `wagering-events.fifo` (`infra/localstack/init-sqs.sh`). O
PostgreSQL já cria o banco de testes `wagering_test` (`infra/postgres/init.sql`).

## Rodando

Uma instância local, com reload:

```bash
bun run dev
```

Três instâncias em containers (portas 3000, 3001 e 3002), contra o mesmo banco e a mesma fila:

```bash
bun run app:up
```

```bash
bun run app:down
```

Toda instância roda a API **e** os workers (consumer SQS, publicador da outbox e worker de
referências pendentes). `WORKERS_ENABLED=false` desliga os workers.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` / `bun run start` | sobe a aplicação (com / sem reload) |
| `bun run infra:up` / `bun run infra:down` | sobe / derruba PostgreSQL + LocalStack (`down` apaga os volumes) |
| `bun run app:up` / `bun run app:down` | sobe / para as 3 réplicas no Docker |
| `bun run migrate` / `bun run migrate:down` | aplica todas / desfaz a última migration |
| `bun run migration:create` | gera migration a partir das mudanças nos models |
| `bun run migration:check` | confirma que models e banco estão iguais |
| `bun run typecheck` | `tsc --noEmit` em modo estrito |
| `bun run test` | testes de unidade (sem infraestrutura) |
| `bun run test:integration` | integração com PostgreSQL e LocalStack reais |
| `bun run test:concurrency` | concorrência: transações paralelas e 3 processos |
| `bun run test:all` | todos (143 testes: 88 unidade, 49 integração, 6 concorrência) |
| `bun run test:load` | teste de carga contra a aplicação rodando (relatório em `docs/load-test/`) |

Os testes de integração e de concorrência precisam de `bun run infra:up`. Eles usam o banco
`wagering_test` (o schema é recriado a cada execução) e **filas exclusivas** criadas e apagadas por
execução — não tocam nos dados nem nas filas de desenvolvimento.

### Teste de carga

Com a aplicação rodando (`bun run dev` ou `bun run app:up`):

```bash
bun run test:load
```

Contra as 3 réplicas (PowerShell):

```powershell
$env:LOAD_TARGETS="http://localhost:3000,http://localhost:3001,http://localhost:3002"; bun run test:load
```

Ao terminar, o teste **gera a pasta `docs/load-test/`** (se ainda não existir) com o relatório da
execução em `docs/load-test/ultimo-resultado.md` — a evidência pedida pelo enunciado: ambiente,
metodologia, throughput, latência p50/p95/p99, taxa de erro, conflitos de concorrência, outbox lag
e a reconciliação de todas as wallets usadas. Para guardar o resultado de um cenário com outro
nome, use `LOAD_REPORT` (ex.: `LOAD_REPORT=docs/load-test/3-instancias.md`). O teste termina com
erro se alguma wallet ficar com saldo diferente do ledger.

Outras variáveis: `LOAD_DURATION_S` (padrão 30), `LOAD_CONCURRENCY` (50), `LOAD_WALLETS` (200),
`LOAD_HOT_SHARE` (0.2) e `LOAD_REPLAY_SHARE` (0.05).

## API

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | cria wallet (saldo inicial > 0 gera transação `OPENING` + lançamento) |
| `GET /wallets/:walletId` | saldo e version |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | lançamentos, paginação por cursor opaco |
| `POST /wallets/:walletId/reconciliation` | compara saldo × ledger; sinaliza divergência, nunca corrige |
| `POST /wagering/transactions` | submete transação (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | consulta por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor |
| `GET /health/live` · `GET /health/ready` | processo vivo · PostgreSQL e SQS alcançáveis |
| `GET /metrics` | métricas Prometheus |

Status HTTP: `201` aplicada · `200` replay/consulta · `202` aguardando referência · `400` payload
inválido · `404` inexistente · `409` conflito de idempotência / wallet duplicada · `422` rejeitada
por regra (corpo com `failureCode`) · `503` falha transitória (reenviar com a mesma key).

Para testar manualmente, o arquivo [`requests.http`](requests.http) tem 16 requisições prontas, em
ordem e com o resultado esperado (VS Code com a extensão REST Client, ou WebStorm/IntelliJ).

### Exemplo

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

Com o `id` da wallet retornado:

```bash
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<WALLET_ID>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

```json
{ "transactionId": "...", "status": "PROCESSED", "balance": { "amount": "975.00", "currency": "BRL" }, "idempotentReplay": false }
```

Repetir a mesma chamada devolve o mesmo corpo com `"idempotentReplay": true` (HTTP 200).

### Pela fila

```bash
docker compose exec localstack awslocal sqs send-message --queue-url http://localhost:4566/000000000000/wager-transactions.fifo --message-group-id <WALLET_ID> --message-deduplication-id msg-1 --message-body '{"messageId":"msg-1","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"transaction-456","idempotencyKey":"provider-a:transaction-456","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<WALLET_ID>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"10.00","currency":"BRL"}}}'
```

Os eventos de integração (`WagerTransactionProcessed`, `WagerTransactionRejected`,
`WalletBalanceChanged`, `WagerTransactionPendingReference`) são publicados em
`wagering-events.fifo`.

## Configuração

Todas as variáveis estão em [`.env.example`](.env.example), validadas na subida
(`src/config.ts`) — com configuração inválida a aplicação não sobe.

| Variável | Padrão | Uso |
|---|---|---|
| `NODE_ENV` | `development` | em `development` os logs saem formatados; nos demais, JSON |
| `PORT` | `3000` | porta HTTP |
| `LOG_LEVEL` | `info` | nível mínimo de log (`debug` também mostra o SQL) |
| `INSTANCE_ID` | hostname | identifica a instância nos logs |
| `DATABASE_URL` / `TEST_DATABASE_URL` | `localhost:5433` | banco da aplicação / dos testes (`*_test`, recriado a cada execução) |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `us-east-1`, `test`, `test` | SDK da AWS (o LocalStack aceita qualquer credencial) |
| `SQS_ENDPOINT` | `http://localhost:4566` | aponta o SDK para o LocalStack; sem ela, usa a AWS real |
| `SQS_WAGER_QUEUE_URL` / `SQS_WAGER_DLQ_URL` / `SQS_EVENTS_QUEUE_URL` | filas do LocalStack | entrada, DLQ e eventos |
| `SQS_MAX_RECEIVE_COUNT` | `5` | tentativas antes da DLQ |
| `SQS_WAIT_TIME_SECONDS` | `20` | long polling do consumer |
| `SQS_RETRY_BASE_SECONDS` / `SQS_RETRY_MAX_SECONDS` | `2` / `300` | backoff de falha transitória no consumer |
| `OUTBOX_POLL_INTERVAL_MS` / `OUTBOX_BATCH_SIZE` | `500` / `50` | publicador da outbox |
| `PENDING_REFERENCE_POLL_INTERVAL_MS` / `PENDING_REFERENCE_MAX_ATTEMPTS` | `1000` / `8` | worker de referências pendentes (backoff base e limite) |
| `WORKERS_ENABLED` | `true` | liga consumer, publicador e worker nesta instância |
| `SHUTDOWN_GRACE_MS` | `10000` | no SIGTERM, quanto esperar a mensagem em andamento |

## Estrutura

```
src/
  domain/              regras puras — sem NestJS nem ORM
    entities/  value-objects/  enums/  events/  errors/  services/
  application/         orquestração
    ports/  use-cases/  services/  errors/
  infrastructure/      mundo externo
    database/          migrations + runner
    persistence/       models (tabelas MikroORM), mappers, repositories, transaction runner
    messaging/         consumer SQS, publisher de eventos, contrato da mensagem
    workers/           host dos workers e loop agendado
    observability/     métricas, observador de transações, reconciliação
    auth/              AuthGuard (ponto de extensão)
  presentation/        HTTP
    controllers/  dtos/  pipes/  filters/
test/
  unit/  integration/  concurrency/  load/  support/
docs/load-test/        relatórios gerados pelo teste de carga
```

Fluxo de schema: alterar um model em `src/infrastructure/persistence/models/` →
`bun run migration:create` → revisar o SQL (e o `down()`) → `bun run migrate` →
`bun run migration:check` deve dizer "up-to-date".
