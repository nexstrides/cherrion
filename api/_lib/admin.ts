// Admin dashboard (api/admin.ts) and account help (api/support.ts): connection history, recovery
// requests, owner-assisted recovery and reset codes.
//
// The server stays zero-knowledge:
// - The admin logs in like a user (Argon2id in the browser -> one-way auth key) plus a 2FA code. The
//   admin's private key (X25519) is stored in CHERRION_ADMIN encrypted with the admin password and is
//   only ever unwrapped in the admin's browser.
// - Users who opt in ("escrow") seal their vault key to the admin public key. Only then can the
//   admin's browser make them a new recovery key. Everyone else can only be given a reset code, which
//   lets them start again with an empty vault.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isKdfParams, isSealed, isVaultHeader } from '../../src/shapes.js';
import type { KdfParams, Sealed } from '../../src/crypto.js';
import type { VaultHeader } from '../../src/vault.js';
import { authenticate, HttpError, normalizeUsername, newSession, type Repo } from './core.js';

// ---- Types ----

/** Where a request came from (Vercel sets these headers; clients cannot override them there). */
export interface ClientInfo { ip: string; userAgent: string; country: string; region: string; city: string }

export type EventKind =
  | 'signup' | 'login' | 'login_failed' | 'recover' | 'reset' | 'reset_failed' | 'recovery_request'
  | 'escrow_on' | 'escrow_off' | 'admin_login' | 'admin_login_failed' | 'admin_recovery_key' | 'admin_reset_code';

export interface EventRow extends ClientInfo {
  id: string; at: number; kind: EventKind; accountId: string | null; username: string | null;
}
export type NewEvent = Omit<EventRow, 'id' | 'at'>;

export interface UserRow {
  id: string; username: string; createdAt: number; notes: number; workspaces: number;
  lastSeenAt: number | null; lastIp: string | null; lastUserAgent: string | null;
  lastCountry: string | null; lastRegion: string | null; lastCity: string | null;
  /** The admin public key the user's vault key is sealed to, or null when they did not opt in. */
  escrowKey: string | null;
}

export type RequestStatus = 'open' | 'done' | 'dismissed';
export interface RecoveryRequest extends ClientInfo {
  id: string; at: number; username: string; accountId: string | null; contact: string; message: string; status: RequestStatus;
}

/** A user's vault key sealed (crypto_box_seal) to the admin public key `adminKey`. */
export interface Escrow { adminKey: string; sealed: string; at: number }

export interface AdminRepo {
  logEvent(e: NewEvent): Promise<void>;
  /** Newest first. */
  events(q: { accountId?: string; since: number; limit: number }): Promise<EventRow[]>;
  countEvents(q: { kinds: EventKind[]; ip?: string; since: number }): Promise<number>;
  pruneEvents(before: number): Promise<void>;
  /** Updates "last seen" (at most every few minutes, so syncing every 20 s costs no extra writes). */
  touchAccount(accountId: string, client: ClientInfo, at: number): Promise<void>;
  users(): Promise<UserRow[]>;
  getEscrow(accountId: string): Promise<Escrow | null>;
  setEscrow(accountId: string, escrow: Escrow | null): Promise<void>;
  createRequest(r: RecoveryRequest): Promise<void>;
  /** Newest first. */
  requests(limit: number): Promise<RecoveryRequest[]>;
  setRequestStatus(id: string, status: RequestStatus): Promise<void>;
  /** Replaces any earlier code for the account. */
  putResetCode(accountId: string, codeHash: string, expiresAt: number): Promise<void>;
  /** True (and the code is used up) when it matches and has not expired. */
  takeResetCode(accountId: string, codeHash: string, now: number): Promise<boolean>;
  createAdminSession(tokenHash: string, expiresAt: number): Promise<void>;
  findAdminSession(tokenHash: string, now: number): Promise<boolean>;
  deleteAdminSession(tokenHash: string): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  /** A fresh, empty vault for the account: notes, sessions, workspace key, escrow and reset codes go. */
  resetAccount(accountId: string, fields: { header: VaultHeader; authHash: string; recoveryAuthHash: string }): Promise<void>;
}

