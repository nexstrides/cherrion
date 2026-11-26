// Desktop session: the open .cherrion vault file, writing every change to it, and the optional link
// to an online account (the web version's server) for sync.
//
// Everything written to the file is what the web version sends to the server: encrypted envelopes and
// the key-wrapped header. Notes stay "dirty" in the file until the sync server has stored them, so
// edits made offline survive restarts and are uploaded later.
import { ApiError, api, hasSession, setReauthenticator, setSession, setTransport } from '../api';
import { DEFAULT_KDF_COST, wipe } from '../crypto';
import { encryptNote, isEnvelope, type Envelope } from '../envelope';
import type { Note } from '../model';
import * as store from '../store';
import * as sync from '../sync';
import { authKeyFromKek, createVault, deriveKek, isVaultHeader, recoveryAuthKey, unlockWithKek, type VaultHeader } from '../vault';
import { py, type FileChanges, type FileSync } from './bridge';

export type RemoteState =
  | { kind: 'local' } // not linked to an account
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'offline'; message?: string }
  | { kind: 'denied'; message: string };

export interface Link { url: string; username: string }
export interface LoadedFile { path: string; header: VaultHeader; notes: Envelope[]; unsent: string[]; sync: FileSync | null }

let path: string | null = null;
let link: Link | null = null;
/** Server the API talks to right now (the link's, or the one being signed in to). */
let server: string | null = null;
/** One-way login key for the linked account, kept while unlocked to reconnect after being offline. */
let authKey: Uint8Array | null = null;
let remote: RemoteState = { kind: 'local' };
let fileError: string | null = null;

const listeners = new Set<() => void>();
export const onDesktopChange = (fn: () => void) => listeners.add(fn);
const changed = () => listeners.forEach(fn => fn());

export const filePath = (): string | null => path;
export const linkedAccount = (): Link | null => link;
export const remoteState = (): RemoteState => remote;
export const fileProblem = (): string | null => fileError;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---- Writing to the file (in order, one at a time) ----

let writes: Promise<void> = Promise.resolve();
let failed: FileChanges[] = [];

function write(work: () => Promise<void>): void {
  writes = writes.then(async () => {
    try {
      await work();
      if (fileError) { fileError = null; changed(); }
    } catch (err) {
      console.error(err);
      fileError = `Could not save to the vault file: ${message(err)}`;
      changed();
    }
  });
}

/** Saves changes; ones that failed earlier are retried first (saving is idempotent). */
function save(changes: FileChanges): void {
  write(async () => {
    const batch = [...failed, changes];
    failed = [];
    for (let i = 0; i < batch.length; i++) {
      try { await py('vault_save', batch[i]!); } catch (err) { failed = batch.slice(i); throw err; }
    }
  });
}

/** Resolves once everything queued so far is in the file. */
export const flushWrites = (): Promise<void> => writes;

const journal: store.Journal = {
  put: (envelopes, dirty) => save({ notes: envelopes.map(envelope => ({ envelope, dirty })) }),
  clean: envelopes => write(() => py('vault_mark_clean', envelopes.map(e => [e.id, e.updatedAt] as [string, number]))),
  header: h => save({ header: h }),
};

// ---- Opening and closing ----

export async function openFile(p: string): Promise<LoadedFile> {
  const f = await py('vault_open', p);
  if (!isVaultHeader(f.header)) {
    await py('vault_close');
    throw new Error('This vault file is damaged: its header is not valid.');
  }
  return { path: f.path, header: f.header, notes: f.notes.filter(isEnvelope), unsent: f.dirty, sync: f.sync };
}

export async function createFile(p: string, header: VaultHeader, notes: Envelope[], fileSync: FileSync | null): Promise<string> {
  return (await py('vault_create', p, header, notes, fileSync)).path;
}

/** Call after store.unlock(): sends changes to the file and, when linked, connects to the account. */
export function attach(p: string, fileSync: FileSync | null, loginKey: Uint8Array | null): void {
  path = p;
  link = fileSync ? { url: fileSync.url, username: fileSync.username } : null;
  server = link?.url ?? null;
  authKey = link ? loginKey : null;
  if (!link && loginKey) wipe(loginKey);
  fileError = null;
  failed = [];
  store.setJournal(journal);
  store.setRemoteAccount(!!link);
  sync.setSince(fileSync?.since ?? 0);
  if (link && hasSession()) {
    remote = { kind: 'connected' };
    sync.startSync();
  } else if (link && !authKey) {
    remote = { kind: 'denied', message: 'This file is not signed in to its online account. Log in again in Settings → Online sync to resume syncing.' };
  } else {
    remote = link ? { kind: 'connecting' } : { kind: 'local' };
    if (link) void connect();
  }
  changed();
}

/** Call after store.lock(): waits for the last writes, ends the server session, closes the file. */
export async function detach(): Promise<void> {
  await writes;
  if (hasSession()) await api.logout();
  setSession(null);
  wipe(authKey);
  authKey = null;
  store.setJournal(null);
  store.setRemoteAccount(true);
  link = null;
  server = null;
  path = null;
  remote = { kind: 'local' };
  try { await py('vault_close'); } catch (err) { console.error(err); }
  changed();
}

