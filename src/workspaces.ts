// Shared workspaces, client side.
//
// Each workspace has its own random key (numbered: removing a member creates key n+1). Members get
// the keys sealed to their X25519 public key; the private key lives in the vault header, encrypted
// with the vault key. Invite links carry a secret after the # (never sent to the server) that
// decrypts the keys. The server only ever sees sealed keys and encrypted names and pages.
import { api, ApiError } from './api';
import {
  deriveSubkey, fingerprint, fromB64, newBoxKeyPair, openSealedBox, openString, randomBytes, randomKey, seal, sealTo,
  toB64, wipe, type BoxKeyPair, type Sealed,
} from './crypto';
import { batchBySize, type Envelope } from './envelope';
import * as store from './store';

export type Role = 'owner' | 'editor' | 'viewer';
export const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };

export interface Member { accountId: string; username: string; role: Role; publicKey: string | null }
export interface PendingInvite { id: string; role: Role; username: string | null; link: boolean; expiresAt: number }
export interface Workspace {
  id: string;
  name: string;
  role: Role;
  epoch: number;
  members: Member[];
  /** Pending invites (owners only). */
  invites: PendingInvite[];
  /** False when viewers may not read secret fields (they are sealed with a key viewers do not get). */
  viewerSecrets: boolean;
}
export interface Invitation { id: string; workspaceId: string; name: string; role: Role; from: string }

interface WorkspaceMeta extends Sealed { k: number }

let workspaces = new Map<string, Workspace>();
/** What listeners last saw (see refresh), and when the list was last read. */
let lastSignature = '';
let lastRefresh = 0;
const POLL_EVERY = 15_000;
let invitations: Invitation[] = [];
/** Invitations' sealed keys (kept to accept them). */
const invitationKeys = new Map<string, Record<string, string>>();
/** The server's list entries (sealed keys, encrypted name, members), for copies kept in a file. */
const rawById = new Map<string, Record<string, unknown>>();
/** Workspaces kept in the open desktop vault file, and the record last written for each. */
const kept = new Map<string, string>();
const listeners = new Set<() => void>();
export const onWorkspacesChange = (fn: () => void) => listeners.add(fn);
const changed = () => listeners.forEach(fn => fn());

export const listWorkspaces = (): Workspace[] => [...workspaces.values()].sort((a, b) => a.name.localeCompare(b.name));
export const getWorkspace = (id: string): Workspace | undefined => workspaces.get(id);
export const listInvitations = (): Invitation[] => invitations;

const metaAad = (workspaceId: string, k: number) => `cherrion/ws-meta/v1/${workspaceId}/${k}`;
const inviteAad = (inviteId: string) => `cherrion/ws-invite/v1/${inviteId}`;
const LINK_KEY = 'cherrion/ws-invite-key/v1';
const LINK_AUTH = 'cherrion/ws-invite-auth/v1';

function sealName(key: Uint8Array, k: number, workspaceId: string, name: string): WorkspaceMeta {
  return { k, ...seal(key, JSON.stringify({ name: name.trim().slice(0, 80) }), metaAad(workspaceId, k)) };
}

function openName(keys: Map<number, Uint8Array>, workspaceId: string, meta: WorkspaceMeta): string {
  const key = keys.get(meta.k);
  if (!key) return 'Workspace';
  try {
    const raw = JSON.parse(openString(key, meta, metaAad(workspaceId, meta.k))) as { name?: unknown };
    return typeof raw.name === 'string' && raw.name ? raw.name : 'Workspace';
  } catch {
    return 'Workspace';
  }
}

// ---- Identity ----

/**
 * Makes sure this account has a workspace identity (key pair), creating one the first time, and that
 * the server knows its public key. Returns it, or null when offline / not signed in.
 */
let published: string | null = null;
/** True once this account's workspace key is on the server (it takes one or two syncs after login). */
export const isReady = (): boolean => published !== null;

export async function ensureIdentity(): Promise<BoxKeyPair | null> {
  let identity = store.getIdentity();
  if (identity && published === toB64(identity.publicKey)) return identity;
  if (!identity) {
    // The new header goes to the server with the next sync; the public key is published after that.
    store.setIdentity(newBoxKeyPair());
    return null;
  }
  const mine = toB64(identity.publicKey);
  try {
    const { publicKey } = await api.workspace({ action: 'identity' });
    if (publicKey === null || publicKey === undefined) return null; // the header has not reached the server yet
    if (publicKey !== mine) {
      // Another device set up workspaces at the same moment and got there first: use its identity.
      const { header } = await api.sync({ since: Number.MAX_SAFE_INTEGER, notes: [] });
      store.adoptAccountHeader(header);
      identity = store.getIdentity();
      if (!identity || toB64(identity.publicKey) !== publicKey) return null;
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 0) return null;
    throw err;
  }
  published = toB64(identity.publicKey);
  return identity;
}

