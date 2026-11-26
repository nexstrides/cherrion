// The unlocked session: the vault key and decrypted notes live only here, in memory. The web app is
// online-only: nothing is written to browser storage. Edits are encrypted into envelopes and queued
// in an outbox, which sync.ts pushes to the server shortly after. The desktop build also writes every
// envelope to its vault file through a Journal (see src/desktop/session.ts).
import { api } from './api';
import { wipe } from './crypto';
import { decryptNote, encryptNote, isEnvelope, type Envelope } from './envelope';
import { now, type Note } from './model';
import {
  authKeyFromKek, deriveKek, isVaultHeader, readProfile, rewrapPasswordWithAuth, rotateRecoveryKey, setProfile,
  unlockWithKek, verifyHeader, type Profile, type VaultHeader,
} from './vault';

export type ChangeReason = 'external' | 'header';
/** `ids` lists the notes that were replaced, so the UI can avoid re-rendering the note being edited. */
export interface Change { reason: ChangeReason; ids: string[] }

let header: VaultHeader | null = null;
let headerDirty = false;
let vaultKey: Uint8Array | null = null;
let profile: Profile | null = null;
let notes: Record<string, Note> = {};
/** Latest encrypted copy of every note (what the server has, or will have once the outbox is sent). */
let envelopes = new Map<string, Envelope>();
/** Note ids changed here and not yet confirmed by the server. */
const outbox = new Set<string>();
let undecryptable = 0;

const pending = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushChain: Promise<void> = Promise.resolve();

const changeListeners = new Set<(change: Change) => void>();
const persistListeners = new Set<() => void>();
const lockListeners = new Set<() => void>();

/**
 * Where encrypted changes are also written as they happen (the desktop build's vault file).
 * `dirty` means "not yet on the sync server". The web build has no journal: the server is the store.
 */
export interface Journal {
  put(envelopes: Envelope[], dirty: boolean): void;
  /** The server stored these exact versions. */
  clean(envelopes: Envelope[]): void;
  header(h: VaultHeader): void;
}
let journal: Journal | null = null;
export const setJournal = (j: Journal | null): void => { journal = j; };

/** False for a desktop vault file that is not linked to an online account (password changes stay local). */
let remoteAccount = true;
export const setRemoteAccount = (linked: boolean): void => { remoteAccount = linked; };

export const onChange = (fn: (change: Change) => void) => changeListeners.add(fn);
/** Local changes are ready to send (sync.ts schedules a push). */
export const onPersisted = (fn: () => void) => persistListeners.add(fn);
/** Another tab asked every tab to lock. */
export const onLockRequest = (fn: () => void) => lockListeners.add(fn);
const emit = (reason: ChangeReason, ids: string[] = []) => changeListeners.forEach(fn => fn({ reason, ids }));
const persisted = () => persistListeners.forEach(fn => fn());

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('cherrion_sync') : null;
if (channel) {
  channel.onmessage = (e: MessageEvent<{ type: string }>) => {
    if (e.data?.type === 'lock') lockListeners.forEach(fn => fn());
  };
}
export const broadcastLock = (): void => channel?.postMessage({ type: 'lock' });

// ---- Read access ----

export const getHeader = (): VaultHeader | null => header;
/** Decrypted profile of the unlocked vault (null when locked or never set). */
export const getProfile = (): Profile | null => profile;
export const isUnlocked = (): boolean => vaultKey !== null;
export const undecryptableCount = (): number => undecryptable;
export const allNotes = (): Note[] => Object.values(notes);
export const activeNotes = (): Note[] => Object.values(notes).filter(n => !n.deleted);
export const getNote = (id: string | null): Note | undefined => (id ? notes[id] : undefined);
/** Changes not yet saved on the server (edits made offline, or in the last moment). */
export const unsavedCount = (): number => new Set([...outbox, ...pending]).size;

function requireKey(): Uint8Array {
  if (!vaultKey) throw new Error('The vault is locked.');
  return vaultKey;
}

// ---- Lifecycle ----

/** `unsent` lists notes changed earlier but not yet on the server (kept in the desktop vault file). */
export function unlock(h: VaultHeader, key: Uint8Array, initial: Envelope[], unsent: string[] = []): void {
  header = h;
  headerDirty = false;
  vaultKey = key;
  profile = readProfile(h, key);
  notes = {};
  envelopes = new Map();
  outbox.clear();
  undecryptable = 0;
  for (const env of initial) {
    envelopes.set(env.id, env);
    try { notes[env.id] = decryptNote(key, env); } catch { undecryptable++; }
  }
  for (const id of unsent) if (envelopes.has(id)) outbox.add(id);
}

