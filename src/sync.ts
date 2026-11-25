// Sync with the optional relay in sync-server.js. The relay keeps one record per id and
// resolves conflicts with last-write-wins on updatedAt. We send encrypted envelopes plus a
// `__vault__` record holding the (key-wrapped) vault header, so a second device can join
// with just the room key and the vault password.
import * as db from './db';
import { isEnvelope, type Envelope } from './envelope';
import { parseLegacyNotes, stampForMigration } from './legacy';
import { VAULT_RECORD_ID, type Note } from './model';
import { settings } from './settings';
import * as store from './store';
import { isVaultHeader, type VaultHeader } from './vault';

export type SyncState =
  | { kind: 'local' }
  | { kind: 'syncing' }
  | { kind: 'synced'; at: number; unreadable: number }
  | { kind: 'error'; message: string };

type RoomRecords = Record<string, unknown>;
interface VaultRecord { id: typeof VAULT_RECORD_ID; updatedAt: number; header: VaultHeader }

export type RoomPlan =
  | { kind: 'foreign' }
  | { kind: 'ok'; remoteHeader: VaultHeader | null; envelopes: Envelope[]; legacy: Note[] };

function isVaultRecord(x: unknown): x is VaultRecord {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Partial<VaultRecord>;
  return r.id === VAULT_RECORD_ID && isVaultHeader(r.header) && r.updatedAt === r.header.updatedAt;
}

/** Decides what to take from a room's records. Pure, so it is unit-tested directly. */
export function planRoom(records: RoomRecords, localVaultId: string): RoomPlan {
  const vaultRecord = records[VAULT_RECORD_ID];
  const remoteHeader = isVaultRecord(vaultRecord) ? vaultRecord.header : null;
  if (remoteHeader && remoteHeader.vaultId !== localVaultId) return { kind: 'foreign' };
  const envelopes = Object.entries(records)
    .filter(([id, value]) => id !== VAULT_RECORD_ID && isEnvelope(value))
    .map(([, value]) => value as Envelope);
  // Plaintext records are only accepted from a room no vault has claimed yet, i.e. data
  // synced before encryption existed. After that, unauthenticated plaintext is ignored.
  const legacy = vaultRecord === undefined ? parseLegacyNotes(records) : [];
  return { kind: 'ok', remoteHeader, envelopes, legacy };
}

async function postRoom(url: string, room: string, records: RoomRecords): Promise<RoomRecords> {
  const base = url.trim().replace(/\/+$/, '');
  const res = await fetch(`${base}/sync/${encodeURIComponent(room || 'default')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: records }),
  });
  if (!res.ok) throw new Error(`The sync server replied ${res.status}.`);
  const data = (await res.json()) as { notes?: unknown };
  return typeof data.notes === 'object' && data.notes !== null ? (data.notes as RoomRecords) : {};
}

/** Reads a room without writing to it (the relay merges an empty set and returns everything). */
export async function fetchVaultFromRoom(url: string, room: string): Promise<{ header: VaultHeader; records: RoomRecords }> {
  const records = await postRoom(url, room, {});
  const rec = records[VAULT_RECORD_ID];
  if (!isVaultRecord(rec)) {
    throw new Error('No Cherrion vault was found in that room. Create the vault on your first device and sync it there first.');
  }
  return { header: rec.header, records };
}

let state: SyncState = { kind: 'local' };
const stateListeners = new Set<(s: SyncState) => void>();
export const onSyncState = (fn: (s: SyncState) => void) => { stateListeners.add(fn); fn(state); };
export const getSyncState = (): SyncState => state;
const setState = (s: SyncState) => { state = s; stateListeners.forEach(fn => fn(s)); };

/** Applies a room's records to the session. Returns how many envelopes could not be decrypted. */
export async function absorbRoom(records: RoomRecords): Promise<number> {
  const header = store.getHeader();
  if (!header) throw new Error('The vault is locked.');
  const plan = planRoom(records, header.vaultId);
  if (plan.kind === 'foreign') {
    throw new Error('This sync room belongs to a different vault. Choose another room key in Settings.');
  }
  if (plan.remoteHeader && plan.remoteHeader.updatedAt > header.updatedAt && !(await store.adoptHeader(plan.remoteHeader))) {
    console.warn('Ignored a vault header from the sync server that is not signed with this vault key.');
  }
  if (plan.legacy.length) await store.importPlainNotes(stampForMigration(plan.legacy));
  return (await store.applyEnvelopes(plan.envelopes)).failed;
}

async function syncOnce(): Promise<void> {
  if (!settings.syncUrl) { setState({ kind: 'local' }); return; }
  if (!store.isUnlocked()) return;
  setState({ kind: 'syncing' });
  try {
    await store.flush();
    // Read first, so we never upload into a room that belongs to another vault.
    await absorbRoom(await postRoom(settings.syncUrl, settings.syncKey, {}));
    await store.flush();
    const header = store.getHeader();
    if (!header) return;
    const payload: RoomRecords = {
      [VAULT_RECORD_ID]: { id: VAULT_RECORD_ID, updatedAt: header.updatedAt, header } satisfies VaultRecord,
    };
    for (const env of await db.getAllEnvelopes()) payload[env.id] = env;
    const unreadable = await absorbRoom(await postRoom(settings.syncUrl, settings.syncKey, payload));
    setState({ kind: 'synced', at: Date.now(), unreadable });
  } catch (err) {
    setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

let running: Promise<void> | null = null;
let rerun = false;

export function syncNow(): Promise<void> {
  if (running) { rerun = true; return running; }
  running = (async () => {
    try {
      do { rerun = false; await syncOnce(); } while (rerun);
    } finally {
      running = null;
    }
  })();
  return running;
}

let timer: ReturnType<typeof setTimeout> | null = null;
export function scheduleSync(): void {
  if (!settings.syncUrl) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void syncNow(); }, 1200);
}

export function resetSyncState(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  setState({ kind: 'local' });
}