/**
 * One round for sync.ts, after the personal vault synced: sets up the identity, reloads the list of
 * workspaces and invitations, then pushes and pulls each workspace. Returns pages it could not read.
 */
export async function syncAll(): Promise<{ unreadable: number }> {
  if (!(await ensureIdentity())) return { unreadable: 0 };
  // Rounds run after every pause in typing: the list (invitations, members) is only re-read every
  // 15 s, and idle workspaces are pulled on the same schedule (the 20 s poll, Sync now).
  if (Date.now() - lastRefresh >= POLL_EVERY) await refresh();
  return syncWorkspaces({ idleToo: false });
}

/** "Sync now": the next round re-reads everything. */
export function syncSoon(): void {
  lastRefresh = 0;
  lastPull.clear();
}

/** Safety code: the same on both devices when the server handed out the right public keys. */
export function safetyCode(publicKeyA: string, publicKeyB: string): string {
  const [x, y] = [publicKeyA, publicKeyB].sort();
  const bytes = new Uint8Array([...fromB64(x!), ...fromB64(y!)]);
  return fingerprint(bytes).slice(0, 20).toUpperCase().replace(/(.{4})(?!$)/g, '$1 ');
}

export const myPublicKey = (): string | null => {
  const id = store.getIdentity();
  return id ? toB64(id.publicKey) : null;
};

// ---- Loading ----

/** Reads the workspaces this account belongs to and its invitations; updates the store's spaces. */
export async function refresh(): Promise<void> {
  const identity = store.getIdentity();
  if (!identity) { workspaces = new Map(); invitations = []; changed(); return; }
  const data = await api.workspace({ action: 'list' });
  lastRefresh = Date.now();
  const next = new Map<string, Workspace>();
  for (const raw of (Array.isArray(data.workspaces) ? data.workspaces : []) as Record<string, unknown>[]) {
    const entry = readEntry(raw, identity);
    if (!entry) continue; // cannot read or write this workspace yet
    store.setSpace(entry.ws.id, entry.keys, entry.ws.epoch, entry.ws.role === 'viewer', { keys: entry.skeys, hide: !entry.ws.viewerSecrets });
    next.set(entry.ws.id, entry.ws);
    rawById.set(entry.ws.id, raw);
  }
  for (const id of workspaces.keys()) if (!next.has(id)) { store.dropSpace(id); rawById.delete(id); }
  workspaces = next;
  // Desktop: the vault file keeps a copy of every workspace this account owns.
  if (store.canKeepSpaces()) {
    for (const ws of next.values()) if (ws.role === 'owner') keepInFile(ws.id);
    for (const id of [...kept.keys()]) {
      if (next.get(id)?.role !== 'owner') { kept.delete(id); store.keepSpace(id, null); } // deleted, or no longer an owner
    }
  }

  invitationKeys.clear();
  invitations = [];
  for (const raw of (Array.isArray(data.invitations) ? data.invitations : []) as Record<string, unknown>[]) {
    const sealedKeys = (raw.keys ?? {}) as Record<string, string>;
    const keys = new Map<number, Uint8Array>();
    for (const [k, sealed] of Object.entries(sealedKeys)) {
      try { keys.set(Number(k), openSealedBox(sealed, identity)); } catch { /* skip */ }
    }
    const name = openName(keys, String(raw.workspaceId), raw.meta as WorkspaceMeta);
    for (const key of keys.values()) wipe(key);
    invitationKeys.set(String(raw.id), sealedKeys);
    invitations.push({ id: String(raw.id), workspaceId: String(raw.workspaceId), name, role: raw.role as Role, from: String(raw.from ?? '') });
  }
  // Listeners re-render the switcher (and possibly the page): only when something really changed,
  // or the page being typed in would be rebuilt after every save.
  const signature = JSON.stringify([[...workspaces.values()], invitations]);
  if (signature !== lastSignature) { lastSignature = signature; changed(); }
}

