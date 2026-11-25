// Migration from the original plaintext format ({ notes: { [id]: note } } in localStorage,
// in exported JSON files, and on the sync server).
import { isEnvelope } from './envelope';
import { VAULT_RECORD_ID, normalizeNote, now, type Note } from './model';

const LEGACY_STATE_KEY = 'cherrion_state_v1';

export function parseLegacyNotes(notes: unknown): Note[] {
  if (typeof notes !== 'object' || notes === null) return [];
  return Object.entries(notes as Record<string, unknown>)
    .filter(([id, value]) => id !== VAULT_RECORD_ID && !isEnvelope(value))
    .map(([, value]) => normalizeNote(value))
    .filter((n): n is Note => n !== null);
}

export function readLegacyLocalNotes(): Note[] {
  try {
    const raw = localStorage.getItem(LEGACY_STATE_KEY);
    return raw ? parseLegacyNotes((JSON.parse(raw) as { notes?: unknown }).notes) : [];
  } catch {
    return [];
  }
}

export function clearLegacyLocalNotes(): void {
  try { localStorage.removeItem(LEGACY_STATE_KEY); } catch { /* storage unavailable */ }
}

/**
 * Plaintext copies may also exist on the sync server. Stamping migrated notes with a newer
 * updatedAt makes the encrypted copies win last-write-wins, so the server overwrites the plaintext.
 */
export function stampForMigration(notes: Note[], at = now()): Note[] {
  return notes.map(n => {
    const updatedAt = Math.max(n.updatedAt + 1, at);
    // Old tombstones still carried their content; drop it as the encrypted store does.
    return n.deleted ? { ...n, title: '', blocks: [], isSticky: false, updatedAt } : { ...n, updatedAt };
  });
}
