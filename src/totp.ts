// Time-based one-time passwords (RFC 6238), the codes authenticator apps show.
// Accepts a Base32 secret key ("JBSW Y3DP EHPK 3PXP") or an otpauth://totp/... link.
// HMAC runs on WebCrypto, which browsers only expose on https:// and localhost.

export type TotpAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-512';
export interface TotpParams {
  secret: Uint8Array<ArrayBuffer>;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  issuer?: string;
  account?: string;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 Base32, ignoring case, spaces, dashes and padding. Returns null for invalid input. */
export function base32Decode(text: string): Uint8Array<ArrayBuffer> | null {
  const clean = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let bits = 0;
  let acc = 0;
  let i = 0;
  for (const ch of clean) {
    acc = (acc << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[i++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}

const ALGORITHMS: Record<string, TotpAlgorithm> = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

/** Parses what a user pastes from a 2FA setup page. Returns null if it is not a usable TOTP key. */
export function parseTotp(input: string): TotpParams | null {
  const text = input.trim();
  if (!text) return null;
  let secretText = text;
  let algorithm: TotpAlgorithm = 'SHA-1';
  let digits = 6;
  let period = 30;
  let issuer: string | undefined;
  let account: string | undefined;

  if (/^otpauth:/i.test(text)) {
    let url: URL;
    try { url = new URL(text); } catch { return null; }
    if (url.host.toLowerCase() !== 'totp') return null; // HOTP (counter-based) is not supported
    const p = url.searchParams;
    secretText = p.get('secret') ?? '';
    const alg = ALGORITHMS[(p.get('algorithm') ?? 'SHA1').toUpperCase()];
    if (!alg) return null;
    algorithm = alg;
    digits = Number(p.get('digits') ?? 6);
    period = Number(p.get('period') ?? 30);
    const label = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const [labelIssuer, labelAccount] = label.includes(':') ? label.split(/:(.*)/s) : [undefined, label];
    issuer = p.get('issuer') ?? labelIssuer ?? undefined;
    account = labelAccount?.trim() || undefined;
  }

  const secret = base32Decode(secretText);
  if (!secret || secret.length < 10) return null; // 80 bits is the shortest key services issue
  if (![6, 7, 8].includes(digits) || !Number.isInteger(period) || period < 10 || period > 300) return null;
  return { secret, algorithm, digits, period, ...(issuer ? { issuer } : {}), ...(account ? { account } : {}) };
}

export const totpAvailable = (): boolean => typeof crypto !== 'undefined' && !!crypto.subtle;

/** The code for the time step containing `timeMs`. */
export async function totpCode(params: TotpParams, timeMs: number): Promise<string> {
  const counter = Math.floor(timeMs / 1000 / params.period);
  const message = new ArrayBuffer(8);
  const view = new DataView(message);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey('raw', params.secret, { name: 'HMAC', hash: params.algorithm }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** params.digits).padStart(params.digits, '0');
}

/** Seconds left before the code changes. */
export function secondsRemaining(params: TotpParams, timeMs: number): number {
  return params.period - (Math.floor(timeMs / 1000) % params.period);
}

/** "123456" → "123 456", the way authenticator apps group digits. */
export function formatCode(code: string): string {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)} ${code.slice(half)}`;
}
