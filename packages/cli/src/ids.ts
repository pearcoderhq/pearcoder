import type { SequencedEvent } from '@pearcoderhq/protocol';

/**
 * Events an id refers to: an exact match, or else every event whose id starts with the prefix,
 * optionally only of some types. Callers treat more than one match as ambiguous.
 */
export function matching(
  history: SequencedEvent[],
  id: string,
  types?: string[],
): SequencedEvent[] {
  const wanted = (e: SequencedEvent) => !types || types.includes(e.type);
  const exact = history.filter((e) => e.id === id && wanted(e));
  if (exact.length) return exact;
  return history.filter((e) => e.id.startsWith(id) && wanted(e));
}
