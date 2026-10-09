/**
 * Teste de carga (seção 14): `bun run test:load`.
 *
 * Dispara transações por HTTP contra uma ou mais instâncias já rodando e mede throughput,
 * latência (p50/p95/p99), taxa de erro, conflitos de concorrência e outbox lag. No fim,
 * reconcilia todas as wallets usadas: carga que "passa" mas deixa saldo ≠ ledger é falha.
 *
 * Configuração por variáveis de ambiente (todas opcionais):
 *   LOAD_TARGETS     URLs separadas por vírgula   (padrão: http://localhost:3000)
 *   LOAD_DURATION_S  duração da fase de carga      (padrão: 30)
 *   LOAD_CONCURRENCY requisições simultâneas       (padrão: 50)
 *   LOAD_WALLETS     wallets "frias"               (padrão: 200)
 *   LOAD_HOT_SHARE   fração das apostas na wallet quente (padrão: 0.2)
 *   LOAD_REPLAY_SHARE fração de reenvios idênticos (padrão: 0.05)
 *   LOAD_REPORT      arquivo do relatório          (padrão: docs/load-test/ultimo-resultado.md)
 */
import { cpus, totalmem, type as osType, release } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const env = (name: string, fallback: string) => process.env[name] ?? fallback;
const targets = env('LOAD_TARGETS', 'http://localhost:3000').split(',').map((t) => t.trim().replace(/\/$/, ''));
const durationS = Number(env('LOAD_DURATION_S', '30'));
const concurrency = Number(env('LOAD_CONCURRENCY', '50'));
const coldWalletCount = Number(env('LOAD_WALLETS', '200'));
const hotShare = Number(env('LOAD_HOT_SHARE', '0.2'));
const replayShare = Number(env('LOAD_REPLAY_SHARE', '0.05'));
const reportPath = env('LOAD_REPORT', 'docs/load-test/ultimo-resultado.md');

type Wallet = { id: string; playerId: string };
type Sample = { ms: number; status: number; kind: 'bet' | 'win' | 'replay' | 'hot-bet' };
type SentRequest = { url: string; body: string; key: string };

let rr = 0;
const nextTarget = () => targets[rr++ % targets.length]!;

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function createWallet(amount: string): Promise<Wallet> {
  const playerId = crypto.randomUUID();
  const res = await post(`${nextTarget()}/wallets`, { playerId, initialBalance: { amount, currency: 'BRL' } });
  if (res.status !== 201) throw new Error(`wallet creation failed: ${res.status} ${await res.text()}`);
  const { id } = (await res.json()) as { id: string };
  return { id, playerId };
}

/** Soma uma métrica Prometheus (todas as séries com o nome dado) em todas as instâncias. */
async function scrape(name: string, labelFilter = ''): Promise<number> {
  let total = 0;
  for (const target of targets) {
    const text = await (await fetch(`${target}/metrics`)).text();
    for (const line of text.split('\n')) {
      if (line.startsWith(`${name}{`) || line.startsWith(`${name} `)) {
        if (labelFilter && !line.includes(labelFilter)) continue;
        total += Number(line.split(' ').pop());
      }
    }
  }
  return total;
}

async function maxOutboxLag(): Promise<number> {
  let max = 0;
  for (const target of targets) {
    const text = await (await fetch(`${target}/metrics`)).text();
    const line = text.split('\n').find((l) => l.startsWith('outbox_lag_seconds '));
    if (line) max = Math.max(max, Number(line.split(' ').pop()));
  }
  return max;
}

