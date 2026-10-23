import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentHarness,
  AgentHarnessSchema,
  type KeyId,
  keyIdFromPublicKey,
  rawPublicKey,
  type UserId,
  userIdFromPublicKey,
} from '@pearcoderhq/protocol';
import { z } from 'zod';
import { PearcoderError } from './errors.js';

export type IdentityErrorCode =
  | 'IDENTITY_INSECURE_PERMISSIONS'
  | 'IDENTITY_INVALID_KEY'
  | 'PROFILE_INVALID';

export class IdentityError extends PearcoderError<IdentityErrorCode> {}

export interface DeviceIdentity {
  userId: UserId;
  keyId: KeyId;
  /** Raw Ed25519 public key, base64url. Shared in `participant.joined`. */
  publicKey: string;
  publicKeyObject: KeyObject;
  privateKey: KeyObject;
}

const IDENTITY_DIR = 'identity';
const KEY_FILE = 'device-key.pem';
const PROFILE_FILE = 'profile.json';
const AGENTS_FILE = 'agents.json';

export function pearcoderHome(): string {
  return process.env.PEARCODER_HOME ?? join(homedir(), '.pearcoder');
}

// Secrets must not be readable by other users (threat model T17). Windows relies on the
// per-user profile ACL; POSIX mode bits are checked on every load.
function assertPrivate(path: string): void {
  if (process.platform === 'win32') return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new IdentityError(
      'IDENTITY_INSECURE_PERMISSIONS',
      `${path} is accessible by other users (mode ${mode.toString(8)}); run chmod go-rwx on it`,
    );
  }
}

function toIdentity(privateKey: KeyObject): DeviceIdentity {
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new IdentityError('IDENTITY_INVALID_KEY', 'device key is not an Ed25519 key');
  }
  const publicKeyObject = createPublicKey(privateKey);
  const raw = rawPublicKey(publicKeyObject);
  return {
    userId: userIdFromPublicKey(raw),
    keyId: keyIdFromPublicKey(raw),
    publicKey: raw.toString('base64url'),
    publicKeyObject,
    privateKey,
  };
}

/** Loads this device's key from `<home>/identity`, creating it on first run. */
export function loadOrCreateDeviceIdentity(home = pearcoderHome()): DeviceIdentity {
  const dir = join(home, IDENTITY_DIR);
  const file = join(dir, KEY_FILE);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
    // `wx` never overwrites: a concurrent first run keeps whichever key was written first.
    try {
      writeFileSync(file, pem, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  assertPrivate(dir);
  assertPrivate(file);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new IdentityError('IDENTITY_INVALID_KEY', `cannot read device key at ${file}`, {
      cause: error,
    });
  }
  return toIdentity(privateKey);
}

export const ProfileSchema = z.object({
  display_name: z.string().trim().min(1).max(80),
});
export type Profile = z.infer<typeof ProfileSchema>;

export function readProfile(home = pearcoderHome()): Profile | undefined {
  const file = join(home, PROFILE_FILE);
  if (!existsSync(file)) return undefined;
  const parsed = ProfileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new IdentityError('PROFILE_INVALID', `invalid profile at ${file}`);
  return parsed.data;
}

export function writeProfile(profile: Profile, home = pearcoderHome()): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, PROFILE_FILE), `${JSON.stringify(ProfileSchema.parse(profile))}\n`, {
    mode: 0o600,
  });
}

const AttachedAgentsSchema = z.object({ agents: z.array(AgentHarnessSchema).max(4) });

/** Agent harnesses `pearcoder attach` connected on this device; announced in presence. */
export function readAttachedAgents(home = pearcoderHome()): AgentHarness[] {
  const file = join(home, AGENTS_FILE);
  if (!existsSync(file)) return [];
  const parsed = AttachedAgentsSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  return parsed.success ? parsed.data.agents : [];
}

export function recordAttachedAgent(harness: AgentHarness, home = pearcoderHome()): void {
  const agents = [...new Set([...readAttachedAgents(home), harness])];
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, AGENTS_FILE), `${JSON.stringify({ agents })}\n`, { mode: 0o600 });
}