// ---- Constants and helpers ----

export const HISTORY_MS = 30 * 24 * 60 * 60 * 1000; // connection history is kept 30 days
export const SEEN_EVERY_MS = 5 * 60 * 1000;
const ADMIN_SESSION_MS = 60 * 60 * 1000;
const RESET_CODE_MS = 7 * 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const KEY32 = /^[A-Za-z0-9_-]{43}$/;
const SEALED_KEY = /^[A-Za-z0-9_-]{100,110}$/; // crypto_box_seal of a 32-byte key: 80 bytes -> 107 chars
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT_ID = /^[0-9a-f-]{32,36}$/;
const RESET_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const obj = (body: unknown): Record<string, unknown> =>
  (typeof body === 'object' && body !== null ? body as Record<string, unknown> : {});
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function decodeHeader(value: string | null): string {
  if (!value) return '';
  try { return decodeURIComponent(value); } catch { return value; }
}

export function clientInfo(request: Request): ClientInfo {
  const h = request.headers;
  const ip = (h.get('x-forwarded-for')?.split(',')[0] ?? h.get('x-real-ip') ?? '').trim();
  return {
    ip: ip.slice(0, 64) || 'unknown',
    userAgent: (h.get('user-agent') ?? '').slice(0, 300),
    country: (h.get('x-vercel-ip-country') ?? '').slice(0, 8),
    region: decodeHeader(h.get('x-vercel-ip-country-region')).slice(0, 64),
    city: decodeHeader(h.get('x-vercel-ip-city')).slice(0, 80),
  };
}

/** Records an event; history must never break logging in or syncing. */
export async function record(repo: Repo, kind: EventKind, client: ClientInfo | undefined, account: { id: string | null; username: string | null }): Promise<void> {
  if (!client) return;
  try {
    await repo.logEvent({ kind, accountId: account.id, username: account.username, ...client });
    if (Math.random() < 0.02) await repo.pruneEvents(Date.now() - HISTORY_MS);
  } catch (err) {
    console.error('[cherrion] could not record an event', err);
  }
}

/** Last seen time and place, from sync (throttled in the repo). */
export async function seen(repo: Repo, accountId: string, client: ClientInfo | undefined): Promise<void> {
  if (!client) return;
  try { await repo.touchAccount(accountId, client, Date.now()); } catch (err) { console.error('[cherrion] could not update last seen', err); }
}

async function tooMany(repo: Repo, kinds: EventKind[], ip: string, minutes: number, max: number): Promise<boolean> {
  return (await repo.countEvents({ kinds, ip, since: Date.now() - minutes * MINUTE })) >= max;
}

// ---- Admin configuration (CHERRION_ADMIN, made by the setup page at /admin/) ----

export interface AdminConfig {
  v: 1;
  /** Argon2id parameters for the admin password. */
  kdf: KdfParams;
  /** SHA-256 (hex) of the one-way admin auth key derived from the password. */
  authHash: string;
  /** X25519 public key that users' vault keys are sealed to (escrow). */
  publicKey: string;
  /** The matching private key, encrypted with a key derived from the admin password. */
  privateKey: Sealed;
  /** Base32 TOTP secret for the admin's authenticator app. */
  totp: string;
}

function parseConfig(raw: string): AdminConfig | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch {
    try { value = JSON.parse(Buffer.from(raw.trim(), 'base64url').toString('utf8')); } catch { return null; }
  }
  const c = obj(value);
  if (c.v !== 1 || !isKdfParams(c.kdf) || typeof c.authHash !== 'string' || !/^[0-9a-f]{64}$/.test(c.authHash)) return null;
  if (typeof c.publicKey !== 'string' || !KEY32.test(c.publicKey) || !isSealed(c.privateKey)) return null;
  if (typeof c.totp !== 'string' || !/^[A-Z2-7]{16,64}$/.test(c.totp)) return null;
  return c as unknown as AdminConfig;
}

