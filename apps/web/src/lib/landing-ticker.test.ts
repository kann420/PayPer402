import { describe, expect, it } from 'vitest';
import { CAPTIONS, HERO_TICKS, frozenTicker, heroMeter, initialTicker, pickStep, stageOf, STEP_TICKS, tick, type TickerState } from './landing-ticker';

const run = (state: TickerState, n: number, options = {}) => {
  let s = state;
  for (let i = 0; i < n; i++) s = tick(s, options);
  return s;
};

describe('landing ticker', () => {
  it('has 9 stages; stage 3 is the Jev check', () => {
    expect(CAPTIONS).toHaveLength(9);
    expect(CAPTIONS[2]).toContain('Jev');
    expect(stageOf(0)).toEqual({ stage: 0, sub: 0 });
    expect(stageOf(4)).toEqual({ stage: 2, sub: 0 });
    expect(stageOf(HERO_TICKS - 1).stage).toBe(8);
  });

  it('advances the hero, the tabs and the meter, and wraps around', () => {
    const s = run(initialTicker, 1);
    expect(s.h).toBe(initialTicker.h + 1);
    expect(s.cents).toBeGreaterThan(initialTicker.cents);
    expect(run(initialTicker, STEP_TICKS).step).toBe(1);
    expect(run({ ...initialTicker, h: HERO_TICKS - 1 }, 1).h).toBe(0);
  });

  it('flashes one charge when the meter reaches $5.00, then empties it', () => {
    const near = { ...initialTicker, cents: 498 };
    const full = tick(near);
    expect(full).toMatchObject({ cents: 500, flash: true, charges: initialTicker.charges + 1 });
    expect(tick(full)).toMatchObject({ cents: 0, flash: false });
  });

  it('pauses: nothing advances', () => {
    expect(run(initialTicker, 5, { paused: true })).toBe(initialTicker);
  });

  it('freezes on the final stage under reduced motion', () => {
    expect(stageOf(frozenTicker.h).stage).toBe(8);
    expect(run(frozenTicker, 10, { reducedMotion: true })).toBe(frozenTicker);
  });

  it('restarts a tab countdown when picked', () => {
    const picked = pickStep(initialTicker, 2);
    expect(picked.step).toBe(2);
    expect(run(picked, STEP_TICKS * 2 - 1).step).toBe(2);
    expect(run(picked, STEP_TICKS * 2).step).toBe(3);
  });

  it('fills the hero meter by stage', () => {
    expect(heroMeter(0, 0)).toBe(0);
    expect(heroMeter(4, 0)).toBe(1);
    expect(heroMeter(6, 2)).toBe(498);
    expect(heroMeter(7, 0)).toBe(500);
    expect(heroMeter(8, 0)).toBe(0);
  });
});
