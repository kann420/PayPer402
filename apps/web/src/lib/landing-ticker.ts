/**
 * The landing's animation ticker (design spec §10.1), as a pure reducer: the hero pipeline (9
 * stages; stage 3 is the Jev check), the auto-advancing "How it works" tabs, and the meter. Under
 * reduced motion, or while paused, nothing advances; reduced motion shows the final hero stage.
 */
export const TICK_MS = 700;
/** Ticks spent on each of the 9 hero stages. */
export const STAGE_TICKS = [2, 2, 3, 2, 2, 2, 3, 2, 3] as const;
export const HERO_TICKS = STAGE_TICKS.reduce((a, b) => a + b, 0);
export const STEP_TICKS = 7;
export const METER_FULL = 500;

export const CAPTIONS = [
  'Your agent calls a paid API.',
  'The API answers 402: this call costs $0.02.',
  'Jev checks the call serves the task. Code decides.',
  'The agent signs a payment promise. No human click.',
  'PayPer402 checks it against your limits and adds $0.02 to the meter.',
  '200 OK. The agent gets its data. No money has moved yet.',
  'Every paid call adds to the meter.',
  'Near $5.00, PayPer402 charges your PayPal account once…',
  "…and settles the seller's share. One fee for 143 calls.",
] as const;

const SERVICES: readonly [string, number][] = [
  ['Market Quote API', 2],
  ['Page Summary API', 5],
  ['Translate API', 1],
  ['Market Quote API', 2],
  ['Page Summary API', 5],
];

export interface TickerState {
  /** Position in the hero cycle, 0 to HERO_TICKS - 1. */
  h: number;
  /** The "How it works" tab, 0 to 3. */
  step: number;
  /** Ticks on the current tab. */
  st: number;
  i: number;
  /** The meter, in cents. */
  cents: number;
  charges: number;
  flash: boolean;
  last: readonly [string, number];
}

export const initialTicker: TickerState = { h: 2, step: 0, st: 0, i: 0, cents: 420, charges: 3, flash: false, last: ['Translate API', 1] };

/** The final hero stage, shown under reduced motion. */
export const frozenTicker: TickerState = { ...initialTicker, h: HERO_TICKS - 1 };

/** One tick. A paused or reduced-motion ticker returns the same state. */
export function tick(state: TickerState, options: { paused?: boolean; reducedMotion?: boolean } = {}): TickerState {
  if (options.paused || options.reducedMotion) return state;
  let { cents, charges, last } = state;
  let flash = false;
  if (state.flash) {
    cents = 0;
  } else {
    last = SERVICES[state.i % SERVICES.length] as readonly [string, number];
    cents += last[1] * 2;
    if (cents >= METER_FULL) {
      cents = METER_FULL;
      charges += 1;
      flash = true;
    }
  }
  let step = state.step;
  let st = state.st + 1;
  if (st >= STEP_TICKS) {
    step = (step + 1) % 4;
    st = 0;
  }
  return { h: (state.h + 1) % HERO_TICKS, step, st, i: state.i + 1, cents, charges, flash, last };
}

/** The hero stage of a position: `{ stage, sub }`. */
export function stageOf(h: number): { stage: number; sub: number } {
  let acc = 0;
  for (let k = 0; k < STAGE_TICKS.length; k++) {
    const d = STAGE_TICKS[k] as number;
    if (h < acc + d) return { stage: k, sub: h - acc };
    acc += d;
  }
  return { stage: STAGE_TICKS.length - 1, sub: 0 };
}

/** Picking a tab restarts its countdown (the board sets `st` to -7). */
export function pickStep(state: TickerState, step: number): TickerState {
  return { ...state, step, st: -STEP_TICKS };
}

/** The hero meter in cents at a stage. */
export function heroMeter(stage: number, sub: number): number {
  if (stage < 4) return 0;
  if (stage < 6) return 2;
  if (stage === 6) return [124, 318, 498][sub] ?? 498;
  if (stage === 7) return 500;
  return 0;
}
