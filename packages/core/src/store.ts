import type { SequencedEvent } from '@pearcoderhq/protocol';

/**
 * Durable event history for one session. The session log assigns sequences; a store only keeps
 * them. Synchronous so the in-memory and SQLite (`--persist`, M3.5) stores share one contract.
 */
export interface EventStore {
  head(): number;
  get(id: string): SequencedEvent | undefined;
  append(event: SequencedEvent): void;
  after(sequence: number, limit: number): SequencedEvent[];
}

export class MemoryEventStore implements EventStore {
  readonly #events: SequencedEvent[] = [];
  readonly #byId = new Map<string, SequencedEvent>();

  head(): number {
    return this.#events.length;
  }

  get(id: string): SequencedEvent | undefined {
    const event = this.#byId.get(id);
    return event && structuredClone(event);
  }

  append(event: SequencedEvent): void {
    if (event.sequence !== this.#events.length + 1) {
      throw new Error(`store expected sequence ${this.#events.length + 1}, got ${event.sequence}`);
    }
    const copy = structuredClone(event);
    this.#events.push(copy);
    this.#byId.set(copy.id, copy);
  }

  after(sequence: number, limit: number): SequencedEvent[] {
    const start = Math.max(0, Math.floor(sequence));
    return this.#events.slice(start, start + Math.max(0, limit)).map((e) => structuredClone(e));
  }
}