/** One entry of the server's list (or of a vault file): its keys opened with this account's identity. */
function readEntry(raw: Record<string, unknown>, identity: BoxKeyPair):
  { ws: Workspace; keys: Map<number, Uint8Array>; skeys: Map<number, Uint8Array> } | null {
  const id = String(raw.id);
  const keys = openKeys(raw.keys, identity);
  const epoch = Number(raw.epoch);
  if (!keys.has(epoch)) { for (const key of keys.values()) wipe(key); return null; }
  return {
    keys,
    skeys: openKeys(raw.skeys, identity), // owners and editors, while secrets are hidden from viewers
    ws: {
      viewerSecrets: raw.viewerSecrets !== false,
      id, epoch, role: raw.role as Role,
      name: openName(keys, id, raw.meta as WorkspaceMeta),
      members: (Array.isArray(raw.members) ? raw.members : []) as Member[],
      invites: (Array.isArray(raw.invites) ? raw.invites : []) as PendingInvite[],
    },
  };
}

/** Keys sealed to this account, by key number (ones that do not open are left out). */
function openKeys(sealed: unknown, identity: BoxKeyPair): Map<number, Uint8Array> {
  const keys = new Map<number, Uint8Array>();
  for (const [k, value] of Object.entries((sealed ?? {}) as Record<string, string>)) {
    try { keys.set(Number(k), openSealedBox(value, identity)); } catch { /* not for us */ }
  }
  return keys;
}

/** Writes (or updates) the file's copy of a workspace: its list entry and how far it was pulled. */
function keepInFile(id: string): void {
  const raw = rawById.get(id);
  if (!raw) return;
  const record = JSON.stringify({ v: 1, raw, since: since.get(id) ?? 0 });
  if (kept.get(id) === record) return;
  kept.set(id, record);
  store.keepSpace(id, JSON.parse(record));
}

/**
 * Desktop: shows the workspaces kept in the vault file right after it is opened, before (or without)
 * a connection. The server's list replaces them at the first sync.
 */
export function loadFromFile(records: { id: string; record: unknown }[], items: { space: string; envelope: Envelope; dirty: boolean }[]): void {
  const identity = store.getIdentity();
  if (!identity) return;
  let loaded = 0;
  for (const { id, record } of records) {
    // Every copy in the file is tracked, so the next list removes it if the workspace is gone (or
    // rewrites it while this account still owns it), even if it cannot be read right now.
    kept.set(id, '');
    const data = store.openSpaceRecord(id, record) as { raw?: Record<string, unknown>; since?: number } | null;
    if (!data?.raw || String(data.raw.id) !== id) continue;
    const entry = readEntry(data.raw, identity);
    if (!entry) continue;
    store.loadKeptSpace(id, entry.keys, entry.ws.epoch, entry.ws.role === 'viewer', items.filter(i => i.space === id),
      { keys: entry.skeys, hide: !entry.ws.viewerSecrets });
    workspaces.set(id, entry.ws);
    rawById.set(id, data.raw);
    since.set(id, typeof data.since === 'number' ? data.since : 0);
    kept.set(id, JSON.stringify({ v: 1, raw: data.raw, since: since.get(id) }));
    loaded++;
  }
  if (loaded) { lastSignature = ''; changed(); }
}

/** Forgets everything (logging out, locking, or unlinking a desktop file): workspace pages included.
 *  Copies kept in a vault file stay there. */
export function reset(): void {
  for (const id of store.workspaceIds()) store.dropSpace(id);
  workspaces = new Map();
  rawById.clear();
  kept.clear();
  invitations = [];
  invitationKeys.clear();
  lastSignature = '';
  lastRefresh = 0;
  changed();
}

// ---- Owner actions ----

function requireIdentity(): BoxKeyPair {
  const identity = store.getIdentity();
  if (!identity) throw new Error('Workspaces are not set up yet. Check your connection and try again.');
  return identity;
}

/** The workspace's keys and secrets keys, freshly from the server. Wipe them with wipeRing. */
async function keyring(workspaceId: string): Promise<{ keys: Map<number, Uint8Array>; skeys: Map<number, Uint8Array> }> {
  const identity = requireIdentity();
  const data = await api.workspace({ action: 'list' });
  const raw = ((data.workspaces ?? []) as Record<string, unknown>[]).find(w => w.id === workspaceId);
  if (!raw) throw new Error('That workspace is no longer available.');
  return { keys: openKeys(raw.keys, identity), skeys: openKeys(raw.skeys, identity) };
}

