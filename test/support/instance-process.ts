import { buildUseCases, connectTestOrm, wagerCommand } from './database';

const [instanceId, walletId, playerId, bets, amount, sharedKeyPrefix] = process.argv.slice(2);

const orm = await connectTestOrm();
const { processWager } = buildUseCases(orm);

const startAt = Number(process.env.START_AT ?? Date.now());
await Bun.sleep(Math.max(0, startAt - Date.now()));

const results = await Promise.all(
  Array.from({ length: Number(bets) }, (_, i) => {
    const externalTransactionId = i % 2 === 0 ? `${sharedKeyPrefix}-${i}` : `${sharedKeyPrefix}-${instanceId}-${i}`;
    return processWager
      .execute(wagerCommand(walletId!, playerId!, { amount, externalTransactionId }))
      .then((r) => ({ ok: true as const, status: r.status, replay: r.idempotentReplay, id: r.transactionId }))
      .catch((e: Error) => ({ ok: false as const, error: e.name }));
  }),
);

console.log(JSON.stringify({ instanceId, results }));
await orm.close(true);
