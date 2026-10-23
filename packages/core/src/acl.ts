import { isKnownEventType, type KnownEventType, type Role } from '@pearcoderhq/protocol';

// Which event types each role may append through the normal path (threat model T06).
// `participant.joined` is never appendable directly: it only enters through admission with a
// valid invitation. Unknown (future) types are allowed for hosts and members so newer clients
// interoperate, but they are never interpreted by this host.
const CONTRIBUTOR: ReadonlySet<KnownEventType> = new Set([
  'message.created',
  'presence.changed',
  'participant.left',
  'request.created',
  'request.resolved',
  'context_package.published',
  'review.finding',
  'finding.resolved',
  'decision.proposed',
  'decision.vote',
  'decision.resolved',
  'task.created',
  'task.updated',
  'code_ref.published',
  'activity.changed',
]);

const ALLOWED: Record<Role, ReadonlySet<KnownEventType>> = {
  host: CONTRIBUTOR,
  member: CONTRIBUTOR,
  observer: new Set(['presence.changed', 'participant.left']),
};

const UNKNOWN_TYPES_ALLOWED: Record<Role, boolean> = {
  host: true,
  member: true,
  observer: false,
};

export function canAppend(role: Role, type: string): boolean {
  if (!isKnownEventType(type)) return UNKNOWN_TYPES_ALLOWED[role];
  return ALLOWED[role].has(type);
}
