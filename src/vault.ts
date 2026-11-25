// Key hierarchy:
//   vault password --Argon2id--> KEK --wraps--> vault key (random, 256-bit) --encrypts--> notes
//   recovery key (random, shown once) --BLAKE2b--> recovery KEK --wraps--> the same vault key
// The header holds only wrapped keys, so it is safe to store next to the ciphertext on a sync
// server. A MAC under the vault key stops anyone without the key from swapping in a forged header.
import {
  DEFAULT_KDF_COST, DecryptError, deriveKey, deriveSubkey, fromHex, isSealed, mac, newKdfParams, open,
  openString, randomBytes, randomKey, seal, toB64, toHex, verifyMac, wipe,
  type KdfParams, type Sealed,
} from './crypto';
import { now } from './model';

export interface VaultHeader {
  format: 'cherrion-vault';
  v: 1;
  vaultId: string;
  createdAt: number;
  updatedAt: number;
  kdf: KdfParams;
  passwordWrap: Sealed;
  recoveryWrap: Sealed;
  /** Encrypted Profile (user name). Absent in vaults created before profiles existed. */
  profile?: Sealed;
  mac: string;
}

export interface Profile { userName: string }

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_USER_NAME = 60;

export class WrongSecretError extends Error {
  constructor(message: string) { super(message); this.name = 'WrongSecretError'; }
}

const wrapAad = (vaultId: string, slot: 'password' | 'recovery') => `cherrion/vault/v1/${vaultId}/${slot}`;
const profileAad = (vaultId: string) => `cherrion/vault/v1/${vaultId}/profile`;
const RECOVERY_CONTEXT = 'cherrion/recovery/v1';
const HEADER_MAC_CONTEXT = 'cherrion/header-mac/v1';

type UnsignedHeader = Omit<VaultHeader, 'mac'>;

function headerMessage(h: UnsignedHeader): string {
  const parts: (string | number)[] = [
    h.format, h.v, h.vaultId, h.createdAt, h.updatedAt,
    h.kdf.alg, h.kdf.opslimit, h.kdf.memlimit, h.kdf.salt,
    h.passwordWrap.nonce, h.passwordWrap.ct, h.recoveryWrap.nonce, h.recoveryWrap.ct,
  ];
  // Appended only when present, so headers created before profiles existed still verify.
  if (h.profile) parts.push(h.profile.nonce, h.profile.ct);
  return JSON.stringify(parts);
}

/** Trims, collapses whitespace and caps the length. */
export function normalizeUserName(name: string): string {
  return name.normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, MAX_USER_NAME);
}

const sealProfile = (vaultKey: Uint8Array, vaultId: string, profile: Profile): Sealed =>
  seal(vaultKey, JSON.stringify({ userName: normalizeUserName(profile.userName) }), profileAad(vaultId));

export function readProfile(h: VaultHeader, vaultKey: Uint8Array): Profile | null {
  if (!h.profile) return null;
  try {
    const raw = JSON.parse(openString(vaultKey, h.profile, profileAad(h.vaultId))) as { userName?: unknown };
    return typeof raw.userName === 'string' ? { userName: normalizeUserName(raw.userName) } : null;
  } catch {
    return null;
  }
}

/** Replaces the encrypted profile (e.g. a new user name). */
export function setProfile(header: VaultHeader, vaultKey: Uint8Array, profile: Profile): VaultHeader {
  const { mac: _old, ...rest } = header;
  return sign(vaultKey, {
    ...rest,
    updatedAt: Math.max(now(), header.updatedAt + 1),
    profile: sealProfile(vaultKey, header.vaultId, profile),
  });
}

function sign(vaultKey: Uint8Array, h: UnsignedHeader): VaultHeader {
  const k = deriveSubkey(vaultKey, HEADER_MAC_CONTEXT);
  try { return { ...h, mac: mac(k, headerMessage(h)) }; } finally { wipe(k); }
}