function wipeRing(ring: { keys: Map<number, Uint8Array>; skeys: Map<number, Uint8Array> }): void {
  for (const k of [...ring.keys.values(), ...ring.skeys.values()]) wipe(k);
}

const b64Keys = (keys: Map<number, Uint8Array>) => Object.fromEntries([...keys].map(([k, key]) => [String(k), toB64(key)]));

function sealAll(keys: Map<number, Uint8Array>, publicKey: Uint8Array): Record<string, string> {
  return Object.fromEntries([...keys].map(([k, key]) => [String(k), sealTo(publicKey, key)]));
}

export async function createWorkspace(name: string): Promise<string> {
  const identity = (await ensureIdentity()) ?? requireIdentity();
  const id = crypto.randomUUID();
  const key = randomKey();
  try {
    await api.workspace({ action: 'create', workspaceId: id, meta: sealName(key, 1, id, name), keys: { 1: sealTo(identity.publicKey, key) } });
  } finally {
    wipe(key);
  }
  await refresh();
  return id;
}

export async function renameWorkspace(workspaceId: string, name: string): Promise<void> {
  const ws = workspaces.get(workspaceId);
  if (!ws) throw new Error('That workspace is no longer available.');
  const ring = await keyring(workspaceId);
  try {
    await api.workspace({ action: 'rename', workspaceId, meta: sealName(ring.keys.get(ws.epoch)!, ws.epoch, workspaceId, name) });
  } finally {
    wipeRing(ring);
  }
  await refresh();
}

export async function inviteByUsername(workspaceId: string, username: string, role: Role): Promise<void> {
  const { publicKey } = await api.workspace({ action: 'publicKey', username });
  if (typeof publicKey !== 'string') throw new Error('That account has no workspace key yet.');
  const ring = await keyring(workspaceId);
  try {
    const to = fromB64(publicKey);
    // Editors also get the secrets keys (when secret fields are hidden from viewers); viewers never do.
    const skeys = role !== 'viewer' && ring.skeys.size ? { skeys: sealAll(ring.skeys, to) } : {};
    await api.workspace({ action: 'invite', workspaceId, inviteId: crypto.randomUUID(), username, role, keys: sealAll(ring.keys, to), ...skeys });
  } finally {
    wipeRing(ring);
  }
  await refresh();
}

/** Creates a single-use invite link (valid 7 days). The secret after # never reaches the server. */
export async function createInviteLink(workspaceId: string, role: Role, origin: string): Promise<string> {
  const ring = await keyring(workspaceId);
  const secret = randomBytes(32);
  const inviteId = crypto.randomUUID();
  const linkKey = deriveSubkey(secret, LINK_KEY);
  const auth = deriveSubkey(secret, LINK_AUTH);
  try {
    const secrets = role !== 'viewer' && ring.skeys.size ? { skeys: b64Keys(ring.skeys) } : {};
    const payload = seal(linkKey, JSON.stringify({ keys: b64Keys(ring.keys), ...secrets }), inviteAad(inviteId));
    await api.workspace({ action: 'inviteLink', workspaceId, inviteId, role, payload, auth: toB64(auth) });
  } finally {
    wipeRing(ring);
    wipe(linkKey);
    wipe(auth);
  }
  await refresh();
  return `${origin}/#join=${inviteId}.${toB64(secret)}`;
}

export async function revokeInvite(inviteId: string): Promise<void> {
  await api.workspace({ action: 'revokeInvite', inviteId });
  await refresh();
}

export async function setRole(workspaceId: string, accountId: string, role: Role): Promise<void> {
  const ws = workspaces.get(workspaceId);
  if (!ws) throw new Error('That workspace is no longer available.');
  const target = ws.members.find(m => m.accountId === accountId);
  const hidden = !ws.viewerSecrets;
  let skeys: Record<string, string> | null = null;
  if (hidden && role !== 'viewer' && target?.role === 'viewer') {
    // Promoted from viewer while secret fields are hidden from viewers: they now get the secrets keys.
    if (!target.publicKey) throw new Error(`${target.username} has no workspace key yet.`);
    const ring = await keyring(workspaceId);
    try { skeys = sealAll(ring.skeys, fromB64(target.publicKey)); } finally { wipeRing(ring); }
  }
  await api.workspace({ action: 'setRole', workspaceId, accountId, role, ...(skeys ? { skeys } : {}) });
  await refresh();
  // A new viewer held the secrets key: it is replaced, so secrets saved from now on are hidden from them.
  if (hidden && role === 'viewer' && target && target.role !== 'viewer') await rotate(workspaceId, {});
}

