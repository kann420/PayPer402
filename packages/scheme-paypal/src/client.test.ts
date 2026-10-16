import { describe, expect, it } from 'vitest';
import { x402Client } from '@x402/core/client';
import { PayPalBatchClientScheme } from './client';
import { parsePayload, verifyCommitmentSignature } from './commitment';
import { generateAgentKey } from './keys';
import { T0, makeRequirements } from './test-fixtures';

describe('PayPalBatchClientScheme', () => {
  const key = generateAgentKey();
  const client = new PayPalBatchClientScheme({ privateKey: key.privateKey, now: () => T0 });

  it('signs a commitment that matches the requirements', async () => {
    const requirements = makeRequirements({ amount: '7', maxTimeoutSeconds: 300 });
    const result = await client.createPaymentPayload(2, requirements);
    expect(result.x402Version).toBe(2);
    const parsed = parsePayload(result.payload);
    if (!parsed.ok) throw new Error(parsed.message);
    const { commitment, signature } = parsed.payload;
    expect(commitment).toMatchObject({
      v: 1,
      kid: key.kid,
      network: 'paypal:sandbox',
      asset: 'USD',
      payTo: requirements.payTo,
      maxAmount: '7',
      iat: T0,
      exp: T0 + 120,
    });
    expect(client.kid).toBe(key.kid);
    expect(verifyCommitmentSignature(commitment, signature, key.publicKeyX)).toBe(true);
  });

  it('uses a fresh id per payment', async () => {
    const a = parsePayload((await client.createPaymentPayload(2, makeRequirements())).payload);
    const b = parsePayload((await client.createPaymentPayload(2, makeRequirements())).payload);
    expect(a.ok && b.ok && a.payload.commitment.id !== b.payload.commitment.id).toBe(true);
  });

  it.each([
    [60, 120, 60],
    [300, 120, 120],
    [0, 120, 120],
    [600, 300, 300],
  ])('with maxTimeoutSeconds %i and ttl %i, uses a lifetime of %i', async (maxTimeoutSeconds, ttlSeconds, lifetime) => {
    const scheme = new PayPalBatchClientScheme({ privateKey: key.privateKey, now: () => T0, ttlSeconds });
    const result = await scheme.createPaymentPayload(2, makeRequirements({ maxTimeoutSeconds }));
    const parsed = parsePayload(result.payload);
    expect(parsed.ok && parsed.payload.commitment.exp - parsed.payload.commitment.iat).toBe(lifetime);
  });

  it.each([
    ['another scheme', { scheme: 'exact' }],
    ['another network', { network: 'eip155:8453' as const }],
    ['another asset', { asset: 'EUR' }],
    ['a decimal amount', { amount: '0.05' }],
    ['a zero amount', { amount: '0' }],
    ['an empty payTo', { payTo: '' }],
    ['an unknown major binding version', { extra: { version: '2.0.0' } }],
  ])('refuses to pay %s', async (_label, overrides) => {
    await expect(client.createPaymentPayload(2, makeRequirements(overrides))).rejects.toThrow();
  });

  it('rejects an invalid ttl and a non-Ed25519 key', () => {
    expect(() => new PayPalBatchClientScheme({ privateKey: key.privateKey, ttlSeconds: 301 })).toThrow();
    expect(() => new PayPalBatchClientScheme({ privateKey: key.privateKey, ttlSeconds: 0 })).toThrow();
    expect(() => new PayPalBatchClientScheme({ privateKey: key.publicKey })).toThrow();
  });

  it('is subject to the SDK default $1 spend cap until it is raised', async () => {
    const sdkClient = new x402Client().register('paypal:*', client);
    const paymentRequired = {
      x402Version: 2,
      resource: { url: 'https://seller.test/premium' },
      accepts: [makeRequirements({ amount: '150' })],
    };
    await expect(sdkClient.createPaymentPayload(paymentRequired)).rejects.toThrow();
    sdkClient.setSpendControls({ maxAmountPerPayment: '$5' });
    const payload = await sdkClient.createPaymentPayload(paymentRequired);
    expect(payload.accepted.amount).toBe('150');
    const cheap = { ...paymentRequired, accepts: [makeRequirements({ amount: '100' })] };
    await expect(new x402Client().register('paypal:*', client).createPaymentPayload(cheap)).resolves.toBeDefined();
  });

  it('recognises USD on PayPal networks as a default asset', () => {
    expect(client.findDefaultAsset('USD', 'paypal:sandbox')).toEqual({ asset: 'USD', decimals: 2, symbol: 'USD' });
    expect(client.findDefaultAsset('USD', 'eip155:8453')).toBeUndefined();
    expect(client.findDefaultAsset('EUR', 'paypal:sandbox')).toBeUndefined();
  });
});
