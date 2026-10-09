export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
}

/**
 * Espera antes da próxima tentativa: base * 2^(attempts-1), limitada ao teto.
 * attempts=1 → base, 2 → 2×base, 3 → 4×base ...
 * Sem jitter de propósito: deixa os testes determinísticos. Com várias instâncias
 * o SKIP LOCKED já espalha o trabalho; jitter fica como melhoria documentada.
 */
export function nextAttemptAt(now: Date, attempts: number, policy: BackoffPolicy): Date {
  const exponent = Math.max(0, attempts - 1);
  const delay = Math.min(policy.maxMs, policy.baseMs * 2 ** exponent);

  return new Date(now.getTime() + delay);
}