/** Removes a member and replaces the workspace key, so they cannot read anything written later. */
export async function removeMember(workspaceId: string, accountId: string): Promise<void> {
  await rotate(workspaceId, { remove: accountId });
}

/**
 * Lets viewers read secret fields (passwords, secret notes, 2FA keys), or stops them. The workspace
 * gets a new key (and, when hidden, a secrets key only owners and editors receive); then every page
 * is saved again under the new rule, so the server's copies follow it too. Returns the pages resaved.
 */
export async function setViewerSecrets(workspaceId: string, allowed: boolean): Promise<number> {
  const ws = workspaces.get(workspaceId);
  if (!ws) throw new Error('That workspace is no longer available.');
  if (ws.viewerSecrets === allowed) return 0;
  await rotate(workspaceId, { viewerSecrets: allowed });
  const count = store.resealSpace(workspaceId);
  await syncWorkspaces();
  return count;
}

/**
 * A new workspace key number: sealed to every remaining member, with a new secrets key for owners
 * and editors when viewers may not read secret fields. `remove`: a member to take out at the same time.
 */
async function rotate(workspaceId: string, opts: { remove?: string; viewerSecrets?: boolean }): Promise<void> {
  const ws = workspaces.get(workspaceId);
  if (!ws) throw new Error('That workspace is no longer available.');
  const viewerSecrets = opts.viewerSecrets ?? ws.viewerSecrets;
  const remaining = ws.members.filter(m => m.accountId !== opts.remove);
  const epoch = ws.epoch + 1;
  const key = randomKey();
  const skey = viewerSecrets ? null : randomKey();
  try {
    const keys: Record<string, string> = {};
    const skeys: Record<string, string> = {};
    for (const m of remaining) {
      if (!m.publicKey) throw new Error(`${m.username} has no workspace key; remove them too or try again later.`);
      const to = fromB64(m.publicKey);
      keys[m.accountId] = sealTo(to, key);
      if (skey && m.role !== 'viewer') skeys[m.accountId] = sealTo(to, skey);
    }
    await api.workspace({
      action: opts.remove ? 'remove' : 'secrets', workspaceId, accountId: opts.remove, epoch,
      meta: sealName(key, epoch, workspaceId, ws.name), keys, skeys, viewerSecrets,
    });
  } finally {
    wipe(key);
    if (skey) wipe(skey);
  }
  await refresh();
}

export async function leaveWorkspace(workspaceId: string): Promise<void> {
  await api.workspace({ action: 'leave', workspaceId });
  store.dropSpace(workspaceId);
  await refresh();
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  await api.workspace({ action: 'delete', workspaceId });
  store.dropSpace(workspaceId);
  await refresh();
}

// ---- Joining ----

export async function acceptInvitation(inviteId: string): Promise<string> {
  await ensureIdentity();
  const { workspaceId } = await api.workspace({ action: 'accept', inviteId });
  await refresh();
  return String(workspaceId);
}

export async function declineInvitation(inviteId: string): Promise<void> {
  await api.workspace({ action: 'decline', inviteId });
  await refresh();
}

export interface InviteLink { inviteId: string; secret: Uint8Array }

/** Reads "#join=<inviteId>.<secret>" (or a pasted full link). */
export function parseInviteLink(text: string): InviteLink | null {
  const m = /join=([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})/.exec(text);
  if (!m) return null;
  try { return { inviteId: m[1]!, secret: fromB64(m[2]!) }; } catch { return null; }
}

export interface LinkPreview { workspaceId: string; name: string; role: Role; from: string; alreadyMember: boolean }

/** What an invite link leads to, without joining yet. */
export async function previewInviteLink(link: InviteLink): Promise<LinkPreview> {
  const auth = deriveSubkey(link.secret, LINK_AUTH);
  try {
    const data = await api.workspace({ action: 'peekLink', inviteId: link.inviteId, auth: toB64(auth) });
    const ring = openLinkKeys(link, data.payload as Sealed);
    const name = openName(ring.keys, String(data.workspaceId), data.meta as WorkspaceMeta);
    wipeRing(ring);
    return { workspaceId: String(data.workspaceId), name, role: data.role as Role, from: String(data.from ?? ''), alreadyMember: data.alreadyMember === true };
  } finally {
    wipe(auth);
  }
}