/** True when the header was produced by someone holding this vault key. */
export function verifyHeader(h: VaultHeader, vaultKey: Uint8Array): boolean {
  const k = deriveSubkey(vaultKey, HEADER_MAC_CONTEXT);
  try { return verifyMac(k, headerMessage(h), h.mac); } finally { wipe(k); }
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters. A few random words work well.`;
  if (/^(.)\1*$/.test(password)) return 'Use a password that is not one repeated character.';
  return null;
}

export interface NewVault { header: VaultHeader; vaultKey: Uint8Array; recoveryKey: string }

export function createVault(password: string, cost = DEFAULT_KDF_COST, profile?: Profile): NewVault {
  const vaultKey = randomKey();
  const recovery = randomBytes(32);
  const vaultId = toB64(randomBytes(16));
  const kdf = newKdfParams(cost);
  const kek = deriveKey(password, kdf);
  const recoveryKek = deriveSubkey(recovery, RECOVERY_CONTEXT);
  try {
    const t = now();
    const header = sign(vaultKey, {
      format: 'cherrion-vault', v: 1, vaultId, createdAt: t, updatedAt: t, kdf,
      passwordWrap: seal(kek, vaultKey, wrapAad(vaultId, 'password')),
      recoveryWrap: seal(recoveryKek, vaultKey, wrapAad(vaultId, 'recovery')),
      ...(profile ? { profile: sealProfile(vaultKey, vaultId, profile) } : {}),
    });
    return { header, vaultKey, recoveryKey: formatRecoveryKey(recovery) };
  } finally {
    wipe(kek); wipe(recoveryKek); wipe(recovery);
  }
}

function unwrap(header: VaultHeader, kek: Uint8Array, slot: 'password' | 'recovery', wrongMessage: string): Uint8Array {
  let vaultKey: Uint8Array;
  try {
    vaultKey = open(kek, slot === 'password' ? header.passwordWrap : header.recoveryWrap, wrapAad(header.vaultId, slot));
  } catch (err) {
    if (err instanceof DecryptError) throw new WrongSecretError(wrongMessage);
    throw err;
  } finally {
    wipe(kek);
  }
  if (!verifyHeader(header, vaultKey)) {
    wipe(vaultKey);
    throw new Error('The vault header failed its integrity check.');
  }
  return vaultKey;
}

export function unlockWithPassword(header: VaultHeader, password: string): Uint8Array {
  return unwrap(header, deriveKey(password, header.kdf), 'password', 'Wrong password.');
}

export function unlockWithRecoveryKey(header: VaultHeader, recoveryKey: string): Uint8Array {
  const bytes = parseRecoveryKey(recoveryKey);
  try {
    return unwrap(header, deriveSubkey(bytes, RECOVERY_CONTEXT), 'recovery', 'That recovery key does not match this vault.');
  } finally {
    wipe(bytes);
  }
}

/** New password (with a fresh salt) for the same vault key. Notes do not need re-encrypting. */
export function rewrapPassword(header: VaultHeader, vaultKey: Uint8Array, newPassword: string, cost = DEFAULT_KDF_COST): VaultHeader {
  const kdf = newKdfParams(cost);
  const kek = deriveKey(newPassword, kdf);
  try {
    const { mac: _old, ...rest } = header;
    return sign(vaultKey, {
      ...rest,
      kdf,
      updatedAt: Math.max(now(), header.updatedAt + 1),
      passwordWrap: seal(kek, vaultKey, wrapAad(header.vaultId, 'password')),
    });
  } finally {
    wipe(kek);
  }
}

/** Replaces the recovery slot. The previous recovery key stops working. */
export function rotateRecoveryKey(header: VaultHeader, vaultKey: Uint8Array): { header: VaultHeader; recoveryKey: string } {
  const recovery = randomBytes(32);
  const recoveryKek = deriveSubkey(recovery, RECOVERY_CONTEXT);
  try {
    const { mac: _old, ...rest } = header;
    const next = sign(vaultKey, {
      ...rest,
      updatedAt: Math.max(now(), header.updatedAt + 1),
      recoveryWrap: seal(recoveryKek, vaultKey, wrapAad(header.vaultId, 'recovery')),
    });
    return { header: next, recoveryKey: formatRecoveryKey(recovery) };
  } finally {
    wipe(recoveryKek); wipe(recovery);
  }
}

/** 32 random bytes as 8 groups of 8 upper-case hex digits. */
export function formatRecoveryKey(bytes: Uint8Array): string {
  return (toHex(bytes).toUpperCase().match(/.{8}/g) ?? []).join('-');
}

export function parseRecoveryKey(text: string): Uint8Array {
  const hex = text.replace(/[\s-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new WrongSecretError('A recovery key is 64 letters and digits (0-9, A-F), usually in 8 groups.');
  return fromHex(hex);
}

const isInt = (x: unknown, min: number, max: number): x is number =>
  typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;

/** Structural check for headers read from a sync server or backup file, with bounded KDF cost. */
export function isVaultHeader(x: unknown): x is VaultHeader {
  if (typeof x !== 'object' || x === null) return false;
  const h = x as Partial<VaultHeader>;
  const kdf = h.kdf as Partial<KdfParams> | undefined;
  return h.format === 'cherrion-vault' && h.v === 1
    && typeof h.vaultId === 'string' && h.vaultId.length > 0
    && isInt(h.createdAt, 0, Number.MAX_SAFE_INTEGER) && isInt(h.updatedAt, 0, Number.MAX_SAFE_INTEGER)
    && typeof kdf === 'object' && kdf !== null && kdf.alg === 'argon2id13'
    && isInt(kdf.opslimit, 1, 10) && isInt(kdf.memlimit, 8192, 1024 * 1024 * 1024)
    && typeof kdf.salt === 'string'
    && isSealed(h.passwordWrap) && isSealed(h.recoveryWrap)
    && (h.profile === undefined || isSealed(h.profile))
    && typeof h.mac === 'string';
}
