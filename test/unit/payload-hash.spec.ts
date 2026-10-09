import { describe, expect, it } from 'bun:test';
import { canonicalJson, payloadHash } from '@/domain/services/payload-hash';

const payload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('payloadHash (idempotência)', () => {
  it('ordem das chaves não muda o hash', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };
    expect(payloadHash(reordered)).toBe(payloadHash(payload));
  });

  it('mesma key com payload diferente gera hash diferente (conflito, não replay)', () => {
    const divergent = { ...payload, money: { amount: '25.01', currency: 'BRL' } };
    expect(payloadHash(divergent)).not.toBe(payloadHash(payload));
  });

  it('campo undefined equivale a campo ausente', () => {
    expect(payloadHash({ ...payload, referenceExternalTransactionId: undefined })).toBe(payloadHash(payload));
  });

  it('JSON canônico é ordenado recursivamente e sem espaços', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
  });

  it('é SHA-256 hex com 64 caracteres', () => {
    expect(payloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });
});