let cached: { raw: string; config: AdminConfig | null } | null = null;
export function adminConfig(): AdminConfig | null {
  const raw = process.env.CHERRION_ADMIN ?? '';
  if (!raw) return null;
  if (cached?.raw !== raw) {
    const config = parseConfig(raw);
    if (!config) console.error('[cherrion] CHERRION_ADMIN is set but not valid: make it again on the /admin/ setup page.');
    cached = { raw, config };
  }
  return cached.config;
}

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----

function base32(secret: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of secret) {
    value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(key: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const offset = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** The time step the code belongs to (one step of clock drift allowed either way), or null. */
export function totpStep(secret: string, code: string, now: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32(secret);
  const step = Math.floor(now / 30_000);
  for (const s of [step - 1, step, step + 1]) {
    if (timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(code))) return s;
  }
  return null;
}

// ---- Shared ----

/** Removes the account from its workspaces (its workspace key is gone after a reset). */
async function leaveAllWorkspaces(repo: Repo, accountId: string): Promise<void> {
  for (const { workspace, member } of await repo.workspacesOf(accountId)) {
    const others = (await repo.members(workspace.id)).filter(m => m.accountId !== accountId);
    if (!others.length) { await repo.deleteWorkspace(workspace.id); continue; }
    if (member.role === 'owner' && !others.some(m => m.role === 'owner')) {
      // Someone has to be able to manage it: the first editor (or anyone) becomes owner.
      const heir = others.find(m => m.role === 'editor') ?? others[0]!;
      await repo.putMember({ workspaceId: workspace.id, accountId: heir.accountId, role: 'owner', keys: heir.keys });
    }
    await repo.removeMember(workspace.id, accountId);
  }
  for (const invite of await repo.invitesFor(accountId)) await repo.deleteInvite(invite.id);
}

export const normalizeResetCode = (value: unknown): string => text(value, 64).toUpperCase().replace(/[^A-Z0-9]/g, '');

function newResetCode(): string {
  const bytes = randomBytes(20);
  const chars = [...bytes].map(b => RESET_ALPHABET[b % RESET_ALPHABET.length]).join('');
  return chars.match(/.{5}/g)!.join('-'); // 4 groups of 5: about 100 bits
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- api/support.ts: help for users ----

export async function supportAction(repo: Repo, request: Request, body: unknown): Promise<unknown> {
  const b = obj(body);
  const client = clientInfo(request);
  switch (b.action) {
    // Lost both the password and the recovery key: ask the owner. Always answers the same way, so it
    // does not reveal which usernames exist.
    case 'request': {
      const username = normalizeUsername(b.username);
      const contact = text(b.contact, 200);
      if (!contact) throw new HttpError(400, 'Say how the owner can reach you (e.g. an email address or phone number).');
      if (await tooMany(repo, ['recovery_request'], client.ip, 60, 3)) throw new HttpError(429, 'Too many requests from this network. Try again in an hour.');
      const account = await repo.findAccount(username);
      await repo.createRequest({
        id: crypto.randomUUID(), at: Date.now(), username, accountId: account?.id ?? null,
        contact, message: text(b.message, 1000), status: 'open', ...client,
      });
      await record(repo, 'recovery_request', client, { id: account?.id ?? null, username });
      return { ok: true };
    }

    // A reset code from the owner: start again with a new, empty vault (made in the browser).
    case 'reset': {
      const username = normalizeUsername(b.username);
      if (!isVaultHeader(b.header)) throw new HttpError(400, 'Malformed vault header.');
      const authKey = typeof b.authKey === 'string' && KEY32.test(b.authKey) ? b.authKey : null;
      const recoveryAuthKey = typeof b.recoveryAuthKey === 'string' && KEY32.test(b.recoveryAuthKey) ? b.recoveryAuthKey : null;
      if (!authKey || !recoveryAuthKey) throw new HttpError(400, 'Missing keys.');
      if (await tooMany(repo, ['reset_failed'], client.ip, 60, 10)) throw new HttpError(429, 'Too many attempts from this network. Try again in an hour.');
      const account = await repo.findAccount(username);
      const code = normalizeResetCode(b.code);
      if (!account || code.length !== 20 || !(await repo.takeResetCode(account.id, sha256(code), Date.now()))) {
        await record(repo, 'reset_failed', client, { id: account?.id ?? null, username });
        throw new HttpError(401, 'Wrong username or reset code (codes work once, for 7 days).');
      }
      await leaveAllWorkspaces(repo, account.id);
      await repo.resetAccount(account.id, { header: b.header, authHash: sha256(authKey), recoveryAuthHash: sha256(recoveryAuthKey) });
      await record(repo, 'reset', client, { id: account.id, username });
      return { token: await newSession(repo, account.id), header: b.header };
    }

    // Opt-in owner recovery: this account's vault key sealed to the admin public key.
    case 'escrow': {
      const accountId = await authenticate(repo, request.headers.get('authorization'));
      const config = adminConfig();
      const account = await repo.findAccountById(accountId);
      if (!account) throw new HttpError(401, 'Please log in.');
      if (b.op === 'enable') {
        if (!config) throw new HttpError(404, 'Owner recovery is not available on this server.');
        if (b.adminKey !== config.publicKey) throw new HttpError(409, 'The owner key changed. Reload and try again.');
        if (typeof b.sealed !== 'string' || !SEALED_KEY.test(b.sealed)) throw new HttpError(400, 'Malformed key.');
        await repo.setEscrow(accountId, { adminKey: config.publicKey, sealed: b.sealed, at: Date.now() });
        await record(repo, 'escrow_on', client, { id: accountId, username: account.username });
      } else if (b.op === 'disable') {
        await repo.setEscrow(accountId, null);
        await record(repo, 'escrow_off', client, { id: accountId, username: account.username });
      }
      const escrow = await repo.getEscrow(accountId);
      return {
        available: !!config,
        adminKey: config?.publicKey ?? null,
        enabled: !!escrow,
        current: !!escrow && !!config && escrow.adminKey === config.publicKey,
      };
    }

    default:
      throw new HttpError(400, 'Unknown action.');
  }
}

// ---- api/admin.ts: the dashboard ----

async function requireAdmin(repo: Repo, authorization: string | null): Promise<string> {
  const m = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(authorization ?? '');
  const hash = m ? sha256(m[1]!) : null;
  if (!hash || !(await repo.findAdminSession(hash, Date.now()))) throw new HttpError(401, 'Please log in to the admin dashboard.');
  return hash;
}

function accountIdOf(value: unknown): string {
  if (typeof value !== 'string' || !ACCOUNT_ID.test(value)) throw new HttpError(400, 'Malformed account id.');
  return value;
}

export async function adminAction(repo: Repo, request: Request, body: unknown): Promise<unknown> {
  const b = obj(body);
  const client = clientInfo(request);
  const config = adminConfig();
  if (b.action === 'config') return config ? { configured: true, kdf: config.kdf } : { configured: false };
  if (!config) throw new HttpError(404, 'The admin dashboard is not set up yet.');

  if (b.action === 'login') {
    if (await tooMany(repo, ['admin_login_failed'], client.ip, 15, 5)) throw new HttpError(429, 'Too many failed attempts. Wait 15 minutes.');
    const authKey = typeof b.authKey === 'string' && KEY32.test(b.authKey) ? b.authKey : '';
    const now = Date.now();
    const step = totpStep(config.totp, text(b.code, 12).replace(/\s/g, ''), now);
    const lastStep = Number((await repo.getSetting('admin_totp_step')) ?? '-1');
    // A code works once (a code seen over someone's shoulder cannot be reused).
    if (!authKey || !sameHex(sha256(authKey), config.authHash) || step === null || step <= lastStep) {
      await record(repo, 'admin_login_failed', client, { id: null, username: null });
      throw new HttpError(401, 'Wrong password or 2FA code.');
    }
    await repo.setSetting('admin_totp_step', String(step));
    const token = randomBytes(32).toString('base64url');
    await repo.createAdminSession(sha256(token), now + ADMIN_SESSION_MS);
    await record(repo, 'admin_login', client, { id: null, username: null });
    return { token, expiresAt: now + ADMIN_SESSION_MS, publicKey: config.publicKey, privateKey: config.privateKey };
  }

  const session = await requireAdmin(repo, request.headers.get('authorization'));
  switch (b.action) {
    case 'logout':
      await repo.deleteAdminSession(session);
      return { ok: true };

    case 'overview': {
      const now = Date.now();
      await repo.pruneEvents(now - HISTORY_MS);
      const [users, requests, events] = await Promise.all([repo.users(), repo.requests(200), repo.events({ since: now - HISTORY_MS, limit: 500 })]);
      return { users, requests, events, adminKey: config.publicKey, historyDays: HISTORY_MS / 86_400_000 };
    }

    case 'events':
      return { events: await repo.events({ accountId: accountIdOf(b.accountId), since: Date.now() - HISTORY_MS, limit: 1000 }) };

    // For a new recovery key: the browser unseals the vault key, checks it against the header and
    // makes a new recovery slot. The server never sees the vault key.
    case 'escrow': {
      const account = await repo.findAccountById(accountIdOf(b.accountId));
      if (!account) throw new HttpError(404, 'No such account.');
      return { header: account.header, escrow: await repo.getEscrow(account.id) };
    }

    case 'setRecovery': {
      const account = await repo.findAccountById(accountIdOf(b.accountId));
      if (!account) throw new HttpError(404, 'No such account.');
      const next = b.header;
      const key = typeof b.recoveryAuthKey === 'string' && KEY32.test(b.recoveryAuthKey) ? b.recoveryAuthKey : null;
      const cur = account.header;
      // Only the recovery slot may change: the password, workspace key and name stay as they are.
      if (!isVaultHeader(next) || !key || next.vaultId !== cur.vaultId || next.updatedAt <= cur.updatedAt
        || !same(next.kdf, cur.kdf) || !same(next.passwordWrap, cur.passwordWrap) || !same(next.identity, cur.identity) || !same(next.profile, cur.profile)) {
        throw new HttpError(400, 'That is not a valid new recovery key for this account. Reload and try again.');
      }
      await repo.updateAccount(account.id, { header: next, recoveryAuthHash: sha256(key) });
      await record(repo, 'admin_recovery_key', client, { id: account.id, username: account.username });
      if (typeof b.requestId === 'string' && UUID.test(b.requestId)) await repo.setRequestStatus(b.requestId, 'done');
      return { ok: true };
    }

    case 'resetCode': {
      const account = await repo.findAccountById(accountIdOf(b.accountId));
      if (!account) throw new HttpError(404, 'No such account.');
      const code = newResetCode();
      const expiresAt = Date.now() + RESET_CODE_MS;
      await repo.putResetCode(account.id, sha256(normalizeResetCode(code)), expiresAt);
      await record(repo, 'admin_reset_code', client, { id: account.id, username: account.username });
      if (typeof b.requestId === 'string' && UUID.test(b.requestId)) await repo.setRequestStatus(b.requestId, 'done');
      return { code, expiresAt };
    }

    case 'resolve': {
      if (typeof b.requestId !== 'string' || !UUID.test(b.requestId)) throw new HttpError(400, 'Malformed request id.');
      const status: RequestStatus = b.status === 'open' ? 'open' : b.status === 'dismissed' ? 'dismissed' : 'done';
      await repo.setRequestStatus(b.requestId, status);
      return { ok: true };
    }

    default:
      throw new HttpError(400, 'Unknown admin action.');
  }
}