// ---- Online account ----

/** Reconnects with the kept login key (at unlock, after being offline, after the session expired). */
let connecting: Promise<void> | null = null;
export function connect(): Promise<void> {
  connecting ??= (async () => {
    try {
      if (!link || !authKey || hasSession()) return;
      remote = { kind: 'connecting' };
      changed();
      server = link.url;
      const session = await api.login(link.username, authKey);
      setSession(session.token);
      store.adoptHeader(session.header);
      remote = { kind: 'connected' };
      changed();
      sync.startSync();
      void sync.syncNow();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        wipe(authKey);
        authKey = null;
        remote = { kind: 'denied', message: 'The online account did not accept this file’s password. If the password was changed on another device, log in again in Settings → Online sync.' };
      } else if (err instanceof ApiError && err.status === 0) {
        remote = { kind: 'offline', message: err.message };
      } else {
        remote = { kind: 'denied', message: message(err) };
      }
      changed();
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

/** Accepts "cherrion-note.vercel.app" or a full URL; HTTPS only (plain HTTP only on this computer). */
export function normalizeServerUrl(text: string): string {
  let t = text.trim();
  if (!t) throw new Error('Enter the sync server address.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = `https://${t}`;
  let u: URL;
  try { u = new URL(t); } catch { throw new Error('That is not a valid server address.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.username || u.password || !u.hostname) throw new Error('That is not a valid server address.');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('The sync server must use HTTPS.');
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/** Logs in to an account; returns the session and the KEK-derived values (caller wipes kek). */
async function login(url: string, username: string, password: string) {
  server = url;
  const kdf = await api.prelogin(username);
  const kek = deriveKek(password, kdf);
  const key = authKeyFromKek(kek);
  try {
    const session = await api.login(username, key);
    return { session, kek, key };
  } catch (err) {
    wipe(kek); wipe(key);
    throw err;
  }
}

/**
 * Links the open file to an existing account holding the same vault (or logs in again after the
 * password changed elsewhere). The file takes the account's password from then on.
 */
export async function signIn(urlText: string, username: string, password: string): Promise<void> {
  const url = normalizeServerUrl(urlText);
  const fresh = !link || link.url !== url || link.username !== username;
  const { session, kek, key } = await login(url, username, password);
  try {
    setSession(session.token);
    if (!store.adoptAccountHeader(session.header)) {
      await api.logout();
      setSession(null);
      throw new Error('That account holds a different vault. To use it on this PC, lock this file and choose “Get my online account on this PC”.');
    }
    wipe(authKey);
    authKey = key;
    link = { url, username };
    store.setRemoteAccount(true);
    if (fresh) {
      sync.setSince(0);
      save({ meta: { sync_url: url, sync_username: username, sync_since: 0 } });
      store.markAllUnsent();
    }
    remote = { kind: 'connected' };
    changed();
    sync.startSync();
    await sync.syncNow();
  } catch (err) {
    if (authKey !== key) wipe(key);
    if (!link) server = null;
    throw err;
  } finally {
    wipe(kek);
  }
}

/** Creates an online account from the open file and uploads its notes. Returns the new recovery key. */
export async function createAccount(urlText: string, username: string, password: string): Promise<string> {
  const url = normalizeServerUrl(urlText);
  await store.flush();
  const prepared = store.prepareAccount(password);
  const all = store.allEnvelopes();
  // A big file (pictures) would not fit in the sign-up request: then sign up empty and let sync
  // upload the notes in batches.
  const fits = sync.batchBySize(all, 3_000_000).length <= 1;
  const notes = fits ? all : [];
  server = url;
  try {
    const session = await api.signup({ username, header: prepared.header, authKey: prepared.authKey, recoveryAuthKey: prepared.recoveryAuthKey, notes });
    store.adoptHeader(prepared.header);
    setSession(session.token);
    wipe(authKey);
    authKey = prepared.authKey;
    link = { url, username };
    store.setRemoteAccount(true);
    sync.setSince(0);
    save({ meta: { sync_url: url, sync_username: username, sync_since: 0 } });
    if (fits) store.confirmSent(notes); else store.markAllUnsent();
    remote = { kind: 'connected' };
    changed();
    sync.startSync();
    void sync.syncNow();
    return prepared.recoveryKey;
  } catch (err) {
    wipe(prepared.authKey);
    if (!link) server = null;
    throw err;
  } finally {
    wipe(prepared.recoveryAuthKey);
  }
}

/**
 * After resetting a linked file's password with the recovery key: resets the online account to the
 * same new password, so it keeps syncing. Signs in on success.
 */
export async function recoverOnline(fileSync: FileSync, recoveryText: string, next: VaultHeader, nextAuthKey: Uint8Array): Promise<void> {
  server = fileSync.url;
  const rAuth = recoveryAuthKey(recoveryText);
  try {
    await api.recoverStart(fileSync.username, rAuth);
    setSession((await api.recoverFinish(fileSync.username, rAuth, next, nextAuthKey)).token);
  } finally {
    wipe(rAuth);
  }
}

/** Writes a header that changed outside the store's own edits (e.g. a password reset at unlock). */
export const saveHeader = (h: VaultHeader): void => save({ header: h });

/** Stops syncing this file. The notes stay in the file; the online account is not changed. */
export async function unlink(): Promise<void> {
  if (hasSession()) await api.logout();
  setSession(null);
  wipe(authKey);
  authKey = null;
  link = null;
  server = null;
  sync.stopSync();
  store.setRemoteAccount(false);
  save({ meta: { sync_url: null, sync_username: null, sync_since: null } });
  remote = { kind: 'local' };
  changed();
}

/**
 * New user on the desktop: creates the online account and a vault file linked to it in one step,
 * then opens it (signed in and syncing). Returns the recovery key to show once.
 */
export async function createOnlineAccount(urlText: string, username: string, password: string, userName: string, savePath: string, starter: Note[]): Promise<string> {
  const url = normalizeServerUrl(urlText);
  const v = createVault(password, DEFAULT_KDF_COST, { userName });
  const notes = starter.map(n => encryptNote(v.vaultKey, n));
  server = url;
  let signedUp = false;
  try {
    const session = await api.signup({ username, header: v.header, authKey: v.authKey, recoveryAuthKey: v.recoveryAuthKey, notes });
    signedUp = true;
    setSession(session.token);
    let created: string;
    try {
      created = await createFile(savePath, v.header, notes, { url, username, since: 0 });
    } catch (err) {
      throw new Error(`Your account “${username}” was created, but the file could not be saved: ${message(err)} Choose “I already have an account” to download it into another file.`);
    }
    sync.stopSync();
    store.unlock(v.header, v.vaultKey, notes);
    attach(created, { url, username, since: 0 }, v.authKey);
    return v.recoveryKey;
  } catch (err) {
    if (hasSession()) await api.logout();
    setSession(null);
    wipe(v.authKey);
    wipe(v.vaultKey);
    server = null;
    if (!signedUp && err instanceof ApiError && err.status === 409) {
      throw new Error(`${err.message} If it is yours, choose “I already have an account”.`);
    }
    throw err;
  } finally {
    wipe(v.recoveryAuthKey);
  }
}

/** Downloads an account into a new vault file and opens it (signed in and syncing). */
export async function downloadAccount(urlText: string, username: string, password: string, savePath: string): Promise<{ header: VaultHeader; vaultKey: Uint8Array; notes: Envelope[] }> {
  const url = normalizeServerUrl(urlText);
  let signedIn: Awaited<ReturnType<typeof login>>;
  try {
    signedIn = await login(url, username, password);
  } catch (err) {
    server = null;
    if (err instanceof ApiError && err.status === 401) {
      throw new Error(`${err.message} New to Cherrion? Choose “Create a new account”.`);
    }
    throw err;
  }
  const { session, kek, key } = signedIn;
  try {
    const vaultKey = unlockWithKek(session.header, kek);
    setSession(session.token);
    sync.stopSync();
    const all = await sync.loadAll();
    const header = all.header ?? session.header;
    const created = await createFile(savePath, header, all.notes, { url, username, since: sync.getSince() });
    store.unlock(header, vaultKey, all.notes);
    attach(created, { url, username, since: sync.getSince() }, key);
    return { header, vaultKey, notes: all.notes };
  } catch (err) {
    if (hasSession()) await api.logout();
    setSession(null);
    wipe(key);
    server = null;
    throw err;
  } finally {
    wipe(kek);
  }
}

// ---- Wiring ----

export function wireDesktopSession(): void {
  setTransport((endpoint, body, token) => (server
    ? py('http_post', server, endpoint, body, token)
    : Promise.resolve({ status: 0, data: { error: 'This vault file is not linked to an online account.' } })));

  sync.onSince(rev => { if (link && path) save({ meta: { sync_since: rev } }); });
  sync.onSessionExpired(() => { setSession(null); void connect(); });
  // An expired session (12 hours) is renewed with the kept login key and the request retried.
  setReauthenticator(async () => {
    if (!link || !authKey) return false;
    setSession(null);
    await connect();
    return hasSession();
  });
  store.onAuthKeyChange(key => { if (link) { wipe(authKey); authKey = key.slice(); } });
  window.addEventListener('online', () => { if (link && !hasSession()) void connect(); });
  setInterval(() => {
    if (store.isUnlocked() && link && authKey && !hasSession() && navigator.onLine) void connect();
  }, 20_000);

  // The Python side calls these when the window is closing, so the last edits reach the file.
  let closing: Promise<void> | null = null;
  let closed = true;
  const w = window as unknown as Record<string, unknown>;
  w.__cherrionBeforeClose = () => {
    closed = false;
    closing = store.flush().then(() => writes).finally(() => { closed = true; });
    return 0;
  };
  w.__cherrionBusy = () => closing !== null && !closed;
}