const percentile = (sorted: number[], p: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
const fmt = (n: number, d = 1) => n.toFixed(d);

async function main() {
  console.log(`alvos: ${targets.join(', ')} · ${durationS}s · concorrência ${concurrency}`);
  for (const target of targets) {
    const ready = await fetch(`${target}/health/ready`).catch(() => undefined);
    if (ready?.status !== 200) throw new Error(`${target} não está pronto (/health/ready). Suba a aplicação antes.`);
  }

  // ---- preparação: wallets frias (saldo alto) e uma wallet quente (disputada)
  console.log(`criando ${coldWalletCount} wallets + 1 wallet quente...`);
  const cold: Wallet[] = [];
  for (let i = 0; i < coldWalletCount; i += 20) {
    cold.push(...(await Promise.all(Array.from({ length: Math.min(20, coldWalletCount - i) }, () => createWallet('100000.00')))));
  }
  const hot = await createWallet('300.00');

  const before = {
    conflicts: await scrape('wager_lock_conflicts_total'),
    retries: await scrape('wager_retries_total'),
    duplicates: await scrape('wager_duplicates_total'),
  };

  // ---- carga
  const samples: Sample[] = [];
  const sent: SentRequest[] = [];
  let networkErrors = 0;
  let seq = 0;
  let maxLag = 0;
  const lagSamples: number[] = [];
  const deadline = Date.now() + durationS * 1000;

  const lagMonitor = (async () => {
    while (Date.now() < deadline + 3000) {
      const lag = await maxOutboxLag().catch(() => 0);
      lagSamples.push(lag);
      maxLag = Math.max(maxLag, lag);
      await Bun.sleep(1000);
    }
  })();

  async function oneRequest() {
    const r = Math.random();
    let kind: Sample['kind'];
    let request: SentRequest;

    if (r < replayShare && sent.length > 0) {
      kind = 'replay';
      request = sent[Math.floor(Math.random() * sent.length)]!;
    } else {
      const isHot = r < replayShare + hotShare;
      const wallet = isHot ? hot : cold[Math.floor(Math.random() * cold.length)]!;
      const isWin = !isHot && Math.random() < 0.3;
      kind = isHot ? 'hot-bet' : isWin ? 'win' : 'bet';
      const externalTransactionId = `load-${process.pid}-${++seq}`;
      const key = `load-provider:${externalTransactionId}`;
      request = {
        url: '/wagering/transactions',
        key,
        body: JSON.stringify({
          providerId: 'load-provider',
          externalTransactionId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: `round-${seq}`,
          gameId: 'load-test',
          kind: isWin ? 'WIN' : 'BET',
          money: { amount: isHot ? '1.00' : '2.50', currency: 'BRL' },
        }),
      };
      if (sent.length < 5000) sent.push(request);
    }

    const started = performance.now();
    try {
      const res = await post(`${nextTarget()}${request.url}`, request.body, { 'Idempotency-Key': request.key });
      await res.arrayBuffer();
      samples.push({ ms: performance.now() - started, status: res.status, kind });
    } catch {
      networkErrors++;
    }
  }

  console.log('carga em andamento...');
  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (Date.now() < deadline) await oneRequest();
    }),
  );
  const elapsedS = (performance.now() - startedAt) / 1000;

  // ---- dreno: quanto tempo a outbox leva para zerar depois que a carga para
  const drainStart = performance.now();
  let drainS = -1;
  while (performance.now() - drainStart < 60_000) {
    if ((await maxOutboxLag()) === 0) {
      drainS = (performance.now() - drainStart) / 1000;
      break;
    }
    await Bun.sleep(250);
  }
  await lagMonitor;

  const after = {
    conflicts: await scrape('wager_lock_conflicts_total'),
    retries: await scrape('wager_retries_total'),
    duplicates: await scrape('wager_duplicates_total'),
  };

  // ---- consistência: reconcilia todas as wallets usadas
  console.log('reconciliando wallets...');
  const inconsistent: string[] = [];
  const all = [...cold, hot];
  for (let i = 0; i < all.length; i += 20) {
    await Promise.all(
      all.slice(i, i + 20).map(async (w) => {
        const res = await post(`${nextTarget()}/wallets/${w.id}/reconciliation`, {});
        const body = (await res.json()) as { consistent: boolean };
        if (!body.consistent) inconsistent.push(w.id);
      }),
    );
  }
  const hotBalance = ((await (await fetch(`${targets[0]}/wallets/${hot.id}`)).json()) as { balance: { amount: string } })
    .balance.amount;

  // ---- resultados
  const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
  const byStatus = new Map<number, number>();
  for (const s of samples) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
  const serverErrors = samples.filter((s) => s.status >= 500).length;
  const total = samples.length + networkErrors;
  const latencyOf = (kind: Sample['kind']) => {
    const l = samples.filter((s) => s.kind === kind).map((s) => s.ms).sort((a, b) => a - b);
    return { n: l.length, p50: percentile(l, 50), p95: percentile(l, 95), p99: percentile(l, 99) };
  };
  const result = {
    total,
    throughput: samples.length / elapsedS,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.at(-1) ?? 0,
    errorRate: total === 0 ? 0 : (serverErrors + networkErrors) / total,
    serverErrors,
    networkErrors,
    byStatus: Object.fromEntries([...byStatus.entries()].sort()),
    lockConflicts: after.conflicts - before.conflicts,
    retries: after.retries - before.retries,
    duplicates: after.duplicates - before.duplicates,
    maxLag,
    avgLag: lagSamples.length ? lagSamples.reduce((a, b) => a + b, 0) / lagSamples.length : 0,
    drainS,
    inconsistent,
    hotBalance,
    perKind: { bet: latencyOf('bet'), win: latencyOf('win'), 'hot-bet': latencyOf('hot-bet'), replay: latencyOf('replay') },
  };

  const report = renderReport(result, elapsedS);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report);
  console.log(`\n${report}\nrelatório salvo em ${reportPath}`);

  if (inconsistent.length > 0) {
    console.error(`FALHA: ${inconsistent.length} wallet(s) com saldo ≠ ledger`);
    process.exit(1);
  }
}

