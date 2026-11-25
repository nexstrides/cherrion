import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_KDF_COST, DecryptError, initCrypto, open, openString, randomKey, seal } from '../src/crypto';
import {
  createVault, formatRecoveryKey, isVaultHeader, normalizeUserName, parseRecoveryKey, passwordProblem, readProfile,
  rewrapPassword, rotateRecoveryKey, setProfile, unlockWithPassword, unlockWithRecoveryKey, verifyHeader,
  WrongSecretError,
} from '../src/vault';

// Minimum Argon2id cost keeps the suite fast; one test below exercises the real default.
const FAST = { opslimit: 1, memlimit: 8192 };
const PASSWORD = 'correct horse battery staple';

beforeAll(() => initCrypto());

/** Two keys are equal if one can open what the other sealed. */
function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  try { open(b, seal(a, 'probe', 'test'), 'test'); return true; } catch { return false; }
}

describe('seal / open', () => {
  it('round-trips with the same key and associated data', () => {
    const key = randomKey();
    expect(openString(key, seal(key, 'hello', 'aad'), 'aad')).toBe('hello');
  });

  it('rejects a different key', () => {
    expect(() => open(randomKey(), seal(randomKey(), 'hello', 'aad'), 'aad')).toThrow(DecryptError);
  });

  it('rejects different associated data', () => {
    const key = randomKey();
    expect(() => open(key, seal(key, 'hello', 'aad-1'), 'aad-2')).toThrow(DecryptError);
  });

  it('uses a fresh nonce every time', () => {
    const key = randomKey();
    expect(seal(key, 'same', 'aad').nonce).not.toBe(seal(key, 'same', 'aad').nonce);
  });
});

