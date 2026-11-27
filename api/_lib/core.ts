// Cherrion API logic, independent of the database (see repo.ts / pg.ts) and of HTTP (see http.ts).
// The server is zero-knowledge: it stores the key-wrapped vault header and encrypted note envelopes,
// and authenticates with SHA-256 hashes of one-way "auth keys" derived in the browser.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isEnvelope, isVaultHeader } from '../../src/shapes.js';
import type { KdfParams } from '../../src/crypto.js';
import type { Envelope } from '../../src/envelope.js';
import type { VaultHeader } from '../../src/vault.js';
import { memoryFileRepo, type FileRepo } from './files.js';
import { memoryWorkspaceRepo, type WorkspaceRepo } from './workspaces.js';
import { record, seen, SEEN_EVERY_MS, type AdminRepo, type ClientInfo, type Escrow, type EventRow, type RecoveryRequest } from './admin.js';

export interface Account {
  id: string; username: string; header: VaultHeader; authHash: string; recoveryAuthHash: string;
  /** X25519 public key for shared workspaces (null until the account first sets one up). */
  publicKey?: string | null;
}

export interface Repo extends WorkspaceRepo, FileRepo, AdminRepo {
  /** False for the in-memory development store (data disappears on restart). */
  readonly persistent: boolean;
  findAccount(username: string): Promise<Account | null>;
  findAccountById(id: string): Promise<Account | null>;
  /** Returns null when the username is taken. */
  createAccount(username: string, header: VaultHeader, authHash: string, recoveryAuthHash: string): Promise<Account | null>;
  updateAccount(id: string, fields: { header?: VaultHeader; authHash?: string; recoveryAuthHash?: string }): Promise<void>;
  createSession(tokenHash: string, accountId: string, expiresAt: Date): Promise<void>;
  /** Only sessions that have not expired. */
  findSession(tokenHash: string): Promise<string | null>;
  deleteSession(tokenHash: string): Promise<void>;
  /** Stores each envelope unless the stored copy is as new or newer (last write wins). */
  putNotes(accountId: string, notes: Envelope[]): Promise<void>;
  /** Envelopes changed after `since`, oldest first, at most `limit`. */
  notesSince(accountId: string, since: number, limit: number): Promise<{ notes: Envelope[]; revs: number[] }>;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_NOTES_PER_REQUEST = 5000;
const PAGE = 2000;
/** Approximate JSON size of the notes in one sync response (see sync()). */
export const RESPONSE_BUDGET = 3_000_000;
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,39}$/;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const obj = (body: unknown): Record<string, unknown> =>
  (typeof body === 'object' && body !== null ? body as Record<string, unknown> : {});

export function normalizeUsername(value: unknown): string {
  const u = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!USERNAME.test(u)) throw new HttpError(400, 'Usernames are 3–40 characters: letters, digits, dot, dash or underscore.');
  return u;
}

/** A 32-byte key encoded as unpadded base64url (43 characters). */
function authKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new HttpError(400, `Missing or malformed ${field}.`);
  return value;
}

function header(value: unknown): VaultHeader {
  if (!isVaultHeader(value)) throw new HttpError(400, 'Malformed vault header.');
  return value;
}

function envelopes(value: unknown): Envelope[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_NOTES_PER_REQUEST || !value.every(isEnvelope)) {
    throw new HttpError(400, 'Malformed notes.');
  }
  return value;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function newSession(repo: Repo, accountId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await repo.createSession(sha256(token), accountId, new Date(Date.now() + SESSION_MS));
  return token;
}

function bearer(authorization: string | null): string {
  const m = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(authorization ?? '');
  if (!m) throw new HttpError(401, 'Please log in.');
  return m[1]!;
}

export async function authenticate(repo: Repo, authorization: string | null): Promise<string> {
  const accountId = await repo.findSession(sha256(bearer(authorization)));
  if (!accountId) throw new HttpError(401, 'Your session has expired. Please log in again.');
  return accountId;
}

// ---- Endpoints ----

/**
 * Step 1 of login: the KDF parameters needed to derive the auth key. Unknown usernames get stable,
 * fake parameters so the response does not reveal which usernames exist.
 */
