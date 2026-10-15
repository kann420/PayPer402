import { describe, expect, it } from 'vitest';
import { ASSET, PAYPAL_SANDBOX_NETWORK, SCHEME } from './index';

describe('binding identifiers', () => {
  it('uses a CAIP-2 network id', () => {
    expect(PAYPAL_SANDBOX_NETWORK).toMatch(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/);
  });

  it('targets the batch-settlement scheme in USD', () => {
    expect(SCHEME).toBe('batch-settlement');
    expect(ASSET).toBe('USD');
  });
});
