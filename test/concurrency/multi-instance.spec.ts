import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';

import { buildUseCases, createTestOrm, dbQueries } from '../support/database';

type InstanceOutput = {
  instanceId: string;
  results: ({ ok: true; status: string; replay: boolean; id: string } | { ok: false; error: string })[];
};

describe('concorrência entre 3 processos', () => {
  let orm: MikroORM;
  let db: ReturnType<typeof dbQueries>;

  beforeAll(async () => {
    orm = await createTestOrm();
    db = dbQueries(orm);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  it('3 instâncias × 20 apostas de 10.00 sobre 100.00 → nunca negativo, sem débito duplicado, ledger bate', async () => {
    const playerId = crypto.randomUUID();
    const { id: walletId } = await buildUseCases(orm).openWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: 't',
    });
    const prefix = `multi-${crypto.randomUUID()}`;
    const startAt = String(Date.now() + 1_500);

    const processes = ['1', '2', '3'].map((instanceId) =>
      Bun.spawn(['bun', 'test/support/instance-process.ts', instanceId, walletId, playerId, '20', '10.00', prefix], {
        env: { ...process.env, START_AT: startAt },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );
    const outputs: InstanceOutput[] = await Promise.all(
      processes.map(async (p) => {
        const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        if (code !== 0) throw new Error(`instance exited with ${code}: ${err}`);
        return JSON.parse(out.trim().split('\n').pop()!);
      }),
    );

    const all = outputs.flatMap((o) => o.results);
    expect(all.filter((r) => !r.ok)).toEqual([]);

    const ok = all.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
    const processedIds = new Set(ok.filter((r) => r.status === 'PROCESSED').map((r) => r.id));

    expect(new Set(ok.map((r) => r.id)).size).toBe(40);
    expect(processedIds.size).toBe(10);
    expect(await db.walletBalance(walletId)).toBe('0.00');

    const debits = await db.ledgerEntries(walletId, 'DEBIT');
    expect(debits).toHaveLength(10);
    expect(new Set(debits.map((d) => d.transaction_id))).toEqual(processedIds);

    expect(await db.ledgerBalance(walletId)).toBe(await db.walletBalance(walletId));
  }, 60_000);
});
