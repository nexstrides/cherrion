// The owner's keys, all made and used in the admin's browser:
// - Setup: an admin password (Argon2id) gives a one-way auth key (the server keeps its SHA-256) and a
//   key that encrypts the owner's X25519 private key. Everything goes into one CHERRION_ADMIN value.
// - Recovery: a user's escrowed vault key is unsealed here, checked against their header, and used
//   to make a new recovery key. The vault key never reaches the server.
import {
  DEFAULT_KDF_COST, deriveKey, deriveSubkey, fingerprint, fromB64, newBoxKeyPair, newKdfParams, open, openSealedBox,
  randomBytes, seal, toB64, wipe, type BoxKeyPair, type KdfParams, type Sealed,
} from '../crypto';
import { rotateRecoveryKey, verifyHeader, type VaultHeader } from '../vault';

const AUTH_CONTEXT = 'cherrion/admin-auth/v1';
const WRAP_CONTEXT = 'cherrion/admin-key/v1';
const privateKeyAad = (publicKey: string) => `cherrion/admin-private-key/v1/${publicKey}`;

export interface AdminConfig { v: 1; kdf: KdfParams; authHash: string; publicKey: string; privateKey: Sealed; totp: string }

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function base32Encode(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/** The admin auth key (base64url, as sent to the server) and the key that opens the private key. */
export function adminKeysFromPassword(password: string, kdf: KdfParams): { authKey: string; wrapKey: Uint8Array } {
  const kek = deriveKey(password, kdf);
  try {
    const auth = deriveSubkey(kek, AUTH_CONTEXT);
    const authKey = toB64(auth);
    wipe(auth);
    return { authKey, wrapKey: deriveSubkey(kek, WRAP_CONTEXT) };
  } finally {
    wipe(kek);
  }
}

export interface NewAdminSetup {
  config: AdminConfig;
  /** The value for the CHERRION_ADMIN environment variable (base64url JSON: safe to paste anywhere). */
  envValue: string;
  totpSecret: string;
  otpauthUri: string;
}

export async function createAdminSetup(password: string, cost = DEFAULT_KDF_COST): Promise<NewAdminSetup> {
  const kdf = newKdfParams(cost);
  const { authKey, wrapKey } = adminKeysFromPassword(password, kdf);
  const pair = newBoxKeyPair();
  const publicKey = toB64(pair.publicKey);
  try {
    const totpSecret = base32Encode(randomBytes(20));
    const config: AdminConfig = {
      v: 1, kdf, authHash: await sha256Hex(authKey), publicKey,
      privateKey: seal(wrapKey, pair.privateKey, privateKeyAad(publicKey)), totp: totpSecret,
    };
    const envValue = toB64(new TextEncoder().encode(JSON.stringify(config)));
    const otpauthUri = `otpauth://totp/Cherrion:admin?secret=${totpSecret}&issuer=Cherrion&algorithm=SHA1&digits=6&period=30`;
    return { config, envValue, totpSecret, otpauthUri };
  } finally {
    wipe(wrapKey);
    wipe(pair.privateKey);
  }
}

/** Opens the owner's private key after logging in (wrong password: throws). */
export function openAdminKey(wrapKey: Uint8Array, publicKey: string, privateKey: Sealed): BoxKeyPair {
  return { publicKey: fromB64(publicKey), privateKey: open(wrapKey, privateKey, privateKeyAad(publicKey)) };
}

/** A short code for the owner key; users see the same code in Settings → Owner recovery. */
export const ownerKeyCode = (publicKey: string): string =>
  fingerprint(fromB64(publicKey)).slice(0, 16).toUpperCase().match(/.{4}/g)!.join(' ');

/**
 * A new recovery key for a user who opted in: unseals their vault key, checks it really opens their
 * header, and makes a new recovery slot. Returns what the server needs and the key for the user.
 */
export function recoveryFromEscrow(header: VaultHeader, sealedVaultKey: string, owner: BoxKeyPair): { header: VaultHeader; recoveryKey: string; recoveryAuthKey: string } {
  let vaultKey: Uint8Array;
  try {
    vaultKey = openSealedBox(sealedVaultKey, owner);
  } catch {
    throw new Error('This account’s owner-recovery key was made for a different owner key. Ask the user to log in once (it updates by itself), then try again.');
  }
  try {
    if (!verifyHeader(header, vaultKey)) throw new Error('The stored key does not open this account. It cannot be recovered this way; use a reset code instead.');
    const next = rotateRecoveryKey(header, vaultKey);
    const recoveryAuthKey = toB64(next.recoveryAuthKey);
    wipe(next.recoveryAuthKey);
    return { header: next.header, recoveryKey: next.recoveryKey, recoveryAuthKey };
  } finally {
    wipe(vaultKey);
  }
}
