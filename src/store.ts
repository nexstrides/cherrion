// The unlocked session: the vault key and decrypted notes live only here, in memory. The web app is
// online-only: nothing is written to browser storage. Edits are encrypted into envelopes and queued
// in an outbox, which sync.ts pushes to the server shortly after.
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

export function unlock(h: VaultHeader, key: Uint8Array, initial: Envelope[]): void {
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
  for (const id of ids) {
    const note = notes[id];
    if (!note) continue;
    envelopes.set(id, encryptNote(key, note));
    outbox.add(id);
  }
  persisted();
}

// ---- Server round trips (used by sync.ts) ----

/** Envelopes waiting to be sent. */
export const outgoing = (): Envelope[] => [...outbox].flatMap(id => envelopes.get(id) ?? []);

/** The server stored these; drop them from the outbox unless they were edited again meanwhile. */
export function confirmSent(sent: Envelope[]): void {
  for (const env of sent) if (envelopes.get(env.id) === env) outbox.delete(env.id);
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
    } catch {
      failed++;
    }
  }
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
  header = h;
  profile = readProfile(h, vaultKey);
  emit('header');
  return true;
}

/** Stores a new user name in the encrypted profile; the next sync sends it with the header. */
export function setUserName(userName: string): void {
  const h = header;
  if (!h) throw new Error('The vault is locked.');
  const key = requireKey();
  header = setProfile(h, key, { userName });
  profile = readProfile(header, key);
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

export async function changePassword(current: string, next: string): Promise<void> {
  const h = header;
  if (!h) throw new Error('The vault is locked.');
  const currentKey = currentAuthKey(h, current);
  const rewrapped = rewrapPasswordWithAuth(h, requireKey(), next);
  try {
    header = await api.updateAccount({ currentAuthKey: currentKey, header: rewrapped.header, authKey: rewrapped.authKey });
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
    header = await api.updateAccount({ currentAuthKey: currentKey, header: rotated.header, recoveryAuthKey: rotated.recoveryAuthKey });
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
