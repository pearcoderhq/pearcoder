import { z } from 'zod';
import { SequencedEventSchema, SignedEventSchema } from './envelope.js';
import { EVENT_PAYLOAD_SCHEMAS } from './events.js';

// JSON Schema (draft 2020-12) for non-TypeScript implementations of the protocol.
export function protocolJsonSchemas(): Record<string, unknown> {
  return {
    SignedEvent: z.toJSONSchema(SignedEventSchema, { io: 'input' }),
    SequencedEvent: z.toJSONSchema(SequencedEventSchema, { io: 'input' }),
    payloads: Object.fromEntries(
      Object.entries(EVENT_PAYLOAD_SCHEMAS).map(([type, schema]) => [
        type,
        z.toJSONSchema(schema, { io: 'input' }),
      ]),
    ),
  };
}
