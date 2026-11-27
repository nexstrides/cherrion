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
}
export interface Invitation { id: string; workspaceId: string; name: string; role: Role; from: string }

interface WorkspaceMeta extends Sealed { k: number }

let workspaces = new Map<string, Workspace>();
let invitations: Invitation[] = [];
/** Invitations' sealed keys (kept to accept them). */
const invitationKeys = new Map<string, Record<string, string>>();
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
  await refresh();
  return syncWorkspaces();
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
  const next = new Map<string, Workspace>();
  for (const raw of (Array.isArray(data.workspaces) ? data.workspaces : []) as Record<string, unknown>[]) {
    const id = String(raw.id);
    const keys = new Map<number, Uint8Array>();
    for (const [k, sealed] of Object.entries((raw.keys ?? {}) as Record<string, string>)) {
      try { keys.set(Number(k), openSealedBox(sealed, identity)); } catch { /* not for us */ }
    }
    const epoch = Number(raw.epoch);
    if (!keys.has(epoch)) continue; // cannot read or write this workspace yet
    const role = raw.role as Role;
    const name = openName(keys, id, raw.meta as WorkspaceMeta);
    store.setSpace(id, keys, epoch, role === 'viewer');
    next.set(id, {
      id, name, role, epoch,
      members: (Array.isArray(raw.members) ? raw.members : []) as Member[],
      invites: (Array.isArray(raw.invites) ? raw.invites : []) as PendingInvite[],
    });
  }
  for (const id of workspaces.keys()) if (!next.has(id)) store.dropSpace(id);
  workspaces = next;

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
  changed();
}

/** Forgets everything (logging out, locking, or unlinking a desktop file): workspace pages included. */
export function reset(): void {
  for (const id of store.workspaceIds()) store.dropSpace(id);
  workspaces = new Map();
  invitations = [];
  invitationKeys.clear();
  changed();
}

// ---- Owner actions ----

function requireIdentity(): BoxKeyPair {
  const identity = store.getIdentity();
  if (!identity) throw new Error('Workspaces are not set up yet. Check your connection and try again.');
  return identity;
}

/** The workspace's keys (from the store's copy, via a fresh unseal). */
async function keysOf(workspaceId: string): Promise<Map<number, Uint8Array>> {
  const identity = requireIdentity();
  const data = await api.workspace({ action: 'list' });
  const raw = ((data.workspaces ?? []) as Record<string, unknown>[]).find(w => w.id === workspaceId);
  if (!raw) throw new Error('That workspace is no longer available.');
  const keys = new Map<number, Uint8Array>();
  for (const [k, sealed] of Object.entries((raw.keys ?? {}) as Record<string, string>)) keys.set(Number(k), openSealedBox(sealed, identity));
  return keys;
}

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
  const keys = await keysOf(workspaceId);
  try {
    await api.workspace({ action: 'rename', workspaceId, meta: sealName(keys.get(ws.epoch)!, ws.epoch, workspaceId, name) });
  } finally {
    for (const k of keys.values()) wipe(k);
  }
  await refresh();
}

export async function inviteByUsername(workspaceId: string, username: string, role: Role): Promise<void> {
  const { publicKey } = await api.workspace({ action: 'publicKey', username });
  if (typeof publicKey !== 'string') throw new Error('That account has no workspace key yet.');
  const keys = await keysOf(workspaceId);
  try {
    await api.workspace({ action: 'invite', workspaceId, inviteId: crypto.randomUUID(), username, role, keys: sealAll(keys, fromB64(publicKey)) });
  } finally {
    for (const k of keys.values()) wipe(k);
  }
  await refresh();
}

