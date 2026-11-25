// The unlocked session: the vault key and decrypted notes live only here, in memory.
// Edits are encrypted and written to IndexedDB shortly after they happen; other tabs are
// told which notes changed over BroadcastChannel and re-read them from IndexedDB.
import { wipe } from './crypto';
import * as db from './db';
import { decryptNote, encryptNote, isEnvelope, type Envelope } from './envelope';
import { now, type Note } from './model';
import {
  isVaultHeader, readProfile, rewrapPassword, rotateRecoveryKey, setProfile, unlockWithPassword, verifyHeader,
  type Profile, type VaultHeader,
} from './vault';

export type ChangeReason = 'external' | 'header';
/** `ids` lists the notes that were replaced, so the UI can avoid re-rendering the note being edited. */
export interface Change { reason: ChangeReason; ids: string[] }

type Message = { type: 'notes'; ids: string[] } | { type: 'header' } | { type: 'lock' };

let header: VaultHeader | null = null;
let vaultKey: Uint8Array | null = null;
let profile: Profile | null = null;
let notes: Record<string, Note> = {};
let undecryptable = 0;

const pending = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushChain: Promise<void> = Promise.resolve();

const changeListeners = new Set<(change: Change) => void>();
const persistListeners = new Set<() => void>();
const lockListeners = new Set<() => void>();

export const onChange = (fn: (change: Change) => void) => changeListeners.add(fn);
export const onPersisted = (fn: () => void) => persistListeners.add(fn);
/** Another tab asked every tab to lock. */
export const onLockRequest = (fn: () => void) => lockListeners.add(fn);
const emit = (reason: ChangeReason, ids: string[] = []) => changeListeners.forEach(fn => fn({ reason, ids }));

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('cherrion_sync') : null;
const post = (msg: Message) => channel?.postMessage(msg);

if (channel) {
  channel.onmessage = (e: MessageEvent<Message>) => {
    const msg = e.data;
    if (msg?.type === 'lock') { lockListeners.forEach(fn => fn()); return; }
    if (!vaultKey) return;
    if (msg?.type === 'notes') void reloadFromDb(msg.ids);
    if (msg?.type === 'header') void reloadHeader();
  };
}

// ---- Read access ----

export const getHeader = (): VaultHeader | null => header;
/** Decrypted profile of the unlocked vault (null when locked or never set). */
export const getProfile = (): Profile | null => profile;
export const isUnlocked = (): boolean => vaultKey !== null;
export const undecryptableCount = (): number => undecryptable;
export const allNotes = (): Note[] => Object.values(notes);
export const activeNotes = (): Note[] => Object.values(notes).filter(n => !n.deleted);
export const getNote = (id: string | null): Note | undefined => (id ? notes[id] : undefined);

function requireKey(): Uint8Array {
  if (!vaultKey) throw new Error('The vault is locked.');
  return vaultKey;
}

// ---- Lifecycle ----

/** Stores a header without needing the key (used while creating or joining a vault). */
export async function saveHeader(h: VaultHeader): Promise<void> {
  header = h;
  await db.putHeader(h);
  post({ type: 'header' });
}

export async function unlock(h: VaultHeader, key: Uint8Array): Promise<void> {
  header = h;
  vaultKey = key;
  profile = readProfile(h, key);
  notes = {};
  undecryptable = 0;
  for (const env of await db.getAllEnvelopes()) {
    try { notes[env.id] = decryptNote(key, env); } catch { undecryptable++; }
  }
}

export async function lock(): Promise<void> {
  try { await flush(); } catch (err) { console.error('Could not save pending changes before locking', err); }
  wipe(vaultKey);
  vaultKey = null;
  profile = null;
  notes = {};
  pending.clear();
}

export const broadcastLock = (): void => post({ type: 'lock' });

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
    flush().catch(err => console.error('Saving encrypted notes failed', err));
  }, 250);
}

/** Encrypts and writes every queued note now. */
export function flush(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flushChain = flushChain.then(writePending, writePending);
  return flushChain;
}

async function writePending(): Promise<void> {
  if (!pending.size || !vaultKey) return;
  const key = vaultKey;
  const ids = [...pending];
  pending.clear();
  const envelopes = ids.flatMap(id => (notes[id] ? [encryptNote(key, notes[id])] : []));
  try {
    await db.putEnvelopes(envelopes);
  } catch (err) {
    ids.forEach(id => pending.add(id));
    throw err;
  }
  post({ type: 'notes', ids });
  persistListeners.forEach(fn => fn());
}

