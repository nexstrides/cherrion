// Encrypted form of a note: what IndexedDB, backups and the sync server store.
// Only id, updatedAt and deleted are visible, and all three are bound into the
// associated data, so a server cannot alter them or move ciphertext between notes.
import { DecryptError, openString, seal } from './crypto';
import { VAULT_RECORD_ID, normalizeNote, type Note } from './model';

export interface Envelope { id: string; updatedAt: number; deleted: boolean; v: 1; nonce: string; ct: string }

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

export function isEnvelope(x: unknown): x is Envelope {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Partial<Envelope>;
  return typeof e.id === 'string' && e.id.length > 0 && e.id !== VAULT_RECORD_ID
    && typeof e.updatedAt === 'number' && Number.isFinite(e.updatedAt)
    && typeof e.deleted === 'boolean' && e.v === 1
    && typeof e.nonce === 'string' && typeof e.ct === 'string';
}
