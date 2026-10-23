import { type KeyObject, randomBytes, sign, verify } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './canonical.js';
import { SessionIdSchema, UserIdSchema, userIdFromPublicKey } from './ids.js';
import { publicKeyFromRaw, rawPublicKey } from './signing.js';

export const INVITATION_PREFIX = 'pc1_';

// What a joiner learns from an invitation: where the host is, how to recognise it (host key and
// TLS certificate fingerprint), and which role it grants. Signed by the host's device key.
export const InvitationSchema = z.object({
  v: z.literal(1),
  invite_id: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  session_id: SessionIdSchema,
  session_name: z.string().trim().min(1).max(80),
  host_user_id: UserIdSchema,
  host_public_key: z.base64url(),
  addresses: z
    .array(z.url({ protocol: /^https?$/ }))
    .min(1)
    .max(8),
  tls_fingerprint: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .optional(),
  role: z.enum(['member', 'observer']),
  expires_at: z.iso.datetime(),
  max_uses: z.number().int().min(1).max(100),
});

export type Invitation = z.infer<typeof InvitationSchema>;
export type InvitationInput = Omit<
  Invitation,
  'v' | 'invite_id' | 'host_user_id' | 'host_public_key'
>;

export class InvitationFormatError extends Error {
  readonly code: 'INVITE_MALFORMED' | 'INVITE_BAD_SIGNATURE';
  constructor(code: InvitationFormatError['code'], message: string) {
    super(message);
    this.name = 'InvitationFormatError';
    this.code = code;
  }
}

export function encodeInvitation(
  input: InvitationInput,
  hostPrivateKey: KeyObject,
): {
  token: string;
  invitation: Invitation;
} {
  const raw = rawPublicKey(hostPrivateKey);
  const invitation = InvitationSchema.parse({
    ...input,
    v: 1,
    // 128 random bits: the invitation id doubles as the bearer secret (threat model T05).
    invite_id: randomBytes(16).toString('base64url'),
    host_user_id: userIdFromPublicKey(raw),
    host_public_key: raw.toString('base64url'),
  });
  const body = Buffer.from(canonicalJson(invitation), 'utf8');
  const signature = sign(null, body, hostPrivateKey);
  return {
    token: `${INVITATION_PREFIX}${body.toString('base64url')}.${signature.toString('base64url')}`,
    invitation,
  };
}

/**
 * Parses a token and verifies it was signed by the host key it names. This proves integrity and
 * who issued it, not that it is still valid: only the host knows remaining uses and revocations.
 */
export function decodeInvitation(token: string): Invitation {
  const trimmed = token.trim();
  if (!trimmed.startsWith(INVITATION_PREFIX)) {
    throw new InvitationFormatError('INVITE_MALFORMED', 'not a Pearcoder invitation');
  }
  const [bodyPart, sigPart, ...rest] = trimmed.slice(INVITATION_PREFIX.length).split('.');
  if (!bodyPart || !sigPart || rest.length > 0) {
    throw new InvitationFormatError('INVITE_MALFORMED', 'invitation has the wrong shape');
  }
  const body = Buffer.from(bodyPart, 'base64url');
  let invitation: Invitation;
  try {
    invitation = InvitationSchema.parse(JSON.parse(body.toString('utf8')));
  } catch {
    throw new InvitationFormatError('INVITE_MALFORMED', 'invitation content is invalid');
  }
  // Reject non-canonical encodings so one invitation has exactly one valid token.
  if (canonicalJson(invitation) !== body.toString('utf8')) {
    throw new InvitationFormatError('INVITE_MALFORMED', 'invitation is not canonically encoded');
  }
  const hostKey = publicKeyFromRaw(invitation.host_public_key);
  if (
    userIdFromPublicKey(Buffer.from(invitation.host_public_key, 'base64url')) !==
    invitation.host_user_id
  ) {
    throw new InvitationFormatError('INVITE_BAD_SIGNATURE', 'host id does not match host key');
  }
  let valid = false;
  try {
    valid = verify(null, body, hostKey, Buffer.from(sigPart, 'base64url'));
  } catch {
    valid = false;
  }
  if (!valid)
    throw new InvitationFormatError('INVITE_BAD_SIGNATURE', 'invitation signature is invalid');
  return invitation;
}
