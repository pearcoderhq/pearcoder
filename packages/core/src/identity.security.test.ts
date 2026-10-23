// Covers: T02, T17
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IdentityError,
  loadOrCreateDeviceIdentity,
  readProfile,
  writeProfile,
} from './identity.js';

const posix = process.platform !== 'win32';

describe('device identity', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pearcoder-identity-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('creates a key once and reloads the same identity', () => {
    const first = loadOrCreateDeviceIdentity(home);
    const second = loadOrCreateDeviceIdentity(home);
    expect(second.userId).toBe(first.userId);
    expect(second.publicKey).toBe(first.publicKey);
    expect(first.userId).toMatch(/^u_/);
    expect(first.keyId).toMatch(/^k_/);
  });

  it('gives different devices different identities', () => {
    const other = mkdtempSync(join(tmpdir(), 'pearcoder-identity-'));
    try {
      expect(loadOrCreateDeviceIdentity(home).userId).not.toBe(
        loadOrCreateDeviceIdentity(other).userId,
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it.runIf(posix)('writes the key 0600 inside a 0700 directory', () => {
    loadOrCreateDeviceIdentity(home);
    expect(statSync(join(home, 'identity')).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, 'identity', 'device-key.pem')).mode & 0o777).toBe(0o600);
  });

  it.runIf(posix)('refuses a key readable by other users', () => {
    loadOrCreateDeviceIdentity(home);
    chmodSync(join(home, 'identity', 'device-key.pem'), 0o644);
    expect(() => loadOrCreateDeviceIdentity(home)).toThrow(IdentityError);
    try {
      loadOrCreateDeviceIdentity(home);
    } catch (error) {
      expect((error as IdentityError).code).toBe('IDENTITY_INSECURE_PERMISSIONS');
    }
  });

  it.runIf(posix)('refuses an identity directory open to other users', () => {
    loadOrCreateDeviceIdentity(home);
    chmodSync(join(home, 'identity'), 0o755);
    expect(() => loadOrCreateDeviceIdentity(home)).toThrow(/accessible by other users/);
  });

  it('rejects a corrupt key file', () => {
    loadOrCreateDeviceIdentity(home);
    writeFileSync(join(home, 'identity', 'device-key.pem'), 'not a key', { mode: 0o600 });
    expect(() => loadOrCreateDeviceIdentity(home)).toThrow(IdentityError);
  });
});

describe('profile', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pearcoder-profile-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('round-trips and validates the display name', () => {
    expect(readProfile(home)).toBeUndefined();
    writeProfile({ display_name: 'Alice' }, home);
    expect(readProfile(home)).toEqual({ display_name: 'Alice' });
    expect(() => writeProfile({ display_name: '' }, home)).toThrow();
  });
});
