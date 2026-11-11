import { describe, expect, it } from 'vitest';
import { CallRegistry, canonicalKey, type JevRefusal } from './registry';

const refusal: JevRefusal = {
  code: 'not_needed',
  check: { status: 'blocked', model: 'jev-test', servesTask: 0.1, alreadyCovered: 0.02, latencyMs: 5 },
};

describe('canonicalKey', () => {
  it('ignores key order', () => {
    expect(canonicalKey('translate', { text: 'a', targetLanguage: 'vi' })).toBe(canonicalKey('translate', { targetLanguage: 'vi', text: 'a' }));
  });

  it('distinguishes 1 from "1" and one service from another', () => {
    expect(canonicalKey('s', { n: 1 })).not.toBe(canonicalKey('s', { n: '1' }));
    expect(canonicalKey('hotel_rates', { hotelId: 'gion-lantern-house' })).not.toBe(canonicalKey('walking_time', { hotelId: 'gion-lantern-house' }));
  });
});

describe('CallRegistry', () => {
  const key = canonicalKey('quote', { symbol: 'KC' });

  it('moves a record through each transition, with the matching lookup', () => {
    const registry = new CallRegistry();
    expect(registry.lookup(key)).toBeUndefined();
    registry.open('call_1', 'quote', key);
    expect(registry.lookup(key)).toMatchObject({ kind: 'duplicate', record: { callId: 'call_1', state: 'in_flight' } });
    registry.paid('call_1');
    expect(registry.lookup(key)).toMatchObject({ kind: 'duplicate', record: { state: 'paid' } });
    registry.setData('call_1', { price: 1 });
    expect(registry.earlier()).toEqual([{ callId: 'call_1', serviceId: 'quote', data: { price: 1 } }]);

    registry.open('call_2', 'quote', 'k2');
    registry.uncertain('call_2');
    expect(registry.lookup('k2')).toMatchObject({ kind: 'duplicate', record: { state: 'uncertain' } });

    registry.open('call_3', 'quote', 'k3');
    registry.closed('call_3', refusal);
    expect(registry.lookup('k3')).toMatchObject({ kind: 'repeat', record: { callId: 'call_3', jevRefusal: refusal } });
  });

  it('gives no match for a record closed without a Jev refusal (failed, charged "no")', () => {
    const registry = new CallRegistry();
    registry.open('call_1', 'quote', key);
    registry.closed('call_1');
    expect(registry.lookup(key)).toBeUndefined();
    registry.open('call_2', 'quote', key);
    expect(registry.lookup(key)).toMatchObject({ kind: 'duplicate', record: { callId: 'call_2' } });
  });

  it('prefers a repeat over a duplicate, and the most recent record', () => {
    const registry = new CallRegistry();
    registry.open('call_1', 'quote', key);
    registry.closed('call_1', refusal);
    registry.open('call_2', 'quote', key);
    expect(registry.lookup(key)).toMatchObject({ kind: 'repeat', record: { callId: 'call_1' } });
    registry.closed('call_2', { ...refusal, code: 'already_covered' });
    expect(registry.lookup(key)).toMatchObject({ kind: 'repeat', record: { callId: 'call_2' } });

    const other = new CallRegistry();
    other.open('call_1', 'quote', key);
    other.paid('call_1');
    other.open('call_2', 'quote', key);
    expect(other.lookup(key)).toMatchObject({ kind: 'duplicate', record: { callId: 'call_2' } });
  });

  it('keeps data for the last 8 paid records only, and lists the last 8 paid oldest first', () => {
    const registry = new CallRegistry();
    for (let i = 1; i <= 10; i += 1) {
      registry.open(`call_${i}`, 's', `k${i}`);
      registry.paid(`call_${i}`);
      registry.setData(`call_${i}`, { i });
    }
    const earlier = registry.earlier();
    expect(earlier.map((e) => e.callId)).toEqual(['call_3', 'call_4', 'call_5', 'call_6', 'call_7', 'call_8', 'call_9', 'call_10']);
    expect(earlier.map((e) => e.data)).toEqual([3, 4, 5, 6, 7, 8, 9, 10].map((i) => ({ i })));
    // Older records keep their key and state.
    expect(registry.lookup('k1')).toMatchObject({ kind: 'duplicate', record: { state: 'paid', hasData: false, data: undefined } });
  });

  it('lists a paid record whose body is still being read with undefined data', () => {
    const registry = new CallRegistry();
    registry.open('call_1', 's', 'k1');
    registry.paid('call_1');
    expect(registry.earlier()).toEqual([{ callId: 'call_1', serviceId: 's', data: undefined }]);
  });

  it('orders earlier results by payment, not by opening', () => {
    const registry = new CallRegistry();
    registry.open('call_1', 's', 'k1');
    registry.open('call_2', 's', 'k2');
    registry.paid('call_2');
    registry.paid('call_1');
    expect(registry.earlier().map((e) => e.callId)).toEqual(['call_2', 'call_1']);
  });

  it('throws on an unknown call or an out-of-order transition', () => {
    const registry = new CallRegistry();
    expect(() => registry.paid('call_9')).toThrow('unknown call');
    registry.open('call_1', 's', 'k1');
    expect(() => registry.open('call_1', 's', 'k1')).toThrow('already open');
    expect(() => registry.setData('call_1', 1)).toThrow();
    registry.paid('call_1');
    expect(() => registry.paid('call_1')).toThrow('cannot move');
    expect(() => registry.closed('call_1')).toThrow('cannot move');
    expect(() => registry.uncertain('call_1')).toThrow('cannot move');
    registry.setData('call_1', 1);
    expect(() => registry.setData('call_1', 2)).toThrow();
  });
});
