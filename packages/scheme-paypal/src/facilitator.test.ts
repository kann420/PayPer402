import { randomBytes } from 'node:crypto';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { describe, expect, it } from 'vitest';
import { buildCommitment, newCommitmentId, parsePayload, signCommitment, type PayPalBatchPayload } from './commitment';
import { ErrorCode } from './errors';
import { generateAgentKey } from './keys';
import { utcDayStart } from './stores';
import {
  AGENT_ID,
  OPERATOR_ID,
  PAY_TO,
  T0,
  createHarness,
  makeRequirements,
  paymentPayload,
  signedPayload,
  tamper,
} from './test-fixtures';

const schemePayload = (payment: PaymentPayload) => payment.payload as unknown as PayPalBatchPayload;

describe('PayPalBatchFacilitatorScheme: metadata', () => {
  it('advertises the scheme, family, version and no signers', () => {
    const { facilitator } = createHarness();
    expect(facilitator.scheme).toBe('batch-settlement');
    expect(facilitator.caipFamily).toBe('paypal:*');
    expect(facilitator.getExtra('paypal:sandbox')).toEqual({ version: '1.0.0' });
    expect(facilitator.getSigners('paypal:sandbox')).toEqual([]);
  });
});

describe('PayPalBatchFacilitatorScheme: verify', () => {
  it('accepts a valid commitment and reports unsettled usage', async () => {
    const h = createHarness();
    const requirements = makeRequirements();
    expect(await h.facilitator.verify(h.pay(requirements), requirements)).toEqual({
      isValid: true,
      payer: AGENT_ID,
      extra: { unsettledAmount: '0', unsettledCap: '50' },
    });
    expect(h.ledger.size).toBe(0);
  });

  describe('signature', () => {
    it('rejects a wrong signature', async () => {
      const h = createHarness();
      const requirements = makeRequirements();
      const payment = h.pay(requirements);
      const forged = paymentPayload(
        { ...schemePayload(payment), signature: randomBytes(64).toString('base64url') },
        requirements,
      );
      expect(await h.facilitator.verify(forged, requirements)).toMatchObject({
        isValid: false,
        invalidReason: ErrorCode.signature,
      });
    });

    it('rejects a signature over a different message', async () => {
      const h = createHarness();
      const requirements = makeRequirements();
      const payment = h.pay(requirements);
      const other = signedPayload(h.key.privateKey, h.key.kid, makeRequirements({ amount: '6' }));
      const mixed = paymentPayload({ ...schemePayload(payment), signature: other.signature }, requirements);
      expect((await h.facilitator.verify(mixed, requirements)).invalidReason).toBe(ErrorCode.signature);
    });

    it('rejects a signature made by another key under a registered kid', async () => {
      const h = createHarness();
      const requirements = makeRequirements();
      const intruder = generateAgentKey();
      const payment = paymentPayload(signedPayload(intruder.privateKey, h.key.kid, requirements), requirements);
      expect((await h.facilitator.verify(payment, requirements)).invalidReason).toBe(ErrorCode.signature);
    });

    it.each([
      ['garbage base64', '%%%not base64%%%'],
      ['a 63-byte value', randomBytes(63).toString('base64url')],
      ['a padded value', `${randomBytes(64).toString('base64url')}==`],
    ])('rejects %s as a malformed payload', async (_label, signature) => {
      const h = createHarness();
      const requirements = makeRequirements();
      const payment = paymentPayload({ ...schemePayload(h.pay(requirements)), signature }, requirements);
      expect((await h.facilitator.verify(payment, requirements)).invalidReason).toBe(ErrorCode.payload);
    });
  });

  describe('tampering', () => {
    it.each([
      ['maxAmount', { maxAmount: '4' }],
      ['payTo', { payTo: 'seller_other' }],
      ['network', { network: 'paypal:live' }],
      ['asset', { asset: 'EUR' }],
    ])('rejects a tampered %s as a requirements mismatch', async (_label, changes) => {
      const h = createHarness();
      const requirements = makeRequirements();
      const payment = paymentPayload(tamper(schemePayload(h.pay(requirements)), changes), requirements);
      expect((await h.facilitator.verify(payment, requirements)).invalidReason).toBe(
        ErrorCode.requirementsMismatch,
      );
    });

    it.each([
      ['maxAmount', { maxAmount: '4' }, { amount: '4' }],
      ['payTo', { payTo: 'seller_other' }, { payTo: 'seller_other' }],
    ])('rejects a %s tampered together with the requirements as a bad signature', async (_label, changes, req) => {
      const h = createHarness();
      const original = makeRequirements();
      const tamperedRequirements = makeRequirements(req);
      const payment = paymentPayload(tamper(schemePayload(h.pay(original)), changes), tamperedRequirements);
      expect((await h.facilitator.verify(payment, tamperedRequirements)).invalidReason).toBe(ErrorCode.signature);
    });

    it('rejects an unknown extra field in the commitment (strict schema)', async () => {
      const h = createHarness();
      const requirements = makeRequirements();
      const payment = paymentPayload(tamper(schemePayload(h.pay(requirements)), { aud: 'facilitator' }), requirements);
      expect((await h.facilitator.verify(payment, requirements)).invalidReason).toBe(ErrorCode.payload);
    });

    it('rejects requirements for another asset, scheme or network', async () => {
      const h = createHarness();
      const requirements = makeRequirements();
      const payment = h.pay(requirements);
      for (const bad of [
        makeRequirements({ asset: 'EUR' }),
        makeRequirements({ scheme: 'exact' }),
        makeRequirements({ network: 'paypal:live' }),
      ]) {
        expect((await h.facilitator.verify(payment, bad)).invalidReason).toBe(ErrorCode.requirementsMismatch);
      }
    });
  });

  describe('payload shape', () => {
    it.each(['0', '-1', '1.5', '01', 'abc', ''])('rejects requirements.amount %j', async (amount) => {
      const h = createHarness();
      const payment = h.pay(makeRequirements());
      const result = await h.facilitator.verify(payment, makeRequirements({ amount }));
      expect(result).toMatchObject({ isValid: false, invalidReason: ErrorCode.payload });
    });

    it('rejects a missing or non-object payload', async () => {
      const h = createHarness();
      const requirements = makeRequirements();
      for (const payload of [{}, { commitment: 'x', signature: 'y' }]) {
        const payment: PaymentPayload = { x402Version: 2, accepted: requirements, payload };
        expect((await h.facilitator.verify(payment, requirements)).invalidReason).toBe(ErrorCode.payload);
      }
    });
  });

  describe('freshness', () => {
    it('rejects an expired commitment', async () => {
      const h = createHarness();
      const requirements = makeRequirements();
      const payment = h.pay(requirements, { lifetime: 120 });
      h.clock.now = T0 + 120;
      expect((await h.facilitator.verify(payment, requirements)).invalidReason).toBe(ErrorCode.expired);
    });

    it('accepts iat up to 30 s in the future and rejects more', async () => {
      const h = createHarness();
      const requirements = makeRequirements();
      expect((await h.facilitator.verify(h.pay(requirements, { iat: T0 + 30 }), requirements)).isValid).toBe(true);
      expect((await h.facilitator.verify(h.pay(requirements, { iat: T0 + 31 }), requirements)).invalidReason).toBe(
        ErrorCode.expired,
      );
    });

    it('rejects a lifetime above 300 s or above maxTimeoutSeconds', async () => {
      const h = createHarness();
      const requirements = makeRequirements({ maxTimeoutSeconds: 300 });
      expect((await h.facilitator.verify(h.pay(requirements, { lifetime: 300 }), requirements)).isValid).toBe(true);
      expect((await h.facilitator.verify(h.pay(requirements, { lifetime: 301 }), requirements)).invalidReason).toBe(
        ErrorCode.expired,
      );
      const short = makeRequirements({ maxTimeoutSeconds: 60 });
      expect((await h.facilitator.verify(h.pay(short, { lifetime: 61 }), short)).invalidReason).toBe(
        ErrorCode.expired,
      );
      const huge = makeRequirements({ maxTimeoutSeconds: 3600 });
      expect((await h.facilitator.verify(h.pay(huge, { lifetime: 301 }), huge)).invalidReason).toBe(
        ErrorCode.expired,
      );
    });

    it('rejects exp <= iat', async () => {
      const h = createHarness();
      const requirements = makeRequirements();
      expect((await h.facilitator.verify(h.pay(requirements, { lifetime: 0 }), requirements)).invalidReason).toBe(
        ErrorCode.expired,
      );
    });
  });

  describe('agent and wallet', () => {
    it('rejects an unknown agent', async () => {
      const h = createHarness();
      const stranger = generateAgentKey();
      const requirements = makeRequirements();
      const payment = paymentPayload(signedPayload(stranger.privateKey, stranger.kid, requirements), requirements);
      expect((await h.facilitator.verify(payment, requirements)).invalidReason).toBe(ErrorCode.unknownAgent);
    });

    it('rejects a disabled agent', async () => {
      const h = createHarness();
      h.registry.setAgentStatus(h.key.kid, 'disabled');
      const requirements = makeRequirements();
      expect((await h.facilitator.verify(h.pay(requirements), requirements)).invalidReason).toBe(
        ErrorCode.agentDisabled,
      );
    });

    it('rejects an unlinked wallet', async () => {
      const h = createHarness();
      h.registry.setWalletStatus(OPERATOR_ID, 'unlinked');
      const requirements = makeRequirements();
      expect((await h.facilitator.verify(h.pay(requirements), requirements)).invalidReason).toBe(
        ErrorCode.walletNotLinked,
      );
    });

    it('rejects a revoked wallet', async () => {
      const h = createHarness();
      h.registry.setWalletStatus(OPERATOR_ID, 'revoked');
      const requirements = makeRequirements();
      expect((await h.facilitator.verify(h.pay(requirements), requirements)).invalidReason).toBe(
        ErrorCode.walletRevoked,
      );
    });
  });

  describe('replay', () => {
    it('rejects verifying an already recorded id', async () => {
      const h = createHarness();
      const requirements = makeRequirements();
      const payment = h.pay(requirements);
      expect((await h.facilitator.settle(payment, requirements)).success).toBe(true);
      expect((await h.facilitator.verify(payment, requirements)).invalidReason).toBe(ErrorCode.replay);
    });
  });

  describe('caps', () => {
    it('rejects an amount above the per-call cap', async () => {
      const h = createHarness();
      const requirements = makeRequirements({ amount: '26' });
      expect(await h.facilitator.verify(h.pay(requirements), requirements)).toMatchObject({
        isValid: false,
        invalidReason: ErrorCode.capExceeded,
        extra: { cap: 'perCall' },
      });
    });

    it('rejects when the unsettled cap would be exceeded', async () => {
      const h = createHarness({ perCall: 25, daily: 1000, unsettled: 30 });
      const requirements = makeRequirements({ amount: '20' });
      expect((await h.facilitator.settle(h.pay(requirements), requirements)).success).toBe(true);
      expect(await h.facilitator.verify(h.pay(requirements), requirements)).toMatchObject({
        invalidReason: ErrorCode.capExceeded,
        extra: { cap: 'unsettled' },
      });
      const fits = makeRequirements({ amount: '10' });
      expect(await h.facilitator.verify(h.pay(fits), fits)).toMatchObject({
        isValid: true,
        extra: { unsettledAmount: '20', unsettledCap: '30' },
      });
    });

    it('rejects when the total cap would be exceeded', async () => {
      const h = createHarness({ perCall: 25, daily: 1000, unsettled: 1000, total: 12 });
      const requirements = makeRequirements({ amount: '5' });
      for (let i = 0; i < 2; i += 1) {
        expect((await h.facilitator.settle(h.pay(requirements), requirements)).success).toBe(true);
      }
      expect(await h.facilitator.verify(h.pay(requirements), requirements)).toMatchObject({
        invalidReason: ErrorCode.capExceeded,
        extra: { cap: 'total' },
      });
    });

    it('counts the daily cap per UTC day, including settled usage, and resets at midnight', async () => {
      const h = createHarness({ perCall: 25, daily: 30, unsettled: 1000 });
      const midnight = utcDayStart(T0) + 86_400;
      h.clock.now = midnight - 100;
      const requirements = makeRequirements({ amount: '15' });
      for (let i = 0; i < 2; i += 1) {
        expect((await h.facilitator.settle(h.pay(requirements), requirements)).success).toBe(true);
      }
      for (const record of h.ledger.all()) h.ledger.setState(record.id, 'settled');

      expect(await h.facilitator.verify(h.pay(requirements), requirements)).toMatchObject({
        invalidReason: ErrorCode.capExceeded,
        extra: { cap: 'daily' },
      });

      h.clock.now = midnight;
      expect((await h.facilitator.verify(h.pay(requirements), requirements)).isValid).toBe(true);
    });
  });
});