/** Creates a single-use invite link (valid 7 days). The secret after # never reaches the server. */
export async function createInviteLink(workspaceId: string, role: Role, origin: string): Promise<string> {
  const keys = await keysOf(workspaceId);
  const secret = randomBytes(32);
  const inviteId = crypto.randomUUID();
  const linkKey = deriveSubkey(secret, LINK_KEY);
  const auth = deriveSubkey(secret, LINK_AUTH);
  try {
    const payload = seal(linkKey, JSON.stringify({ keys: Object.fromEntries([...keys].map(([k, key]) => [String(k), toB64(key)])) }), inviteAad(inviteId));
    await api.workspace({ action: 'inviteLink', workspaceId, inviteId, role, payload, auth: toB64(auth) });
  } finally {
    for (const k of keys.values()) wipe(k);
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
  await api.workspace({ action: 'setRole', workspaceId, accountId, role });
  await refresh();
}

/** Removes a member and replaces the workspace key, so they cannot read anything written later. */
export async function removeMember(workspaceId: string, accountId: string): Promise<void> {
  const ws = workspaces.get(workspaceId);
  if (!ws) throw new Error('That workspace is no longer available.');
  const remaining = ws.members.filter(m => m.accountId !== accountId);
  const epoch = ws.epoch + 1;
  const key = randomKey();
  try {
    const keys: Record<string, string> = {};
    for (const m of remaining) {
      if (!m.publicKey) throw new Error(`${m.username} has no workspace key; remove them too or try again later.`);
      keys[m.accountId] = sealTo(fromB64(m.publicKey), key);
    }
    await api.workspace({ action: 'remove', workspaceId, accountId, epoch, meta: sealName(key, epoch, workspaceId, ws.name), keys });
  } finally {
    wipe(key);
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
    const keys = openLinkKeys(link, data.payload as Sealed);
    const name = openName(keys, String(data.workspaceId), data.meta as WorkspaceMeta);
    for (const k of keys.values()) wipe(k);
    return { workspaceId: String(data.workspaceId), name, role: data.role as Role, from: String(data.from ?? ''), alreadyMember: data.alreadyMember === true };
  } finally {
    wipe(auth);
  }
}

function openLinkKeys(link: InviteLink, payload: Sealed): Map<number, Uint8Array> {
  const linkKey = deriveSubkey(link.secret, LINK_KEY);
  try {
    const raw = JSON.parse(openString(linkKey, payload, inviteAad(link.inviteId))) as { keys?: Record<string, string> };
    return new Map(Object.entries(raw.keys ?? {}).map(([k, v]) => [Number(k), fromB64(v)]));
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
    const keys = openLinkKeys(link, data.payload as Sealed);
    try {
      const { workspaceId } = await api.workspace({ action: 'accept', inviteId: link.inviteId, auth: toB64(auth), keys: sealAll(keys, identity.publicKey) });
      await refresh();
      return String(workspaceId);
    } finally {
      for (const k of keys.values()) wipe(k);
    }
  } finally {
    wipe(auth);
  }
}

// ---- Sync ----

const since = new Map<string, number>();
const OVERLAP = 100;

/** Pushes and pulls every workspace's pages (called by sync.ts after the personal vault). */
export async function syncWorkspaces(): Promise<{ unreadable: number }> {
  let unreadable = 0;
  for (const id of store.workspaceIds()) {
    const ws = workspaces.get(id);
    if (!ws) continue;
    await store.flush();
    const sent = ws.role === 'viewer' ? [] : store.outgoing(id);
    let res;
    try {
      res = await api.wsync({ workspaceId: id, since: Math.max(0, (since.get(id) ?? 0) - OVERLAP), notes: sent });
    } catch (err) {
      // 409: the key was replaced (a member was removed); 403: now a viewer; 404: removed. The new
      // list re-seals unsent edits with the new key (or drops them) and the next round retries.
      if (err instanceof ApiError && (err.status === 409 || err.status === 403 || err.status === 404)) { await refresh(); continue; }
      throw err;
    }
    store.confirmSent(sent);
    for (;;) {
      unreadable += store.applyEnvelopes(res.notes, false, id).failed;
      since.set(id, Math.max(since.get(id) ?? 0, res.rev));
      if (!res.more) break;
      res = await api.wsync({ workspaceId: id, since: since.get(id)!, notes: [] });
    }
    if (res.epoch !== ws.epoch) await refresh(); // the key was replaced meanwhile
  }
  return { unreadable };
}

export function resetSync(): void {
  since.clear();
  published = null;
}