export async function prelogin(repo: Repo, secret: string, body: unknown): Promise<{ kdf: KdfParams }> {
  const username = normalizeUsername(obj(body).username);
  const account = await repo.findAccount(username);
  if (account) return { kdf: account.header.kdf };
  const salt = createHmac('sha256', secret).update(`cherrion-fake-salt:${username}`).digest().subarray(0, 16).toString('base64url');
  return { kdf: { alg: 'argon2id13', opslimit: 3, memlimit: 64 * 1024 * 1024, salt } };
}

/** Lets the login screen warn when it talks to the temporary development database. */
export async function status(repo: Repo): Promise<{ persistent: boolean }> {
  return { persistent: repo.persistent };
}

export async function signup(repo: Repo, body: unknown, client?: ClientInfo): Promise<{ token: string; header: VaultHeader }> {
  const b = obj(body);
  const username = normalizeUsername(b.username);
  const h = header(b.header);
  const notes = envelopes(b.notes);
  const account = await repo.createAccount(username, h, sha256(authKey(b.authKey, 'authKey')), sha256(authKey(b.recoveryAuthKey, 'recoveryAuthKey')));
  if (!account) throw new HttpError(409, 'That username is already taken.');
  if (notes.length) await repo.putNotes(account.id, notes);
  await record(repo, 'signup', client, { id: account.id, username });
  await seen(repo, account.id, client);
  return { token: await newSession(repo, account.id), header: h };
}

export async function login(repo: Repo, body: unknown, client?: ClientInfo): Promise<{ token: string; header: VaultHeader }> {
  const b = obj(body);
  const username = normalizeUsername(b.username);
  const key = authKey(b.authKey, 'authKey');
  const account = await repo.findAccount(username);
  if (!account || !sameHash(sha256(key), account.authHash)) {
    await record(repo, 'login_failed', client, { id: account?.id ?? null, username });
    throw new HttpError(401, 'Wrong username or password.');
  }
  await record(repo, 'login', client, { id: account.id, username });
  await seen(repo, account.id, client);
  return { token: await newSession(repo, account.id), header: account.header };
}

/**
 * Password reset with the recovery key. Without `header` it only checks the recovery key and returns
 * the header (so the browser can unwrap the vault key); with `header` + `authKey` it stores the new
 * password and logs in. Only the password slot may change.
 */
export async function recover(repo: Repo, body: unknown, client?: ClientInfo): Promise<{ header: VaultHeader; token?: string }> {
  const b = obj(body);
  const username = normalizeUsername(b.username);
  const key = authKey(b.recoveryAuthKey, 'recoveryAuthKey');
  const account = await repo.findAccount(username);
  if (!account || !sameHash(sha256(key), account.recoveryAuthHash)) throw new HttpError(401, 'Wrong username or recovery key.');
  if (b.header === undefined) return { header: account.header };
  const next = header(b.header);
  if (next.vaultId !== account.header.vaultId || !same(next.recoveryWrap, account.header.recoveryWrap)) {
    throw new HttpError(400, 'That header does not belong to this vault.');
  }
  await repo.updateAccount(account.id, { header: next, authHash: sha256(authKey(b.authKey, 'authKey')) });
  await record(repo, 'recover', client, { id: account.id, username });
  return { header: next, token: await newSession(repo, account.id) };
}

/** Password change and recovery-key rotation. Requires the current auth key, not just the session. */
export async function updateAccount(repo: Repo, accountId: string, body: unknown): Promise<{ header: VaultHeader }> {
  const b = obj(body);
  const account = await repo.findAccountById(accountId);
  if (!account) throw new HttpError(401, 'Please log in.');
  if (!sameHash(sha256(authKey(b.currentAuthKey, 'currentAuthKey')), account.authHash)) {
    throw new HttpError(403, 'Your current password is wrong.');
  }
  const next = header(b.header);
  if (next.vaultId !== account.header.vaultId || next.updatedAt <= account.header.updatedAt) {
    throw new HttpError(409, 'The vault changed on another device. Reload and try again.');
  }
  await repo.updateAccount(account.id, {
    header: next,
    ...(b.authKey !== undefined ? { authHash: sha256(authKey(b.authKey, 'authKey')) } : {}),
    ...(b.recoveryAuthKey !== undefined ? { recoveryAuthHash: sha256(authKey(b.recoveryAuthKey, 'recoveryAuthKey')) } : {}),
  });
  return { header: next };
}