// ---- Changes from elsewhere ----

function adopt(envelopes: Envelope[]): { accepted: Envelope[]; failed: number } {
  const key = requireKey();
  const accepted: Envelope[] = [];
  let failed = 0;
  for (const env of envelopes) {
    const local = notes[env.id];
    if (local && env.updatedAt <= local.updatedAt) continue;
    try {
      notes[env.id] = decryptNote(key, env);
      pending.delete(env.id);
      accepted.push(env);
    } catch {
      failed++;
    }
  }
  return { accepted, failed };
}

/** Applies envelopes from the sync server or a backup. Last write wins per note. */
export async function applyEnvelopes(envelopes: Envelope[]): Promise<{ changed: number; failed: number }> {
  const { accepted, failed } = adopt(envelopes);
  if (accepted.length) {
    const ids = accepted.map(e => e.id);
    await db.putEnvelopes(accepted);
    post({ type: 'notes', ids });
    emit('external', ids);
  }
  return { changed: accepted.length, failed };
}

/** Encrypts plaintext notes from the legacy format. Last write wins per note. */
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

async function reloadFromDb(ids: string[]): Promise<void> {
  const envelopes = (await Promise.all(ids.map(id => db.getEnvelope(id)))).filter((e): e is Envelope => !!e);
  const { accepted } = adopt(envelopes);
  if (accepted.length) emit('external', accepted.map(e => e.id));
}

async function reloadHeader(): Promise<void> {
  const h = await db.getHeader();
  if (h && vaultKey && verifyHeader(h, vaultKey)) {
    header = h;
    profile = readProfile(h, vaultKey);
    emit('header');
  }
}

/** Adopts a header from the sync server if it is newer and signed with this vault's key. */
export async function adoptHeader(h: VaultHeader): Promise<boolean> {
  if (!header || !vaultKey || h.vaultId !== header.vaultId || h.updatedAt <= header.updatedAt) return false;
  if (!verifyHeader(h, vaultKey)) return false;
  await saveHeader(h);
  profile = readProfile(h, vaultKey);
  emit('header');
  return true;
}

/** Stores a new user name in the encrypted profile; it syncs with the vault header. */
export async function setUserName(userName: string): Promise<void> {
  const h = header;
  if (!h) throw new Error('The vault is locked.');
  const key = requireKey();
  const next = setProfile(h, key, { userName });
  await saveHeader(next);
  profile = readProfile(next, key);
  emit('header');
  persistListeners.forEach(fn => fn());
}

// ---- Vault maintenance ----

/** Throws WrongSecretError when `current` is wrong. */
export async function changePassword(current: string, next: string): Promise<void> {
  const h = header;
  if (!h) throw new Error('The vault is locked.');
  wipe(unlockWithPassword(h, current));
  await saveHeader(rewrapPassword(h, requireKey(), next));
  persistListeners.forEach(fn => fn());
}

/** Throws WrongSecretError when `current` is wrong. Returns the new recovery key. */
export async function newRecoveryKey(current: string): Promise<string> {
  const h = header;
  if (!h) throw new Error('The vault is locked.');
  wipe(unlockWithPassword(h, current));
  const rotated = rotateRecoveryKey(h, requireKey());
  await saveHeader(rotated.header);
  persistListeners.forEach(fn => fn());
  return rotated.recoveryKey;
}

// ---- Encrypted backups ----

export interface Backup { format: 'cherrion-backup'; v: 1; exportedAt: number; header: VaultHeader; notes: Envelope[] }

export async function makeBackup(): Promise<Backup> {
  await flush();
  if (!header) throw new Error('The vault is locked.');
  return { format: 'cherrion-backup', v: 1, exportedAt: now(), header, notes: await db.getAllEnvelopes() };
}

export function isBackup(x: unknown): x is Backup {
  if (typeof x !== 'object' || x === null) return false;
  const b = x as Partial<Backup>;
  return b.format === 'cherrion-backup' && b.v === 1 && isVaultHeader(b.header)
    && Array.isArray(b.notes) && b.notes.every(isEnvelope);
}