describe('PayPalBatchFacilitatorScheme: settle', () => {
  it('records the commitment and returns the commitment id as the transaction', async () => {
    const h = createHarness();
    const requirements = makeRequirements();
    const payment = h.pay(requirements);
    const { commitment } = schemePayload(payment);
    expect(await h.facilitator.settle(payment, requirements)).toEqual({
      success: true,
      transaction: commitment.id,
      network: 'paypal:sandbox',
      payer: AGENT_ID,
      amount: '5',
      extra: { chargedAmount: '5', unsettledAmount: '5' },
    });
    expect(h.ledger.all()).toEqual([
      expect.objectContaining({
        id: commitment.id,
        kid: h.key.kid,
        agentId: AGENT_ID,
        operatorId: OPERATOR_ID,
        payTo: PAY_TO,
        resourceUrl: 'https://seller.test/api/quote',
        maxAmount: 5,
        amount: 5,
        iat: T0,
        recordedAt: T0,
        state: 'unsettled',
      }),
    ]);
  });

  it('records a lower override amount and keeps maxAmount', async () => {
    const h = createHarness();
    const accepted = makeRequirements({ amount: '10' });
    const payment = h.pay(accepted);
    const result = await h.facilitator.settle(payment, { ...accepted, amount: '4' });
    expect(result).toMatchObject({ success: true, amount: '4', extra: { chargedAmount: '4' } });
    expect(h.ledger.all()[0]).toMatchObject({ amount: 4, maxAmount: 10 });
  });

  it.each(['0', '11', '99999999999999999999'])('rejects override amount %j as exceeding the commitment', async (amount) => {
    const h = createHarness();
    const accepted = makeRequirements({ amount: '10' });
    const result = await h.facilitator.settle(h.pay(accepted), { ...accepted, amount });
    expect(result).toEqual({
      success: false,
      errorReason: ErrorCode.amountExceedsCommitment,
      errorMessage: expect.any(String),
      transaction: '',
      network: 'paypal:sandbox',
    });
    expect(h.ledger.size).toBe(0);
  });

  it.each(['-1', '1.5', '01', 'abc', ''])('rejects malformed settle amount %j as a payload error', async (amount) => {
    const h = createHarness();
    const accepted = makeRequirements({ amount: '10' });
    const result = await h.facilitator.settle(h.pay(accepted), { ...accepted, amount });
    expect(result.errorReason).toBe(ErrorCode.payload);
  });

  it('requires commitment.maxAmount to equal accepted.amount', async () => {
    const h = createHarness();
    const accepted = makeRequirements({ amount: '10' });
    const payment = h.pay(accepted);
    const lied: PaymentPayload = { ...payment, accepted: { ...accepted, amount: '20' } };
    expect((await h.facilitator.settle(lied, { ...accepted, amount: '4' })).errorReason).toBe(
      ErrorCode.requirementsMismatch,
    );
  });

  it('allows settlement up to 60 s after exp', async () => {
    const h = createHarness();
    const requirements = makeRequirements();
    const early = h.pay(requirements, { lifetime: 120 });
    const late = h.pay(requirements, { lifetime: 120 });
    h.clock.now = T0 + 120 + 30;
    expect((await h.facilitator.verify(early, requirements)).invalidReason).toBe(ErrorCode.expired);
    expect((await h.facilitator.settle(early, requirements)).success).toBe(true);
    h.clock.now = T0 + 120 + 61;
    expect((await h.facilitator.settle(late, requirements)).errorReason).toBe(ErrorCode.expired);
    expect(h.ledger.size).toBe(1);
  });

  it('returns the original result for an identical retry, even with a different override', async () => {
    const h = createHarness();
    const accepted = makeRequirements({ amount: '10' });
    const payment = h.pay(accepted);
    const first = await h.facilitator.settle(payment, { ...accepted, amount: '7' });
    const retry = await h.facilitator.settle(payment, { ...accepted, amount: '3' });
    expect(first).toMatchObject({ success: true, amount: '7' });
    expect(retry).toEqual(first);
    expect(h.ledger.size).toBe(1);
    expect(h.ledger.all()[0]?.amount).toBe(7);
  });

  it('fails at exactly exp + 60', async () => {
    const h = createHarness();
    const requirements = makeRequirements();
    const payment = h.pay(requirements, { lifetime: 120 });
    h.clock.now = T0 + 120 + 60;
    expect((await h.facilitator.settle(payment, requirements)).errorReason).toBe(ErrorCode.expired);
    h.clock.now = T0 + 120 + 59;
    expect((await h.facilitator.settle(payment, requirements)).success).toBe(true);
  });

  describe('identical retry short-circuit', () => {
    async function settledOnce() {
      const h = createHarness();
      const accepted = makeRequirements({ amount: '10' });
      const payment = h.pay(accepted, { lifetime: 120 });
      const first = await h.facilitator.settle(payment, { ...accepted, amount: '7' });
      expect(first).toMatchObject({ success: true, amount: '7' });
      return { h, accepted, payment, first };
    }

    it('returns the original result after the wallet was revoked', async () => {
      const { h, accepted, payment, first } = await settledOnce();
      h.registry.setWalletStatus(OPERATOR_ID, 'revoked');
      expect(await h.facilitator.settle(payment, { ...accepted, amount: '7' })).toEqual(first);
      expect(h.ledger.size).toBe(1);
    });

    it('returns the original result after exp + 60', async () => {
      const { h, accepted, payment, first } = await settledOnce();
      h.clock.now = T0 + 120 + 600;
      expect(await h.facilitator.settle(payment, accepted)).toEqual(first);
    });

    it.each(['0', '11'])('returns the original result with an out-of-range override %j', async (amount) => {
      const { h, accepted, payment, first } = await settledOnce();
      expect(await h.facilitator.settle(payment, { ...accepted, amount })).toEqual(first);
      expect(h.ledger.all()[0]?.amount).toBe(7);
    });

    it('reports the current unsettled amount in extra (informational)', async () => {
      const { h, accepted, payment, first } = await settledOnce();
      await h.facilitator.settle(h.pay(accepted), { ...accepted, amount: '3' });
      expect(await h.facilitator.settle(payment, accepted)).toEqual({
        ...first,
        extra: { chargedAmount: '7', unsettledAmount: '10' },
      });
    });

    it('still rejects a different payload with the same id as replay', async () => {
      const { h, accepted, payment } = await settledOnce();
      const id = schemePayload(payment).commitment.id;
      const other = h.pay(accepted, { id, lifetime: 100 });
      expect(await h.facilitator.settle(other, accepted)).toMatchObject({
        success: false,
        errorReason: ErrorCode.replay,
      });
      expect(h.ledger.size).toBe(1);
    });
  });

  describe('malformed input', () => {
    it.each([null, undefined])('returns a payload failure for %s requirements', async (requirements) => {
      const h = createHarness();
      const payment = h.pay(makeRequirements());
      const bad = requirements as unknown as PaymentRequirements;
      expect(await h.facilitator.settle(payment, bad)).toEqual({
        success: false,
        errorReason: ErrorCode.payload,
        errorMessage: expect.any(String),
        transaction: '',
        network: 'paypal:sandbox',
      });
      expect((await h.facilitator.verify(payment, bad)).invalidReason).toBe(ErrorCode.payload);
    });

    it('rejects a __proto__ key in the commitment (strict schema)', async () => {
      const h = createHarness();
      const requirements = makeRequirements();
      const { commitment, signature } = schemePayload(h.pay(requirements));
      const json = JSON.stringify({ commitment, signature }).replace(
        '"v":1',
        '"__proto__":{"polluted":true},"v":1',
      );
      const payload = JSON.parse(json) as Record<string, unknown>;
      const payment = paymentPayload(payload, requirements);
      expect((await h.facilitator.verify(payment, requirements)).invalidReason).toBe(ErrorCode.payload);
      expect((await h.facilitator.settle(payment, requirements)).errorReason).toBe(ErrorCode.payload);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });

    it('ignores a __proto__ key in the outer payload without prototype pollution', async () => {
      const h = createHarness();
      const requirements = makeRequirements();
      const { commitment, signature } = schemePayload(h.pay(requirements));
      const payload = JSON.parse(
        `{"__proto__":{"polluted":true},"commitment":${JSON.stringify(commitment)},"signature":"${signature}"}`,
      ) as Record<string, unknown>;
      const parsed = parsePayload(payload);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(Object.getPrototypeOf(parsed.payload)).toBe(Object.prototype);
        expect(Object.keys(parsed.payload).sort()).toEqual(['commitment', 'signature']);
      }
      expect((await h.facilitator.settle({ ...h.pay(requirements), payload }, requirements)).success).toBe(true);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });
  });

  it('rejects a different payload that reuses a recorded id', async () => {
    const h = createHarness();
    const requirements = makeRequirements();
    const id = newCommitmentId();
    const first = h.pay(requirements, { id });
    const second = h.pay(requirements, { id, lifetime: 100 });
    expect((await h.facilitator.settle(first, requirements)).success).toBe(true);
    expect((await h.facilitator.verify(second, requirements)).invalidReason).toBe(ErrorCode.replay);
    expect(await h.facilitator.settle(second, requirements)).toMatchObject({
      success: false,
      errorReason: ErrorCode.replay,
      transaction: '',
    });
    expect(h.ledger.size).toBe(1);
  });

  it('re-checks caps with the actual amount', async () => {
    const h = createHarness({ perCall: 25, daily: 100, unsettled: 10 });
    const accepted = makeRequirements({ amount: '8' });
    expect((await h.facilitator.settle(h.pay(accepted), accepted)).success).toBe(true);
    const next = h.pay(accepted);
    expect(await h.facilitator.settle(next, accepted)).toMatchObject({
      success: false,
      errorReason: ErrorCode.capExceeded,
      extra: { cap: 'unsettled' },
    });
    expect((await h.facilitator.settle(next, { ...accepted, amount: '2' })).success).toBe(true);
  });

  it('fails when the wallet is revoked between verify and settle', async () => {
    const h = createHarness();
    const requirements = makeRequirements();
    const payment = h.pay(requirements);
    expect((await h.facilitator.verify(payment, requirements)).isValid).toBe(true);
    h.registry.setWalletStatus(OPERATOR_ID, 'revoked');
    expect((await h.facilitator.settle(payment, requirements)).errorReason).toBe(ErrorCode.walletRevoked);
    expect(h.ledger.size).toBe(0);
  });

  it('fails for a disabled agent and an unlinked wallet', async () => {
    const h = createHarness();
    const requirements = makeRequirements();
    h.registry.setAgentStatus(h.key.kid, 'disabled');
    expect((await h.facilitator.settle(h.pay(requirements), requirements)).errorReason).toBe(
      ErrorCode.agentDisabled,
    );
    h.registry.setAgentStatus(h.key.kid, 'active');
    h.registry.setWalletStatus(OPERATOR_ID, 'unlinked');
    expect((await h.facilitator.settle(h.pay(requirements), requirements)).errorReason).toBe(
      ErrorCode.walletNotLinked,
    );
  });

  it('rejects a forged signature', async () => {
    const h = createHarness();
    const requirements = makeRequirements();
    const commitment = buildCommitment({
      kid: h.key.kid,
      network: requirements.network,
      asset: requirements.asset,
      payTo: requirements.payTo,
      maxAmount: requirements.amount,
      iat: T0,
      exp: T0 + 120,
    });
    const forged = { commitment, signature: signCommitment(commitment, generateAgentKey().privateKey) };
    expect((await h.facilitator.settle(paymentPayload(forged, requirements), requirements)).errorReason).toBe(
      ErrorCode.signature,
    );
  });
});
