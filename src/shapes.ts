// Structural validation shared by the browser and the API (api/). No crypto library imports here,
// so serverless functions stay small.
import type { Sealed, KdfParams } from './crypto';
import type { Envelope } from './envelope';
import { VAULT_RECORD_ID } from './model.js'; // explicit .js: this file is also bundled into api/ functions (Node ESM)
import type { VaultHeader } from './vault';

const isInt = (x: unknown, min: number, max: number): x is number =>
  typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;

export function isSealed(x: unknown): x is Sealed {
  return typeof x === 'object' && x !== null
    && typeof (x as Sealed).nonce === 'string' && typeof (x as Sealed).ct === 'string';
}

/** Argon2id parameters with a bounded cost, so a hostile server or file cannot exhaust memory. */
export function isKdfParams(x: unknown): x is KdfParams {
  const k = x as Partial<KdfParams> | null;
  return typeof k === 'object' && k !== null && k.alg === 'argon2id13'
    && isInt(k.opslimit, 1, 10) && isInt(k.memlimit, 8192, 1024 * 1024 * 1024)
    && typeof k.salt === 'string' && k.salt.length > 0;
}

/** Structural check for headers read from the server or a backup file. */
export function isVaultHeader(x: unknown): x is VaultHeader {
  if (typeof x !== 'object' || x === null) return false;
  const h = x as Partial<VaultHeader>;
  return h.format === 'cherrion-vault' && h.v === 1
    && typeof h.vaultId === 'string' && h.vaultId.length > 0
    && isInt(h.createdAt, 0, Number.MAX_SAFE_INTEGER) && isInt(h.updatedAt, 0, Number.MAX_SAFE_INTEGER)
    && isKdfParams(h.kdf)
    && isSealed(h.passwordWrap) && isSealed(h.recoveryWrap)
    && (h.profile === undefined || isSealed(h.profile))
    && (h.identity === undefined || (typeof h.identity === 'object' && h.identity !== null
      && typeof h.identity.publicKey === 'string' && /^[A-Za-z0-9_-]{43}$/.test(h.identity.publicKey) && isSealed(h.identity.privateKey)))
    && typeof h.mac === 'string';
}

export function isEnvelope(x: unknown): x is Envelope {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Partial<Envelope>;
  return typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 64 && e.id !== VAULT_RECORD_ID
    && typeof e.updatedAt === 'number' && Number.isFinite(e.updatedAt)
    && typeof e.deleted === 'boolean' && e.v === 1
    && typeof e.nonce === 'string' && typeof e.ct === 'string'
    && (e.k === undefined || isInt(e.k, 1, 1_000_000));
}