export async function lock(): Promise<void> {
  try { await flush(); } catch (err) { console.error('Could not encrypt pending changes before locking', err); }
  wipe(vaultKey);
  vaultKey = null;
  header = null;
  profile = null;
  notes = {};
  envelopes = new Map();
  outbox.clear();
  pending.clear();
}

// ---- Local edits ----

/** Marks a note as changed. updatedAt only ever increases, which last-write-wins relies on. */
export function touchNote(note: Note): void {
  note.updatedAt = Math.max(now(), note.updatedAt + 1);
  queue(note.id);
}

export function addNote(note: Note): void {
  notes[note.id] = note;
  queue(note.id);
}

/** Soft-deletes a note and its descendants. Tombstones keep no content, so deleted secrets do not linger. */
export function deleteNoteTree(id: string): string[] {
  const ids = [id];
  const seen = new Set(ids);
  for (let i = 0; i < ids.length; i++) {
    for (const n of activeNotes()) {
      if (n.parentId === ids[i] && !seen.has(n.id)) { seen.add(n.id); ids.push(n.id); }
    }
  }
  const t = now();
  for (const nid of ids) {
    const n = notes[nid];
    if (!n) continue;
    notes[nid] = { ...n, title: '', blocks: [], isSticky: false, deleted: true, updatedAt: Math.max(t, n.updatedAt + 1) };
    queue(nid);
  }
  return ids;
}

function queue(id: string): void {
  pending.add(id);
  flushTimer ??= setTimeout(() => {
    flushTimer = null;
    flush().catch(err => console.error('Encrypting notes failed', err));
  }, 250);
}

/** Encrypts every queued note into the outbox now. */
export function flush(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flushChain = flushChain.then(encryptPending, encryptPending);
  return flushChain;
}

async function encryptPending(): Promise<void> {
  if (!pending.size || !vaultKey) return;
  const key = vaultKey;
  const ids = [...pending];
  pending.clear();
  const sealed: Envelope[] = [];
  for (const id of ids) {
    const note = notes[id];
    if (!note) continue;
    const env = encryptNote(key, note);
    envelopes.set(id, env);
    outbox.add(id);
    sealed.push(env);
  }
  if (sealed.length) journal?.put(sealed, true);
  persisted();
}

// ---- Server round trips (used by sync.ts) ----

/** Envelopes waiting to be sent. */
export const outgoing = (): Envelope[] => [...outbox].flatMap(id => envelopes.get(id) ?? []);

/** The server stored these; drop them from the outbox unless they were edited again meanwhile. */
export function confirmSent(sent: Envelope[]): void {
  const confirmed = sent.filter(env => envelopes.get(env.id) === env);
  for (const env of confirmed) outbox.delete(env.id);
  if (confirmed.length) journal?.clean(confirmed);
}

/** Every stored envelope (the desktop build uploads them when a file is linked to an account). */
export const allEnvelopes = (): Envelope[] => [...envelopes.values()];

/** Queues every note for the server, e.g. right after linking a vault file to an account. */
export function markAllUnsent(): void {
  if (!envelopes.size) return;
  for (const id of envelopes.keys()) outbox.add(id);
  journal?.put([...envelopes.values()], true);
  persisted();
}

/** A profile change to push with the next sync (and clear the flag). */
export function takeDirtyHeader(): VaultHeader | undefined {
  if (!headerDirty || !header) return undefined;
  headerDirty = false;
  return header;
}
export const markHeaderDirty = (): void => { headerDirty = true; };

// ---- Changes from elsewhere ----

/**
 * Applies envelopes from the server or a backup file. Last write wins per note. With `upload`,
 * accepted notes are also queued for the server (used for backup imports).
 */
export function applyEnvelopes(list: Envelope[], upload = false): { changed: number; failed: number } {
  const key = requireKey();
  const ids: string[] = [];
  const accepted: Envelope[] = [];
  let failed = 0;
  for (const env of list) {
    const local = notes[env.id];
    if (local && env.updatedAt <= local.updatedAt) continue;
    try {
      notes[env.id] = decryptNote(key, env);
      envelopes.set(env.id, env);
      pending.delete(env.id);
      if (upload) outbox.add(env.id); else outbox.delete(env.id);
      ids.push(env.id);
      accepted.push(env);
    } catch {
      failed++;
    }
  }
  if (accepted.length) journal?.put(accepted, upload);
  if (ids.length) {
    emit('external', ids);
    if (upload) persisted();
  }
  return { changed: ids.length, failed };
}

/** Encrypts plaintext notes from the legacy format and queues them for the server. */
export async function importPlainNotes(list: Note[]): Promise<number> {
  const ids: string[] = [];
  for (const note of list) {
    const local = notes[note.id];
    if (local && note.updatedAt <= local.updatedAt) continue;
    notes[note.id] = note;
    pending.add(note.id);
    ids.push(note.id);
  }
  if (ids.length) {
    await flush();
    emit('external', ids);
  }
  return ids.length;
}

