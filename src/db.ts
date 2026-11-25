// IndexedDB persistence. Holds only the vault header and encrypted note envelopes.
import type { Envelope } from './envelope';
import type { VaultHeader } from './vault';

const DB_NAME = 'cherrion';
const DB_VERSION = 1;
const META = 'meta';
const NOTES = 'notes';
const HEADER_KEY = 'vault-header';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(NOTES)) db.createObjectStore(NOTES, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Let a newer version (or a deletion) proceed instead of being blocked by this tab.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another open Cherrion tab. Close other tabs and reload.'));
  });
  return dbPromise;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export async function getHeader(): Promise<VaultHeader | undefined> {
  const db = await openDb();
  return request(db.transaction(META).objectStore(META).get(HEADER_KEY)) as Promise<VaultHeader | undefined>;
}

export async function putHeader(header: VaultHeader): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(META, 'readwrite');
  tx.objectStore(META).put(header, HEADER_KEY);
  await done(tx);
}

export async function getEnvelope(id: string): Promise<Envelope | undefined> {
  const db = await openDb();
  return request(db.transaction(NOTES).objectStore(NOTES).get(id)) as Promise<Envelope | undefined>;
}

export async function getAllEnvelopes(): Promise<Envelope[]> {
  const db = await openDb();
  return request(db.transaction(NOTES).objectStore(NOTES).getAll()) as Promise<Envelope[]>;
}

export async function putEnvelopes(envelopes: Envelope[]): Promise<void> {
  if (!envelopes.length) return;
  const db = await openDb();
  const tx = db.transaction(NOTES, 'readwrite');
  const store = tx.objectStore(NOTES);
  for (const env of envelopes) store.put(env);
  await done(tx);
}
