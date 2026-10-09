import { createHash } from 'node:crypto';

/**
 * JSON canônico: chaves de objetos ordenadas recursivamente, sem espaços.
 * `{ b: 1, a: { d: 2, c: 3 } }` e `{ a: { c: 3, d: 2 }, b: 1 }` geram a mesma string.
 * `undefined` é omitido (igual ao JSON.stringify), então campo ausente == campo undefined.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);

  return `{${entries.join(',')}}`;
}

/** SHA-256 em hex (64 caracteres) do JSON canônico. */
export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