/** Adopts a header from the server if it is newer and signed with this vault's key. */
export function adoptHeader(h: VaultHeader): boolean {
  if (!header || !vaultKey || h.vaultId !== header.vaultId || h.updatedAt <= header.updatedAt) return false;
  if (!verifyHeader(h, vaultKey)) return false;
  replaceHeader(h);
  emit('header');
  return true;
}

/**
 * Takes an account's header (its password and recovery slots) for a desktop vault file being linked,
 * even if it is older, while keeping this file's newer user name. False if it is another vault.
 */
export function adoptAccountHeader(h: VaultHeader): boolean {
  if (!header || !vaultKey || h.vaultId !== header.vaultId || !verifyHeader(h, vaultKey)) return false;
  const mine = profile;
  let next = h;
  if (mine && header.updatedAt >= h.updatedAt && readProfile(h, vaultKey)?.userName !== mine.userName) {
    next = setProfile(h, vaultKey, mine);
    headerDirty = true;
  }
  replaceHeader(next);
  emit('header');
  return true;
}

/**
 * For creating an online account from a desktop vault file: checks the password and prepares a fresh
 * recovery key (the old one was never sent anywhere). Nothing changes until adoptHeader(result.header).
 */
export function prepareAccount(password: string): { header: VaultHeader; authKey: Uint8Array; recoveryAuthKey: Uint8Array; recoveryKey: string } {
  const h = header;
  if (!h) throw new Error('The vault is locked.');
  const authKey = currentAuthKey(h, password);
  const rotated = rotateRecoveryKey(h, requireKey());
  return { header: rotated.header, authKey, recoveryAuthKey: rotated.recoveryAuthKey, recoveryKey: rotated.recoveryKey };
}

function replaceHeader(h: VaultHeader): void {
  header = h;
  profile = vaultKey ? readProfile(h, vaultKey) : null;
  journal?.header(h);
}

/** Stores a new user name in the encrypted profile; the next sync sends it with the header. */
export function setUserName(userName: string): void {
  const h = header;
  if (!h) throw new Error('The vault is locked.');
  const key = requireKey();
  replaceHeader(setProfile(h, key, { userName }));
  headerDirty = true;
  emit('header');
  persisted();
}

// ---- Account maintenance (server confirms with the current password's auth key) ----

/** Derives the current password's auth key, and checks the password locally. Throws WrongSecretError. */
function currentAuthKey(h: VaultHeader, password: string): Uint8Array {
  const kek = deriveKek(password, h.kdf);
  try {
    wipe(unlockWithKek(h, kek));
    return authKeyFromKek(kek);
  } finally {
    wipe(kek);
  }
}

/** With an online account the server must accept the change first; a local vault file just re-wraps. */
export async function changePassword(current: string, next: string): Promise<void> {
  const h = header;
  if (!h) throw new Error('The vault is locked.');
  const currentKey = currentAuthKey(h, current);
  const rewrapped = rewrapPasswordWithAuth(h, requireKey(), next);
  try {
    replaceHeader(remoteAccount
      ? await api.updateAccount({ currentAuthKey: currentKey, header: rewrapped.header, authKey: rewrapped.authKey })
      : rewrapped.header);
  } finally {
    wipe(currentKey); wipe(rewrapped.authKey);
  }
}

/** Returns the new recovery key; the old one stops working. */
export async function newRecoveryKey(current: string): Promise<string> {
  const h = header;
  if (!h) throw new Error('The vault is locked.');
  const currentKey = currentAuthKey(h, current);
  const rotated = rotateRecoveryKey(h, requireKey());
  try {
    replaceHeader(remoteAccount
      ? await api.updateAccount({ currentAuthKey: currentKey, header: rotated.header, recoveryAuthKey: rotated.recoveryAuthKey })
      : rotated.header);
    return rotated.recoveryKey;
  } finally {
    wipe(currentKey); wipe(rotated.recoveryAuthKey);
  }
}

// ---- Encrypted backups ----

export interface Backup { format: 'cherrion-backup'; v: 1; exportedAt: number; header: VaultHeader; notes: Envelope[] }

export async function makeBackup(): Promise<Backup> {
  await flush();
  if (!header) throw new Error('The vault is locked.');
  return { format: 'cherrion-backup', v: 1, exportedAt: now(), header, notes: [...envelopes.values()] };
}

export function isBackup(x: unknown): x is Backup {
  if (typeof x !== 'object' || x === null) return false;
  const b = x as Partial<Backup>;
  return b.format === 'cherrion-backup' && b.v === 1 && isVaultHeader(b.header)
    && Array.isArray(b.notes) && b.notes.every(isEnvelope);
}
