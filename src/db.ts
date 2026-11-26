// Reads the vault that earlier versions stored in this browser (IndexedDB "cherrion"), so it can be
// moved into an online account at sign-up. The web app no longer writes to browser storage.
import { isEnvelope, type Envelope } from './envelope';
import { isVaultHeader, type VaultHeader } from './vault';

const DB_NAME = 'cherrion';
const META = 'meta';
const NOTES = 'notes';
const HEADER_KEY = 'vault-header';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function exists(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  if (typeof indexedDB.databases !== 'function') return true; // older browsers: try to open it
  return (await indexedDB.databases()).some(d => d.name === DB_NAME);
}

export interface LocalVault { header: VaultHeader; notes: Envelope[] }

/** The vault an earlier version saved in this browser, or null. Never creates the database. */
export async function readLocalVault(): Promise<LocalVault | null> {
  try {
    if (!(await exists())) return null;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);
      req.onupgradeneeded = () => req.transaction?.abort(); // it did not exist after all
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      if (!db.objectStoreNames.contains(META) || !db.objectStoreNames.contains(NOTES)) return null;
      const tx = db.transaction([META, NOTES]);
      const header: unknown = await request(tx.objectStore(META).get(HEADER_KEY));
      const notes: unknown[] = await request(tx.objectStore(NOTES).getAll());
      return isVaultHeader(header) ? { header, notes: notes.filter(isEnvelope) } : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Removes the browser copy after it has been moved into an account. */
export function deleteLocalVault(): Promise<void> {
  return new Promise(resolve => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
