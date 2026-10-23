import { listRecords, type SessionRecord } from '@pearcoderhq/client';
import { UsageError } from './io.js';

/** Picks a session by id or name, or the only one when there is exactly one. */
export function selectRecord(home: string, selector: string | undefined): SessionRecord {
  const records = listRecords(home);
  if (records.length === 0) {
    throw new UsageError(
      'no sessions yet: run `pearcoder host --name <name>` or `pearcoder join <invite>`',
    );
  }
  if (selector) {
    const wanted = selector.toLowerCase();
    const matches = records.filter(
      (r) => r.session_id === selector || r.session_name.toLowerCase() === wanted,
    );
    if (matches.length === 1 && matches[0]) return matches[0];
    throw new UsageError(
      matches.length === 0
        ? `no session named ${selector}`
        : `several sessions are named ${selector}; use its id`,
    );
  }
  if (records.length === 1 && records[0]) return records[0];
  throw new UsageError(
    `you are in ${records.length} sessions; pick one with --session (${records.map((r) => r.session_name).join(', ')})`,
  );
}
