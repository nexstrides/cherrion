// Thin wrapper over libsodium. All encryption in the app goes through seal/open:
// XChaCha20-Poly1305 with a random 192-bit nonce and associated data that binds each
// ciphertext to the record it belongs to.
import sodium from 'libsodium-wrappers-sumo';

export interface KdfParams { alg: 'argon2id13'; opslimit: number; memlimit: number; salt: string }
export interface Sealed { nonce: string; ct: string }

/** Argon2id cost: 3 passes over 64 MiB (the same order as Bitwarden's Argon2id default). */
export const DEFAULT_KDF_COST = { opslimit: 3, memlimit: 64 * 1024 * 1024 };

export class DecryptError extends Error {
  constructor(message = 'Decryption failed') { super(message); this.name = 'DecryptError'; }
}

let ready: Promise<void> | null = null;
export function initCrypto(): Promise<void> {
  ready ??= sodium.ready;
  return ready;
}

const variant = () => sodium.base64_variants.URLSAFE_NO_PADDING;
export const toB64 = (bytes: Uint8Array): string => sodium.to_base64(bytes, variant());
export const fromB64 = (text: string): Uint8Array => sodium.from_base64(text, variant());

export const randomBytes = (n: number): Uint8Array => sodium.randombytes_buf(n);
export const randomKey = (): Uint8Array => sodium.crypto_aead_xchacha20poly1305_ietf_keygen();

export function newKdfParams(cost = DEFAULT_KDF_COST): KdfParams {
  return { alg: 'argon2id13', ...cost, salt: toB64(randomBytes(sodium.crypto_pwhash_SALTBYTES)) };
}

/** Argon2id. Blocks the calling thread for roughly half a second to a few seconds with the default cost. */
export function deriveKey(password: string, kdf: KdfParams): Uint8Array {
  return sodium.crypto_pwhash(
    32, password.normalize('NFKC'), fromB64(kdf.salt), kdf.opslimit, kdf.memlimit, sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/** Domain-separated subkey from high-entropy input key material (BLAKE2b keyed by the input). */
export function deriveSubkey(ikm: Uint8Array, context: string): Uint8Array {
  return sodium.crypto_generichash(32, sodium.from_string(context), ikm);
}

export function seal(key: Uint8Array, plaintext: Uint8Array | string, aad: string): Sealed {
  const nonce = randomBytes(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key);
  return { nonce: toB64(nonce), ct: toB64(ct) };
}

export function open(key: Uint8Array, sealed: Sealed, aad: string): Uint8Array {
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, fromB64(sealed.ct), aad, fromB64(sealed.nonce), key);
  } catch {
    throw new DecryptError();
  }
}

export const openString = (key: Uint8Array, sealed: Sealed, aad: string): string =>
  sodium.to_string(open(key, sealed, aad));

/** Keyed BLAKE2b MAC, base64. */
export const mac = (key: Uint8Array, message: string): string =>
  toB64(sodium.crypto_generichash(32, message, key));

/** Constant-time MAC check. */
export function verifyMac(key: Uint8Array, message: string, expected: string): boolean {
  let given: Uint8Array;
  try { given = fromB64(expected); } catch { return false; }
  const actual = sodium.crypto_generichash(32, message, key);
  return given.length === actual.length && sodium.memcmp(given, actual);
}

/** Overwrites key material in place. */
export function wipe(bytes: Uint8Array | null | undefined): void {
  if (bytes) sodium.memzero(bytes);
}

export const toHex = (bytes: Uint8Array): string => sodium.to_hex(bytes);
export const fromHex = (hex: string): Uint8Array => sodium.from_hex(hex);

export { isSealed } from './shapes';