/**
 * Push local changes and pull everything changed after `since`. A pushed header is accepted only for
 * profile changes (the password and recovery slots can change only through updateAccount/recover).
 */
export async function sync(repo: Repo, accountId: string, body: unknown, client?: ClientInfo): Promise<{ notes: Envelope[]; rev: number; more: boolean; header: VaultHeader }> {
  const b = obj(body);
  const account = await repo.findAccountById(accountId);
  if (!account) throw new HttpError(401, 'Please log in.');
  await seen(repo, accountId, client);
  const since = typeof b.since === 'number' && Number.isInteger(b.since) && b.since >= 0 ? b.since : 0;

  let current = account.header;
  if (b.header !== undefined) {
    const next = header(b.header);
    const profileOnly = next.vaultId === current.vaultId && next.updatedAt > current.updatedAt
      && same(next.kdf, current.kdf) && same(next.passwordWrap, current.passwordWrap) && same(next.recoveryWrap, current.recoveryWrap)
      // The workspace identity is set once: workspace keys are sealed to it, so replacing it (e.g. a
      // second device setting up at the same time) would lock this account out of its workspaces.
      && (current.identity ? same(next.identity, current.identity) : !account.publicKey || !next.identity || next.identity.publicKey === account.publicKey);
    if (profileOnly) {
      await repo.updateAccount(account.id, { header: next });
      current = next;
    }
  }

  const incoming = envelopes(b.notes);
  if (incoming.length) await repo.putNotes(account.id, incoming);
  const { notes, revs } = await repo.notesSince(account.id, since, PAGE);
  // Keep each response well under the hosting limit (Vercel: 4.5 MB). Pages with pictures are large,
  // so stop at about 3 MB (always at least one note) and let the client ask for the rest.
  let bytes = 0;
  let count = 0;
  while (count < notes.length) {
    bytes += JSON.stringify(notes[count]).length;
    if (count > 0 && bytes > RESPONSE_BUDGET) break;
    count++;
  }
  const page = notes.slice(0, count);
  return {
    notes: page,
    rev: count ? revs[count - 1]! : since,
    more: count < notes.length || notes.length === PAGE,
    header: current,
  };
}

export async function logout(repo: Repo, authorization: string | null): Promise<{ ok: true }> {
  await repo.deleteSession(sha256(bearer(authorization)));
  return { ok: true };
}

// ---- In-memory repository (local development and tests) ----

