import { describe, expect, it } from 'vitest';
import { PayPalBatchServerScheme } from './server';
import { makeRequirements } from './test-fixtures';

const kind = { x402Version: 2, scheme: 'batch-settlement', network: 'paypal:sandbox' as const };

describe('PayPalBatchServerScheme', () => {
  const server = new PayPalBatchServerScheme();

  it('declares the authorization flow', () => {
    expect(server.scheme).toBe('batch-settlement');
    expect(server.defaultAssetTransferMethod).toBe('default');
    expect(server.paymentFlows).toEqual({ default: { supported: ['authorization'], default: 'authorization' } });
  });

  it('parses prices into USD cents', async () => {
    expect(await server.parsePrice('$0.05', 'paypal:sandbox')).toEqual({ asset: 'USD', amount: '5' });
    expect(await server.parsePrice(0.1, 'paypal:sandbox')).toEqual({ asset: 'USD', amount: '10' });
    expect(await server.parsePrice({ asset: 'USD', amount: '3' }, 'paypal:sandbox')).toEqual({
      asset: 'USD',
      amount: '3',
    });
  });

  it('rejects other networks and invalid prices', async () => {
    await expect(server.parsePrice('$0.05', 'eip155:8453')).rejects.toThrow();
    await expect(server.parsePrice('$0.001', 'paypal:sandbox')).rejects.toThrow();
    await expect(server.parsePrice('$0', 'paypal:sandbox')).rejects.toThrow();
  });

  it('knows USD decimals only', () => {
    expect(server.getAssetDecimals('USD')).toBe(2);
    expect(server.getAssetDecimals('EUR')).toBeUndefined();
  });

  it('adds the binding version, keeps other extra fields and clamps maxTimeoutSeconds', async () => {
    const enhanced = await server.enhancePaymentRequirements(
      makeRequirements({ maxTimeoutSeconds: 600, extra: { note: 'kept' } }),
      kind,
      [],
    );
    expect(enhanced.extra).toEqual({ note: 'kept', version: '1.0.0' });
    expect(enhanced.maxTimeoutSeconds).toBe(300);
    expect((await server.enhancePaymentRequirements(makeRequirements({ maxTimeoutSeconds: 0 }), kind, []))
      .maxTimeoutSeconds).toBe(300);
    expect((await server.enhancePaymentRequirements(makeRequirements({ maxTimeoutSeconds: 120 }), kind, []))
      .maxTimeoutSeconds).toBe(120);
  });
});
