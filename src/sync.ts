// Keeps the in-memory session and the server in step: pushes the outbox, pulls what changed on other
// devices (by server revision), and reports Online / Saving / Offline for the status under the name.
import { ApiError, api, hasSession } from './api';
import type { Envelope } from './envelope';
import * as store from './store';
import type { VaultHeader } from './vault';

export type SyncState =
  | { kind: 'idle' }
  | { kind: 'syncing' }
  | { kind: 'synced'; at: number; unreadable: number }
  | { kind: 'offline'; unsaved: number }
  | { kind: 'error'; message: string };

let state: SyncState = { kind: 'idle' };
const stateListeners = new Set<(s: SyncState) => void>();
export const onSyncState = (fn: (s: SyncState) => void) => { stateListeners.add(fn); fn(state); };
export const getSyncState = (): SyncState => state;
const setState = (s: SyncState) => { state = s; stateListeners.forEach(fn => fn(s)); };

/** Called when the server says the session ended (sync.ts cannot lock the UI itself). */
let onExpired: (message: string) => void = () => {};
export const onSessionExpired = (fn: (message: string) => void) => { onExpired = fn; };

/** Highest server revision seen. Pulls re-read a small window below it, which is harmless (last write wins). */
let since = 0;
const OVERLAP = 100;

/** Everything in the account, right after login. */
export async function loadAll(): Promise<{ notes: Envelope[]; header: VaultHeader | null }> {
  since = 0;
  const all: Envelope[] = [];
  let header: VaultHeader | null = null;
  for (;;) {
    const res = await api.sync({ since, notes: [] });
    all.push(...res.notes);
    header = res.header;
    since = res.rev;
    if (!res.more) break;
  }
  return { notes: all, header };
}

async function syncOnce(): Promise<void> {
  if (!hasSession() || !store.isUnlocked()) return;
  if (!navigator.onLine) { setState({ kind: 'offline', unsaved: store.unsavedCount() }); return; }
  setState({ kind: 'syncing' });
  const dirtyHeader = store.takeDirtyHeader();
  try {
    await store.flush();
    const sent = store.outgoing();
    let res = await api.sync({ since: Math.max(0, since - OVERLAP), notes: sent, ...(dirtyHeader ? { header: dirtyHeader } : {}) });
    store.confirmSent(sent);
    let unreadable = 0;
    for (;;) {
      unreadable += store.applyEnvelopes(res.notes).failed;
      since = Math.max(since, res.rev);
      if (!res.more) break;
      res = await api.sync({ since, notes: [] });
    }
    store.adoptHeader(res.header);
    setState(store.unsavedCount() ? { kind: 'idle' } : { kind: 'synced', at: Date.now(), unreadable });
    if (store.unsavedCount()) scheduleSync(); // edited while this round was in flight
  } catch (err) {
    if (dirtyHeader) store.markHeaderDirty();
    if (err instanceof ApiError && err.status === 401) { onExpired(err.message); return; }
    if (err instanceof ApiError && err.status === 0) { setState({ kind: 'offline', unsaved: store.unsavedCount() }); return; }
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
/** Pushes soon after an edit (edits arriving close together go in one request). */
export function scheduleSync(delay = 600): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void syncNow(); }, delay);
}

let poller: ReturnType<typeof setInterval> | null = null;
/** Pulls other devices' changes every 20 s while the page is visible. */
export function startSync(): void {
  stopSync();
  poller = setInterval(() => { if (document.visibilityState === 'visible') void syncNow(); }, 20_000);
}

export function stopSync(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (poller) { clearInterval(poller); poller = null; }
  since = 0;
  setState({ kind: 'idle' });
}
