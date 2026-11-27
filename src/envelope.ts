// Encrypted form of a note: what IndexedDB, backups and the sync server store.
// Only id, updatedAt and deleted are visible, and all three are bound into the
// associated data, so a server cannot alter them or move ciphertext between notes.
import { DecryptError, openString, seal } from './crypto';
import { normalizeNote, type Note } from './model';

/** `k` is set only on workspace notes: the number of the workspace key that encrypted it. */
export interface Envelope { id: string; updatedAt: number; deleted: boolean; v: 1; nonce: string; ct: string; k?: number }

const noteAad = (id: string, updatedAt: number, deleted: boolean) =>
  `cherrion/note/v1/${id}/${updatedAt}/${deleted ? 1 : 0}`;

export function encryptNote(vaultKey: Uint8Array, note: Note): Envelope {
  const { nonce, ct } = seal(vaultKey, JSON.stringify(note), noteAad(note.id, note.updatedAt, note.deleted));
  return { id: note.id, updatedAt: note.updatedAt, deleted: note.deleted, v: 1, nonce, ct };
}

export function decryptNote(vaultKey: Uint8Array, env: Envelope): Note {
  const json = openString(vaultKey, env, noteAad(env.id, env.updatedAt, env.deleted));
  const note = normalizeNote(JSON.parse(json));
  if (!note || note.id !== env.id || note.updatedAt !== env.updatedAt || note.deleted !== env.deleted) {
    throw new DecryptError('Envelope metadata does not match its contents');
  }
  return note;
}

export { isEnvelope } from './shapes';

// ---- Shared workspace notes ----
// Encrypted with the workspace key number `k`; the workspace id and key number are bound into the
// associated data too, so the server cannot move a note between workspaces or key versions.

const workspaceNoteAad = (workspaceId: string, k: number, id: string, updatedAt: number, deleted: boolean) =>
  `cherrion/ws-note/v1/${workspaceId}/${k}/${id}/${updatedAt}/${deleted ? 1 : 0}`;

export function encryptWorkspaceNote(key: Uint8Array, k: number, workspaceId: string, note: Note): Envelope {
  const { nonce, ct } = seal(key, JSON.stringify(note), workspaceNoteAad(workspaceId, k, note.id, note.updatedAt, note.deleted));
  return { id: note.id, updatedAt: note.updatedAt, deleted: note.deleted, v: 1, nonce, ct, k };
}

export function decryptWorkspaceNote(key: Uint8Array, workspaceId: string, env: Envelope): Note {
  if (!env.k) throw new DecryptError('Not a workspace note');
  const json = openString(key, env, workspaceNoteAad(workspaceId, env.k, env.id, env.updatedAt, env.deleted));
  const note = normalizeNote(JSON.parse(json));
  if (!note || note.id !== env.id || note.updatedAt !== env.updatedAt || note.deleted !== env.deleted) {
    throw new DecryptError('Envelope metadata does not match its contents');
  }
  return note;
}
