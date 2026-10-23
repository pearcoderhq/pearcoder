import type { SequencedEvent } from '@pearcoderhq/protocol';
import { describe, expect, it } from 'vitest';
import { matching } from '../src/ids.js';

const ev = (id: string, type: string) => ({ id, type }) as SequencedEvent;

describe('short ids', () => {
  const history = [
    ev('4044de9b-0000-4000-8000-000000000001', 'request.created'),
    ev('4e10ea90-0000-4000-8000-000000000002', 'review.finding'),
    ev('e1aa0000-0000-4000-8000-000000000003', 'participant.joined'),
    ev('e9ff8068-0000-4000-8000-000000000004', 'review.finding'),
  ];
  const resolvable = ['request.created', 'review.finding', 'decision.proposed'];

  it('reports every match for an ambiguous prefix instead of picking the first', () => {
    expect(matching(history, '4', resolvable).map((e) => e.type)).toEqual([
      'request.created',
      'review.finding',
    ]);
  });

  it('only matches the types the command can act on', () => {
    expect(matching(history, 'e', resolvable).map((e) => e.id.slice(0, 8))).toEqual(['e9ff8068']);
    expect(matching(history, 'zz', resolvable)).toEqual([]);
  });

  it('prefers an exact id', () => {
    const id = '4044de9b-0000-4000-8000-000000000001';
    expect(matching(history, id)).toHaveLength(1);
  });
});