function openLinkKeys(link: InviteLink, payload: Sealed): { keys: Map<number, Uint8Array>; skeys: Map<number, Uint8Array> } {
  const linkKey = deriveSubkey(link.secret, LINK_KEY);
  try {
    const raw = JSON.parse(openString(linkKey, payload, inviteAad(link.inviteId))) as { keys?: Record<string, string>; skeys?: Record<string, string> };
    const read = (m?: Record<string, string>) => new Map(Object.entries(m ?? {}).map(([k, v]) => [Number(k), fromB64(v)]));
    return { keys: read(raw.keys), skeys: read(raw.skeys) };
  } catch {
    throw new Error('This invite link is damaged. Ask for a new one.');
  } finally {
    wipe(linkKey);
  }
}

/** Joins with an invite link: the keys are re-sealed to this account's own public key. */
export async function joinWithLink(link: InviteLink): Promise<string> {
  const identity = (await ensureIdentity()) ?? requireIdentity();
  const auth = deriveSubkey(link.secret, LINK_AUTH);
  try {
    const data = await api.workspace({ action: 'peekLink', inviteId: link.inviteId, auth: toB64(auth) });
    const ring = openLinkKeys(link, data.payload as Sealed);
    try {
      const skeys = ring.skeys.size ? { skeys: sealAll(ring.skeys, identity.publicKey) } : {};
      const { workspaceId } = await api.workspace({ action: 'accept', inviteId: link.inviteId, auth: toB64(auth), keys: sealAll(ring.keys, identity.publicKey), ...skeys });
      await refresh();
      return String(workspaceId);
    } finally {
      wipeRing(ring);
    }
  } finally {
    wipe(auth);
  }
}

// ---- Sync ----

const since = new Map<string, number>();
const OVERLAP = 100;
const PUSH_BUDGET = 3_000_000;
/** When each workspace was last pulled. */
const lastPull = new Map<string, number>();

/**
 * Pushes and pulls the workspaces' pages (sync.ts calls it after the personal vault). With
 * `idleToo: false`, a workspace with nothing to send is only pulled when its last pull is 15 s old.
 */
export async function syncWorkspaces(opts: { idleToo?: boolean } = {}): Promise<{ unreadable: number }> {
  let unreadable = 0;
  await store.flush();
  for (const id of store.workspaceIds()) {
    const ws = workspaces.get(id);
    if (!ws) continue;
    const outgoing = ws.role === 'viewer' ? [] : store.outgoing(id);
    if (!outgoing.length && opts.idleToo === false && Date.now() - (lastPull.get(id) ?? 0) < POLL_EVERY) continue;
    // Like the personal vault: large pushes go in requests of about 3 MB (the host accepts 4.5 MB);
    // the early ones only push, the last one also pulls.
    const batches = batchBySize(outgoing, PUSH_BUDGET);
    const sent = batches.pop() ?? [];
    let res;
    try {
      for (const batch of batches) {
        await api.wsync({ workspaceId: id, since: Number.MAX_SAFE_INTEGER, notes: batch });
        store.confirmSent(batch);
      }
      res = await api.wsync({ workspaceId: id, since: Math.max(0, (since.get(id) ?? 0) - OVERLAP), notes: sent });
    } catch (err) {
      // 409: the key was replaced (a member was removed); 403: now a viewer; 404: removed. The new
      // list re-seals unsent edits with the new key (or drops them) and the next round retries.
      if (err instanceof ApiError && (err.status === 409 || err.status === 403 || err.status === 404)) { await refresh(); continue; }
      throw err;
    }
    store.confirmSent(sent);
    lastPull.set(id, Date.now());
    for (;;) {
      unreadable += store.applyEnvelopes(res.notes, false, id).failed;
      since.set(id, Math.max(since.get(id) ?? 0, res.rev));
      if (!res.more) break;
      res = await api.wsync({ workspaceId: id, since: since.get(id)!, notes: [] });
    }
    if (kept.has(id)) keepInFile(id);
    if (res.epoch !== ws.epoch) await refresh(); // the key was replaced meanwhile
  }
  return { unreadable };
}

export function resetSync(): void {
  since.clear();
  lastPull.clear();
  published = null;
}