describe('vault', () => {
  it('unlocks with the password and returns the vault key', () => {
    const v = createVault(PASSWORD, FAST);
    expect(sameKey(unlockWithPassword(v.header, PASSWORD), v.vaultKey)).toBe(true);
  });

  it('normalises Unicode in passwords', () => {
    const v = createVault('pássword-long', FAST); // "a" + combining acute
    expect(sameKey(unlockWithPassword(v.header, 'pássword-long'), v.vaultKey)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const v = createVault(PASSWORD, FAST);
    expect(() => unlockWithPassword(v.header, 'wrong password!!')).toThrow(WrongSecretError);
  });

  it('unlocks with the recovery key, ignoring case, spaces and dashes', () => {
    const v = createVault(PASSWORD, FAST);
    const sloppy = ` ${v.recoveryKey.toLowerCase().replace(/-/g, ' ')} `;
    expect(sameKey(unlockWithRecoveryKey(v.header, sloppy), v.vaultKey)).toBe(true);
  });

  it('rejects a well-formed but wrong recovery key, and malformed input', () => {
    const v = createVault(PASSWORD, FAST);
    const other = createVault(PASSWORD, FAST);
    expect(() => unlockWithRecoveryKey(v.header, other.recoveryKey)).toThrow(WrongSecretError);
    expect(() => unlockWithRecoveryKey(v.header, 'not-a-key')).toThrow(WrongSecretError);
  });

  it('formats recovery keys as 8 groups of 8 hex digits and parses them back', () => {
    const bytes = new Uint8Array(32).map((_, i) => i * 7);
    const text = formatRecoveryKey(bytes);
    expect(text).toMatch(/^([0-9A-F]{8}-){7}[0-9A-F]{8}$/);
    expect(Array.from(parseRecoveryKey(text))).toEqual(Array.from(bytes));
  });

  it('changes the password without changing the vault key', () => {
    const v = createVault(PASSWORD, FAST);
    const next = rewrapPassword(v.header, v.vaultKey, 'a brand new password', FAST);
    expect(next.updatedAt).toBeGreaterThan(v.header.updatedAt);
    expect(next.kdf.salt).not.toBe(v.header.kdf.salt);
    expect(() => unlockWithPassword(next, PASSWORD)).toThrow(WrongSecretError);
    expect(sameKey(unlockWithPassword(next, 'a brand new password'), v.vaultKey)).toBe(true);
    // The recovery key keeps working after a password change.
    expect(sameKey(unlockWithRecoveryKey(next, v.recoveryKey), v.vaultKey)).toBe(true);
  });

  it('rotates the recovery key', () => {
    const v = createVault(PASSWORD, FAST);
    const rotated = rotateRecoveryKey(v.header, v.vaultKey);
    expect(() => unlockWithRecoveryKey(rotated.header, v.recoveryKey)).toThrow(WrongSecretError);
    expect(sameKey(unlockWithRecoveryKey(rotated.header, rotated.recoveryKey), v.vaultKey)).toBe(true);
    expect(sameKey(unlockWithPassword(rotated.header, PASSWORD), v.vaultKey)).toBe(true);
  });

  it('detects a tampered header even when the password is right', () => {
    const v = createVault(PASSWORD, FAST);
    const tampered = { ...v.header, createdAt: v.header.createdAt - 1000 };
    expect(() => unlockWithPassword(tampered, PASSWORD)).toThrow(/integrity/);
  });

  it('only verifies headers signed with this vault key', () => {
    const v = createVault(PASSWORD, FAST);
    const forged = { ...createVault(PASSWORD, FAST).header, vaultId: v.header.vaultId };
    expect(verifyHeader(v.header, v.vaultKey)).toBe(true);
    expect(verifyHeader(forged, v.vaultKey)).toBe(false);
  });

  it('validates header shape and bounds the KDF cost', () => {
    const { header } = createVault(PASSWORD, FAST);
    expect(isVaultHeader(header)).toBe(true);
    expect(isVaultHeader(JSON.parse(JSON.stringify(header)))).toBe(true);
    expect(isVaultHeader({ ...header, kdf: { ...header.kdf, memlimit: 8 * 1024 * 1024 * 1024 } })).toBe(false);
    expect(isVaultHeader({ ...header, kdf: { ...header.kdf, alg: 'pbkdf2' } })).toBe(false);
    expect(isVaultHeader({ ...header, mac: undefined })).toBe(false);
  });

  it('works with the default Argon2id cost (64 MiB)', () => {
    const v = createVault(PASSWORD, DEFAULT_KDF_COST);
    expect(v.header.kdf.memlimit).toBe(64 * 1024 * 1024);
    expect(sameKey(unlockWithPassword(v.header, PASSWORD), v.vaultKey)).toBe(true);
  }, 30_000);

  it('stores the user name encrypted in the header', () => {
    const v = createVault(PASSWORD, FAST, { userName: 'Albert' });
    expect(JSON.stringify(v.header)).not.toContain('Albert');
    expect(isVaultHeader(JSON.parse(JSON.stringify(v.header)))).toBe(true);
    expect(verifyHeader(v.header, v.vaultKey)).toBe(true);
    const key = unlockWithPassword(v.header, PASSWORD);
    expect(readProfile(v.header, key)).toEqual({ userName: 'Albert' });
  });

  it('keeps headers created before profiles existed valid', () => {
    const v = createVault(PASSWORD, FAST);
    expect(v.header.profile).toBeUndefined();
    expect(verifyHeader(v.header, v.vaultKey)).toBe(true);
    expect(readProfile(v.header, v.vaultKey)).toBeNull();
    // Adding a name later works and keeps password and recovery key valid.
    const named = setProfile(v.header, v.vaultKey, { userName: 'Albert' });
    expect(named.updatedAt).toBeGreaterThan(v.header.updatedAt);
    expect(readProfile(named, unlockWithPassword(named, PASSWORD))).toEqual({ userName: 'Albert' });
    expect(sameKey(unlockWithRecoveryKey(named, v.recoveryKey), v.vaultKey)).toBe(true);
  });

  it('keeps the profile through password changes and recovery-key rotation', () => {
    const v = createVault(PASSWORD, FAST, { userName: 'Albert' });
    const changed = rewrapPassword(v.header, v.vaultKey, 'another long password', FAST);
    const rotated = rotateRecoveryKey(changed, v.vaultKey).header;
    expect(readProfile(rotated, v.vaultKey)).toEqual({ userName: 'Albert' });
  });

  it('detects a profile swapped in from another vault', () => {
    const v = createVault(PASSWORD, FAST, { userName: 'Albert' });
    const other = createVault(PASSWORD, FAST, { userName: 'Mallory' });
    const swapped = { ...v.header, profile: other.header.profile };
    expect(verifyHeader(swapped, v.vaultKey)).toBe(false);
    expect(readProfile(swapped, v.vaultKey)).toBeNull();
  });

  it('normalises user names', () => {
    expect(normalizeUserName('  Albert \n  Smith  ')).toBe('Albert Smith');
    expect(normalizeUserName('x'.repeat(100))).toHaveLength(60);
    expect(normalizeUserName('   ')).toBe('');
  });

  it('rejects weak passwords', () => {
    expect(passwordProblem('short')).toMatch(/at least/);
    expect(passwordProblem('aaaaaaaaaaaa')).toMatch(/repeated/);
    expect(passwordProblem(PASSWORD)).toBeNull();
  });
});