function renderReport(r: ReturnType<typeof Object> & Record<string, any>, elapsedS: number): string {
  const kinds = Object.entries(r.perKind as Record<string, { n: number; p50: number; p95: number; p99: number }>)
    .map(([k, v]) => `| ${k} | ${v.n} | ${fmt(v.p50)} | ${fmt(v.p95)} | ${fmt(v.p99)} |`)
    .join('\n');
  const statuses = Object.entries(r.byStatus as Record<string, number>)
    .map(([s, n]) => `| ${s} | ${n} |`)
    .join('\n');

  return `# Resultado do teste de carga

Gerado por \`bun run test:load\` em ${new Date().toISOString()}.

## Ambiente
| Item | Valor |
|---|---|
| Sistema | ${osType()} ${release()} |
| CPU | ${cpus()[0]?.model ?? '?'} (${cpus().length} threads) |
| Memória | ${fmt(totalmem() / 1024 ** 3)} GB |
| Bun (gerador de carga) | ${Bun.version} |
| Instâncias alvo | ${targets.length} (${targets.join(', ')}) |

Gerador de carga, aplicação, PostgreSQL e LocalStack rodam **na mesma máquina** — eles disputam
CPU entre si, então os números são um limite inferior e servem para comparar cenários, não como
capacidade de produção.

## Metodologia
- Duração: ${durationS}s · concorrência: ${concurrency} requisições simultâneas (loop fechado:
  cada "usuário virtual" manda a próxima assim que a anterior responde).
- Requisições distribuídas em round-robin entre as instâncias.
- ${coldWalletCount} wallets "frias" (saldo 100000.00) + 1 wallet **quente** (saldo 300.00).
- Mistura: ${fmt(hotShare * 100, 0)}% apostas de 1.00 na wallet quente (disputa de lock e, ao
  esgotar o saldo, rejeições) · ${fmt(replayShare * 100, 0)}% reenvios idênticos (replay
  idempotente) · restante em wallets frias (70% BET de 2.50, 30% WIN de 2.50).
- Antes e depois: leitura de \`/metrics\` de todas as instâncias (conflitos, retries, duplicatas).
  Durante: \`outbox_lag_seconds\` amostrado a cada 1s.
- Depois: \`POST /wallets/:id/reconciliation\` em **todas** as wallets usadas.

## Resultados
| Métrica | Valor |
|---|---|
| Requisições | ${r.total} em ${fmt(elapsedS)}s |
| **Throughput** | **${fmt(r.throughput)} req/s** |
| **Latência p50 / p95 / p99** | **${fmt(r.p50)} / ${fmt(r.p95)} / ${fmt(r.p99)} ms** (máx. ${fmt(r.max)} ms) |
| **Taxa de erro** (5xx + falha de rede) | **${fmt(r.errorRate * 100, 2)}%** (${r.serverErrors} 5xx, ${r.networkErrors} rede) |
| **Conflitos de concorrência** (\`wager_lock_conflicts_total\`) | **${r.lockConflicts}** |
| Retries (\`wager_retries_total\`) | ${r.retries} |
| Replays idempotentes detectados | ${r.duplicates} |
| **Outbox lag** máximo / médio | **${fmt(r.maxLag, 2)}s / ${fmt(r.avgLag, 2)}s** |
| Tempo para a outbox zerar após a carga | ${r.drainS < 0 ? 'não zerou em 60s' : `${fmt(r.drainS, 2)}s`} |
| Saldo final da wallet quente | ${r.hotBalance} |
| **Wallets inconsistentes** (saldo ≠ ledger) | **${r.inconsistent.length}** de ${coldWalletCount + 1} |

### Status HTTP
| Status | Quantidade |
|---|---|
${statuses}

422 = rejeição de negócio (saldo insuficiente na wallet quente) — resposta correta, não erro.

### Latência por tipo de operação (ms)
| Tipo | n | p50 | p95 | p99 |
|---|---|---|---|---|
${kinds}
`;
}

await main();
