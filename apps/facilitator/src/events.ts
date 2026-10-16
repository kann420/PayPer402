import { EventEmitter } from 'node:events';
import { errorMessage, type Logger } from './logger';

export interface CommitmentRecordedData {
  id: string;
  agentId: string;
  payTo: string;
  path: string;
  amount: number;
  recordedAt: number;
}

export interface SettlementUpdatedData {
  id: string;
  status: string;
  trigger: string;
  amount: number;
  callsCount: number;
}

/** Internal events. The SSE route turns them into operator and seller variants (§7.6). */
export type FacilitatorEvent =
  | { type: 'commitment.recorded'; operatorId: string; data: CommitmentRecordedData }
  | { type: 'settlement.updated'; operatorId: string; data: SettlementUpdatedData }
  | { type: 'wallet.updated'; operatorId: string; data: { status: string } }
  | { type: 'agent.updated'; operatorId: string; data: { id: string; status: string } };

export type EventHandler = (event: FacilitatorEvent) => void | Promise<void>;

/**
 * In-process event bus. Events are not persisted: subscribers see only what happens while they
 * are connected. Handler errors (sync or async) are caught and logged, so a broken subscriber
 * cannot break the write path. Events are frozen so one handler cannot change what the next sees.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    this.emitter.setMaxListeners(0);
  }

  emit(event: FacilitatorEvent): void {
    const frozen = Object.freeze({ ...event, data: Object.freeze({ ...event.data }) }) as FacilitatorEvent;
    this.emitter.emit('event', frozen);
  }

  /** Returns a disposer. */
  subscribe(handler: EventHandler): () => void {
    const wrapped = (event: FacilitatorEvent) => {
      try {
        const result = handler(event);
        if (result instanceof Promise) {
          result.catch((err: unknown) => this.logger.error('Event handler rejected', { error: errorMessage(err) }));
        }
      } catch (err) {
        this.logger.error('Event handler threw', { error: errorMessage(err) });
      }
    };
    this.emitter.on('event', wrapped);
    return () => {
      this.emitter.off('event', wrapped);
    };
  }

  listenerCount(): number {
    return this.emitter.listenerCount('event');
  }

  dispose(): void {
    this.emitter.removeAllListeners();
  }
}