export function createMemoryRepo(): Repo {
  const accounts = new Map<string, Account>();
  const sessions = new Map<string, { accountId: string; expiresAt: number }>();
  const notes = new Map<string, Map<string, { env: Envelope; rev: number }>>();
  let rev = 0;
  const byId = (id: string) => [...accounts.values()].find(a => a.id === id) ?? null;
  // Admin data (history, recovery requests, escrow, reset codes, admin sessions).
  const created = new Map<string, number>();
  const lastSeen = new Map<string, { at: number; client: ClientInfo }>();
  const events: EventRow[] = [];
  const escrows = new Map<string, Escrow>();
  const requests: RecoveryRequest[] = [];
  const resetCodes = new Map<string, { hash: string; expiresAt: number }>();
  const adminSessions = new Map<string, number>();
  const settings = new Map<string, string>();
  let eventId = 0;
  const workspaceRepo = memoryWorkspaceRepo(() => accounts.values(), () => ++rev);
  return {
    ...workspaceRepo,
    ...memoryFileRepo(),
    persistent: false,
    async logEvent(e) { events.push({ ...e, id: String(++eventId), at: Date.now() }); },
    async events({ accountId, since, limit }) {
      return events.filter(e => e.at >= since && (!accountId || e.accountId === accountId)).reverse().slice(0, limit);
    },
    async countEvents({ kinds, ip, since }) {
      return events.filter(e => e.at >= since && kinds.includes(e.kind) && (!ip || e.ip === ip)).length;
    },
    async pruneEvents(before) {
      const keep = events.filter(e => e.at >= before);
      events.splice(0, events.length, ...keep);
    },
    async touchAccount(accountId, client, at) {
      const last = lastSeen.get(accountId);
      if (!last || at - last.at >= SEEN_EVERY_MS || last.client.ip !== client.ip) lastSeen.set(accountId, { at, client });
    },
    async users() {
      const list = await Promise.all([...accounts.values()].map(async a => {
        const seenAt = lastSeen.get(a.id);
        return {
          id: a.id, username: a.username, createdAt: created.get(a.id) ?? 0,
          notes: [...(notes.get(a.id)?.values() ?? [])].filter(n => !n.env.deleted).length,
          workspaces: (await workspaceRepo.workspacesOf(a.id)).length,
          lastSeenAt: seenAt?.at ?? null, lastIp: seenAt?.client.ip ?? null, lastUserAgent: seenAt?.client.userAgent ?? null,
          lastCountry: seenAt?.client.country ?? null, lastRegion: seenAt?.client.region ?? null, lastCity: seenAt?.client.city ?? null,
          escrowKey: escrows.get(a.id)?.adminKey ?? null,
        };
      }));
      return list.sort((x, y) => y.createdAt - x.createdAt);
    },
    getEscrow: async id => escrows.get(id) ?? null,
    async setEscrow(id, escrow) { if (escrow) escrows.set(id, escrow); else escrows.delete(id); },
    async createRequest(r) { requests.push(r); },
    requests: async limit => [...requests].reverse().slice(0, limit),
    async setRequestStatus(id, status) { const r = requests.find(x => x.id === id); if (r) r.status = status; },
    async putResetCode(accountId, hash, expiresAt) { resetCodes.set(accountId, { hash, expiresAt }); },
    async takeResetCode(accountId, hash, now) {
      const c = resetCodes.get(accountId);
      if (!c || c.expiresAt <= now || c.hash !== hash) return false;
      resetCodes.delete(accountId);
      return true;
    },
    async createAdminSession(hash, expiresAt) { adminSessions.set(hash, expiresAt); },
    findAdminSession: async (hash, now) => (adminSessions.get(hash) ?? 0) > now,
    async deleteAdminSession(hash) { adminSessions.delete(hash); },
    getSetting: async key => settings.get(key) ?? null,
    async setSetting(key, value) { settings.set(key, value); },
    async resetAccount(accountId, fields) {
      const a = byId(accountId);
      if (!a) return;
      Object.assign(a, fields, { publicKey: null });
      notes.delete(accountId);
      for (const [hash, s] of sessions) if (s.accountId === accountId) sessions.delete(hash);
      escrows.delete(accountId);
      resetCodes.delete(accountId);
    },
    findAccount: async u => accounts.get(u) ?? null,
    findAccountById: async id => byId(id),
    async createAccount(username, h, authHash, recoveryAuthHash) {
      if (accounts.has(username)) return null;
      const account = { id: randomBytes(16).toString('hex'), username, header: h, authHash, recoveryAuthHash };
      accounts.set(username, account);
      created.set(account.id, Date.now());
      return account;
    },
    async updateAccount(id, fields) {
      const a = byId(id);
      if (a) Object.assign(a, fields);
    },
    async createSession(tokenHash, accountId, expiresAt) { sessions.set(tokenHash, { accountId, expiresAt: expiresAt.getTime() }); },
    async findSession(tokenHash) {
      const s = sessions.get(tokenHash);
      return s && s.expiresAt > Date.now() ? s.accountId : null;
    },
    async deleteSession(tokenHash) { sessions.delete(tokenHash); },
    async putNotes(accountId, list) {
      const map = notes.get(accountId) ?? new Map();
      notes.set(accountId, map);
      for (const env of list) {
        const existing = map.get(env.id);
        if (!existing || existing.env.updatedAt < env.updatedAt) map.set(env.id, { env, rev: ++rev });
      }
    },
    async notesSince(accountId, since, limit) {
      const rows = [...(notes.get(accountId)?.values() ?? [])].filter(r => r.rev > since).sort((a, b) => a.rev - b.rev).slice(0, limit);
      return { notes: rows.map(r => r.env), revs: rows.map(r => r.rev) };
    },
  };
}
