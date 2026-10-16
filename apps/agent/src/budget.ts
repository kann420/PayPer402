import { isValidCents } from '@payper402/scheme-paypal';

/** A reservation, settled exactly once by `commit`, `release` or `markUncertain`. */
export interface Reservation {
  readonly id: number;
  readonly amountCents: number;
}

export interface BudgetSnapshot {
  budgetCents: number;
  maxPerCallCents: number;
  spentCents: number;
  uncertainCents: number;
  reservedCents: number;
  remainingCents: number;
}

/**
 * The run budget (design spec §4.4), in cents. `reserve` is synchronous, so parallel tool calls
 * cannot both pass the check.
 */
export class Budget {
  readonly budgetCents: number;
  readonly maxPerCallCents: number;
  private spent = 0;
  private uncertain = 0;
  private reserved = 0;
  private nextId = 1;
  private readonly open = new Map<number, Reservation>();

  constructor(budgetCents: number, maxPerCallCents: number) {
    if (!isValidCents(budgetCents) || !isValidCents(maxPerCallCents)) {
      throw new RangeError('budgetCents and maxPerCallCents must be positive cents values');
    }
    if (maxPerCallCents > budgetCents) throw new RangeError('maxPerCallCents must not exceed budgetCents');
    this.budgetCents = budgetCents;
    this.maxPerCallCents = maxPerCallCents;
  }

  get spentCents(): number {
    return this.spent;
  }

  get uncertainCents(): number {
    return this.uncertain;
  }

  get reservedCents(): number {
    return this.reserved;
  }

  get remainingCents(): number {
    return this.budgetCents - this.spent - this.uncertain - this.reserved;
  }

  snapshot(): BudgetSnapshot {
    return {
      budgetCents: this.budgetCents,
      maxPerCallCents: this.maxPerCallCents,
      spentCents: this.spent,
      uncertainCents: this.uncertain,
      reservedCents: this.reserved,
      remainingCents: this.remainingCents,
    };
  }

  /** Reserves `amountCents` if it fits the per-call limit and the remaining budget. */
  reserve(amountCents: number): Reservation | undefined {
    if (!isValidCents(amountCents) || amountCents > this.maxPerCallCents || amountCents > this.remainingCents) return undefined;
    const reservation: Reservation = { id: this.nextId, amountCents };
    this.nextId += 1;
    this.open.set(reservation.id, reservation);
    this.reserved += amountCents;
    return reservation;
  }

  private settle(reservation: Reservation): void {
    if (!this.open.delete(reservation.id)) throw new Error('This reservation was already settled');
    this.reserved -= reservation.amountCents;
  }

  /**
   * Moves the reservation to spent with the actual amount. An actual amount above the reservation
   * is never committed: the reserved amount is, and `overReported` is true.
   */
  commit(reservation: Reservation, actualCents: number): { committedCents: number; overReported: boolean } {
    this.settle(reservation);
    const overReported = actualCents > reservation.amountCents;
    const committedCents = overReported || !Number.isSafeInteger(actualCents) || actualCents < 0 ? reservation.amountCents : actualCents;
    this.spent += committedCents;
    return { committedCents, overReported };
  }

  /** Frees the reservation. */
  release(reservation: Reservation): void {
    this.settle(reservation);
  }

  /** Counts the reservation as possibly spent: the payment outcome is unknown. */
  markUncertain(reservation: Reservation): void {
    this.settle(reservation);
    this.uncertain += reservation.amountCents;
  }
}
