// Encrypted form of a note: what IndexedDB, backups and the sync server store.
// Only id, updatedAt and deleted are visible, and all three are bound into the
// associated data, so a server cannot alter them or move ciphertext between notes.
import { DecryptError, openString, seal } from './crypto';
import { isSecretKind, normalizeNote, type Note } from './model';

/** `k` is set only on workspace notes: the number of the workspace key that encrypted it. */
export interface Envelope { id: string; updatedAt: number; deleted: boolean; v: 1; nonce: string; ct: string; k?: number }

/** Splits envelopes into batches of about `budget` bytes of JSON (a bigger single note goes alone). */
export function batchBySize(list: Envelope[], budget: number): Envelope[][] {
  const batches: Envelope[][] = [];
  let current: Envelope[] = [];
  let size = 0;
  for (const env of list) {
    const n = JSON.stringify(env).length;
    if (current.length && size + n > budget) { batches.push(current); current = []; size = 0; }
    current.push(env);
    size += n;
  }
  if (current.length) batches.push(current);
  return batches;
}

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

// Secret field values (passwords, secret notes, 2FA keys) in a workspace that hides them from
// viewers are sealed again, with the secrets key that only owners and editors hold. The workspace,
// key number, page and field are bound in, so a sealed value cannot be moved to another field.
const secretAad = (workspaceId: string, s: number, noteId: string, fieldId: string) =>
  `cherrion/ws-secret/v1/${workspaceId}/${s}/${noteId}/${fieldId}`;

/** The page as stored: secret values sealed with `secrets` when given (or kept sealed when locked). */
function storedForm(note: Note, workspaceId: string, secrets: { s: number; key: Uint8Array } | null): Note {
  return {
    ...note,
    blocks: note.blocks.map(b => (b.type !== 'fields' ? b : {
      ...b,
      fields: b.fields.map(({ locked, sv, ...f }) => {
        if (!isSecretKind(f.kind)) return f;
        // A value this device could not open stays exactly as it was (never replaced by nothing).
        if (locked && sv) return { ...f, value: '', sv };
        if (!secrets || !f.value) return f;
        const sealed = seal(secrets.key, f.value, secretAad(workspaceId, secrets.s, note.id, f.id));
        return { ...f, value: '', sv: { s: secrets.s, ...sealed } };
      }),
    })),
  };
}

/**
 * `secrets`: the current secrets key when the workspace hides secret fields from viewers (null when
 * viewers may see them, so values are stored as they are).
 */
export function encryptWorkspaceNote(key: Uint8Array, k: number, workspaceId: string, note: Note,
  secrets: { s: number; key: Uint8Array } | null = null): Envelope {
  const stored = storedForm(note, workspaceId, secrets);
  const { nonce, ct } = seal(key, JSON.stringify(stored), workspaceNoteAad(workspaceId, k, note.id, note.updatedAt, note.deleted));
  return { id: note.id, updatedAt: note.updatedAt, deleted: note.deleted, v: 1, nonce, ct, k };
}

/** `secretKeys`: the secrets keys this account holds (none for viewers); other sealed values stay locked. */
export function decryptWorkspaceNote(key: Uint8Array, workspaceId: string, env: Envelope,
  secretKeys: Map<number, Uint8Array> = new Map()): Note {
  if (!env.k) throw new DecryptError('Not a workspace note');
  const json = openString(key, env, workspaceNoteAad(workspaceId, env.k, env.id, env.updatedAt, env.deleted));
  const note = normalizeNote(JSON.parse(json));
  if (!note || note.id !== env.id || note.updatedAt !== env.updatedAt || note.deleted !== env.deleted) {
    throw new DecryptError('Envelope metadata does not match its contents');
  }
  for (const b of note.blocks) {
    if (b.type !== 'fields') continue;
    for (const f of b.fields) {
      if (!f.sv) continue;
      const sk = secretKeys.get(f.sv.s);
      try {
        if (!sk) throw new DecryptError('No secrets key');
        f.value = openString(sk, f.sv, secretAad(workspaceId, f.sv.s, note.id, f.id));
        delete f.sv;
      } catch {
        f.value = '';
        f.locked = true;
      }
    }
  }
  return note;
}
