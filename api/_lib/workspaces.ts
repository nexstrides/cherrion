// Shared workspaces, server side. Zero-knowledge like the rest of the API: the server stores each
// workspace's encrypted name, its pages as encrypted envelopes, and copies of the workspace key that
// are sealed to members' public keys (or, for invite links, encrypted with a key only the link holds).
// It checks who may do what (owner / editor / viewer) but can never read a workspace.
//
// Secret fields and viewers: when a workspace's owner turns viewers' access to secret fields off,
// each key number also gets a separate *secrets key*. Secret field values (passwords, secret notes,
// 2FA keys) are sealed with it inside the pages, and only owners and editors get it (`skeys`), so
// viewers cannot read them, not even with the workspace key.
import { createHash, timingSafeEqual } from 'node:crypto';
import { isEnvelope, isSealed } from '../../src/shapes.js';
import type { Sealed } from '../../src/crypto.js';
import type { Envelope } from '../../src/envelope.js';
import { HttpError, normalizeUsername, RESPONSE_BUDGET, type Repo } from './core.js';

export type Role = 'owner' | 'editor' | 'viewer';
const ROLES: Role[] = ['owner', 'editor', 'viewer'];

/** Workspace key number -> that key, sealed (base64url) to one member's public key. */
export type SealedKeys = Record<string, string>;
/** The workspace name, encrypted with workspace key number `k`. */
export interface WorkspaceMeta extends Sealed { k: number }

/** `viewerSecrets`: false when viewers may not read secret fields (see the note above). */
export interface Workspace { id: string; meta: WorkspaceMeta; epoch: number; createdBy: string; viewerSecrets: boolean }
/** `skeys`: secrets keys by key number, sealed to this member (owners and editors only). */
export interface Member { workspaceId: string; accountId: string; role: Role; keys: SealedKeys; skeys: SealedKeys }
export interface Invite {
  id: string;
  workspaceId: string;
  role: Role;
  /** Username invites: the account invited (its keys are sealed to it). Link invites: null. */
  inviteeId: string | null;
  /** Username invites: SealedKeys. Link invites: the keys encrypted with the link's key (Sealed). */
  payload: SealedKeys | Sealed;
  /** Link invites: SHA-256 of the proof derived from the link secret. */
  authHash: string | null;
  /** Username invites as editor while secrets are hidden from viewers: the secrets keys. */
  skeys: SealedKeys | null;
  createdBy: string;
  expiresAt: number;
}

export interface WorkspaceRepo {
  /** Sets the account's public key unless it already has one; returns the key now stored. */
  setPublicKey(accountId: string, publicKey: string): Promise<string>;
  createWorkspace(ws: Workspace, owner: Member): Promise<void>;
  getWorkspace(id: string): Promise<Workspace | null>;
  updateWorkspace(id: string, fields: { meta?: WorkspaceMeta; epoch?: number; viewerSecrets?: boolean }): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;
  workspacesOf(accountId: string): Promise<{ workspace: Workspace; member: Member }[]>;
  members(workspaceId: string): Promise<(Member & { username: string; publicKey: string | null })[]>;
  getMember(workspaceId: string, accountId: string): Promise<Member | null>;
  putMember(member: Member): Promise<void>;
  removeMember(workspaceId: string, accountId: string): Promise<void>;
  createInvite(invite: Invite): Promise<void>;
  getInvite(id: string): Promise<Invite | null>;
  deleteInvite(id: string): Promise<void>;
  invitesFor(accountId: string): Promise<Invite[]>;
  invitesOf(workspaceId: string): Promise<Invite[]>;
  putWorkspaceNotes(workspaceId: string, notes: Envelope[], authorId: string): Promise<void>;
  workspaceNotesSince(workspaceId: string, since: number, limit: number): Promise<{ notes: Envelope[]; revs: number[] }>;
}

const INVITE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MEMBERS = 50;
const PAGE = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY32 = /^[A-Za-z0-9_-]{43}$/;
const SEALED_KEY = /^[A-Za-z0-9_-]{60,120}$/; // crypto_box_seal of 32 bytes = 80 bytes -> 107 chars

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const obj = (body: unknown): Record<string, unknown> =>
  (typeof body === 'object' && body !== null ? body as Record<string, unknown> : {});

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function uuid(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, `Missing or malformed ${what}.`);
  return value;
}

function role(value: unknown): Role {
  if (!ROLES.includes(value as Role)) throw new HttpError(400, 'Role must be owner, editor or viewer.');
  return value as Role;
}

function meta(value: unknown): WorkspaceMeta {
  const k = (value as { k?: unknown } | null)?.k;
  if (!isSealed(value) || typeof k !== 'number' || !Number.isInteger(k) || k < 1 || value.ct.length > 4000) {
    throw new HttpError(400, 'Malformed workspace name.');
  }
  return { k, nonce: value.nonce, ct: value.ct };
}

function sealedKeys(value: unknown): SealedKeys {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'Malformed workspace keys.');
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 1000) throw new HttpError(400, 'Malformed workspace keys.');
  for (const [k, v] of entries) {
    if (!/^[1-9][0-9]{0,6}$/.test(k) || typeof v !== 'string' || !SEALED_KEY.test(v)) throw new HttpError(400, 'Malformed workspace keys.');
  }
  return value as SealedKeys;
}

/** Secrets keys: like sealedKeys, but may be absent or empty. */
function secretKeys(value: unknown): SealedKeys {
  if (value === undefined || value === null) return {};
  if (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) return {};
  return sealedKeys(value);
}

const MISSING_SECRETS = 'Secret fields in this workspace are hidden from viewers, so editors and owners need the secrets key. Refresh and try again.';

/** The caller's membership, or 404 (members of other workspaces cannot tell whether it exists). */
async function membership(repo: Repo, accountId: string, workspaceId: string): Promise<{ ws: Workspace; me: Member }> {
  const ws = await repo.getWorkspace(workspaceId);
  const me = ws ? await repo.getMember(workspaceId, accountId) : null;
  if (!ws || !me) throw new HttpError(404, 'That workspace does not exist, or you are not a member.');
  return { ws, me };
}

async function asOwner(repo: Repo, accountId: string, workspaceId: string) {
  const m = await membership(repo, accountId, workspaceId);
  if (m.me.role !== 'owner') throw new HttpError(403, 'Only owners can do that.');
  return m;
}

const publicInvite = (i: Invite, username: string | null) => ({
  id: i.id, role: i.role, username, link: i.inviteeId === null, expiresAt: i.expiresAt,
});

// ---- Actions (POST /api/workspace with { action, ... }) ----

export async function workspaceAction(repo: Repo, accountId: string, body: unknown): Promise<unknown> {
  const b = obj(body);
  switch (b.action) {
    case 'identity': {
      // Publish the account's public key (once; it never changes, or sealed keys would break). It is
      // taken from the stored vault header, so it is only published once the matching private key
      // (encrypted in that header) is safely on the server. Returns null until then.
      const account = await repo.findAccountById(accountId);
      if (!account) throw new HttpError(401, 'Please log in.');
      if (account.publicKey) return { publicKey: account.publicKey };
      const fromHeader = account.header.identity?.publicKey;
      if (!fromHeader || !KEY32.test(fromHeader)) return { publicKey: null };
      return { publicKey: await repo.setPublicKey(accountId, fromHeader) };
    }

    case 'list': {
      const now = Date.now();
      const mine = await repo.workspacesOf(accountId);
      const workspaces = await Promise.all(mine.map(async ({ workspace, member }) => {
        const members = await repo.members(workspace.id);
        const invites = member.role === 'owner'
          ? await Promise.all((await repo.invitesOf(workspace.id)).filter(i => i.expiresAt > now).map(async i =>
            publicInvite(i, i.inviteeId ? (await repo.findAccountById(i.inviteeId))?.username ?? null : null)))
          : [];
        return {
          id: workspace.id, meta: workspace.meta, epoch: workspace.epoch, role: member.role, keys: member.keys,
          skeys: member.skeys, viewerSecrets: workspace.viewerSecrets,
          members: members.map(m => ({ accountId: m.accountId, username: m.username, role: m.role, publicKey: m.publicKey })),
          invites,
        };
      }));
      const invitations = await Promise.all((await repo.invitesFor(accountId)).filter(i => i.expiresAt > now).map(async i => {
        const ws = await repo.getWorkspace(i.workspaceId);
        const from = await repo.findAccountById(i.createdBy);
        return ws ? { id: i.id, workspaceId: ws.id, meta: ws.meta, role: i.role, from: from?.username ?? '', keys: i.payload, skeys: i.skeys ?? {} } : null;
      }));
      return { workspaces, invitations: invitations.filter(Boolean) };
    }

    case 'publicKey': {
      const username = normalizeUsername(b.username);
      const account = await repo.findAccount(username);
      if (!account || !account.publicKey) {
        throw new HttpError(404, 'No account with that username has set up workspaces yet. They need to log in once with the current version.');
      }
      return { accountId: account.id, username: account.username, publicKey: account.publicKey };
    }

    case 'create': {
      const id = uuid(b.workspaceId, 'workspace id');
      if (await repo.getWorkspace(id)) throw new HttpError(409, 'That workspace already exists.');
      if ((await repo.workspacesOf(accountId)).length >= 100) throw new HttpError(400, 'You are in too many workspaces.');
      await repo.createWorkspace({ id, meta: meta(b.meta), epoch: 1, createdBy: accountId, viewerSecrets: true },
        { workspaceId: id, accountId, role: 'owner', keys: sealedKeys(b.keys), skeys: {} });
      return { ok: true };
    }

    case 'rename': {
      const { ws } = await asOwner(repo, accountId, uuid(b.workspaceId, 'workspace id'));
      await repo.updateWorkspace(ws.id, { meta: meta(b.meta) });
      return { ok: true };
    }

    case 'invite': {
      // By username: the inviter sealed every workspace key to the invitee's public key.
      const { ws } = await asOwner(repo, accountId, uuid(b.workspaceId, 'workspace id'));
      const invitee = await repo.findAccount(normalizeUsername(b.username));
      if (!invitee || !invitee.publicKey) throw new HttpError(404, 'No account with that username has set up workspaces yet.');
      if (await repo.getMember(ws.id, invitee.id)) throw new HttpError(409, `${invitee.username} is already a member.`);
      if ((await repo.members(ws.id)).length >= MAX_MEMBERS) throw new HttpError(400, `A workspace can have up to ${MAX_MEMBERS} members.`);
      const r = role(b.role);
      if (r === 'owner') throw new HttpError(400, 'Invite as editor or viewer; you can make someone an owner afterwards.');
      // Viewers never get the secrets keys; editors must, while secrets are hidden from viewers.
      const skeys = r === 'viewer' ? {} : secretKeys(b.skeys);
      if (!ws.viewerSecrets && r !== 'viewer' && !skeys[ws.epoch]) throw new HttpError(400, MISSING_SECRETS);
      for (const old of await repo.invitesOf(ws.id)) if (old.inviteeId === invitee.id) await repo.deleteInvite(old.id);
      const invite: Invite = {
        id: uuid(b.inviteId, 'invite id'), workspaceId: ws.id, role: r, inviteeId: invitee.id,
        payload: sealedKeys(b.keys), authHash: null, createdBy: accountId, expiresAt: Date.now() + INVITE_MS,
        skeys: Object.keys(skeys).length ? skeys : null,
      };
      await repo.createInvite(invite);
      return { ok: true };
    }

    case 'inviteLink': {
      // By link: the keys are encrypted with a key derived from a secret that only the link holds
      // (it stays after the # and never reaches the server). The server keeps a hash of a separate
      // proof derived from the same secret, to check who may accept.
      const { ws } = await asOwner(repo, accountId, uuid(b.workspaceId, 'workspace id'));
      const r = role(b.role);
      if (r === 'owner') throw new HttpError(400, 'Invite as editor or viewer; you can make someone an owner afterwards.');
      if (!isSealed(b.payload) || (b.payload as Sealed).ct.length > 20000) throw new HttpError(400, 'Malformed invite.');
      if (typeof b.auth !== 'string' || !KEY32.test(b.auth)) throw new HttpError(400, 'Malformed invite.');
      await repo.createInvite({
        id: uuid(b.inviteId, 'invite id'), workspaceId: ws.id, role: r, inviteeId: null,
        payload: { nonce: (b.payload as Sealed).nonce, ct: (b.payload as Sealed).ct }, authHash: sha256(b.auth),
        createdBy: accountId, expiresAt: Date.now() + INVITE_MS, skeys: null, // a link's secrets keys are in its payload
      });
      return { ok: true };
    }

    case 'peekLink': {
      // What an invite link leads to (the invitee decrypts the name and keys with the link secret).
      const invite = await linkInvite(repo, b);
      const ws = await repo.getWorkspace(invite.workspaceId);
      if (!ws) throw new HttpError(404, 'This invite link is no longer valid.');
      const from = await repo.findAccountById(invite.createdBy);
      return { workspaceId: ws.id, meta: ws.meta, role: invite.role, from: from?.username ?? '', payload: invite.payload, alreadyMember: !!(await repo.getMember(ws.id, accountId)) };
    }

    case 'accept': {
      const inviteId = uuid(b.inviteId, 'invite id');
      const invite = b.auth !== undefined ? await linkInvite(repo, b) : await repo.getInvite(inviteId);
      if (!invite || invite.expiresAt <= Date.now()) throw new HttpError(404, 'This invitation is no longer valid.');
      if (invite.inviteeId !== null && invite.inviteeId !== accountId) throw new HttpError(404, 'This invitation is no longer valid.');
      const ws = await repo.getWorkspace(invite.workspaceId);
      if (!ws) throw new HttpError(404, 'That workspace no longer exists.');
      // A link invite carries no keys for this account: the joiner sealed them to itself.
      const keys = invite.inviteeId === null ? sealedKeys(b.keys) : invite.payload as SealedKeys;
      const skeys = invite.role === 'viewer' ? {} : invite.inviteeId === null ? secretKeys(b.skeys) : invite.skeys ?? {};
      if (!ws.viewerSecrets && invite.role !== 'viewer' && !skeys[ws.epoch]) {
        throw new HttpError(400, 'This invitation is from before a change to the workspace. Ask for a new one.');
      }
      if (!(await repo.getMember(ws.id, accountId))) {
        if ((await repo.members(ws.id)).length >= MAX_MEMBERS) throw new HttpError(400, `A workspace can have up to ${MAX_MEMBERS} members.`);
        await repo.putMember({ workspaceId: ws.id, accountId, role: invite.role, keys, skeys });
      }
      await repo.deleteInvite(invite.id); // single use
      return { workspaceId: ws.id };
    }

    case 'decline': {
      const invite = await repo.getInvite(uuid(b.inviteId, 'invite id'));
      if (invite && invite.inviteeId === accountId) await repo.deleteInvite(invite.id);
      return { ok: true };
    }

    case 'revokeInvite': {
      const invite = await repo.getInvite(uuid(b.inviteId, 'invite id'));
      if (invite) {
        await asOwner(repo, accountId, invite.workspaceId);
        await repo.deleteInvite(invite.id);
      }
      return { ok: true };
    }

    case 'setRole': {
      const { ws } = await asOwner(repo, accountId, uuid(b.workspaceId, 'workspace id'));
      const target = await repo.getMember(ws.id, String(b.accountId ?? ''));
      if (!target) throw new HttpError(404, 'That person is not a member.');
      const r = role(b.role);
      if (target.role === 'owner' && r !== 'owner') await keepAnOwner(repo, ws.id, target.accountId);
      // A viewer's secrets keys are dropped (the owner's app then replaces the keys, see 'secrets');
      // someone promoted from viewer gets them, while secrets are hidden from viewers.
      let skeys = target.skeys ?? {};
      if (r === 'viewer') skeys = {};
      else if (!ws.viewerSecrets && !skeys[ws.epoch]) {
        skeys = { ...skeys, ...secretKeys(b.skeys) };
        if (!skeys[ws.epoch]) throw new HttpError(400, MISSING_SECRETS);
      }
      await repo.putMember({ ...target, role: r, skeys });
      return { ok: true };
    }

    case 'remove': {
      // Removing someone replaces the workspace key: the owner sends the new key number, the name
      // re-encrypted with it, and the new key sealed to every remaining member.
      const { ws } = await asOwner(repo, accountId, uuid(b.workspaceId, 'workspace id'));
      const target = await repo.getMember(ws.id, String(b.accountId ?? ''));
      if (!target) throw new HttpError(404, 'That person is not a member.');
      if (target.role === 'owner') await keepAnOwner(repo, ws.id, target.accountId);
      await rotate(repo, ws, b, [target.accountId], ws.viewerSecrets);
      return { ok: true };
    }

    case 'secrets': {
      // Lets viewers read secret fields, or stops them: either way the workspace gets a new key
      // number (with a secrets key for owners and editors when hidden), and the owner's app then
      // seals every page again under the new rule.
      const { ws } = await asOwner(repo, accountId, uuid(b.workspaceId, 'workspace id'));
      if (typeof b.viewerSecrets !== 'boolean') throw new HttpError(400, 'Say whether viewers may see secret fields.');
      await rotate(repo, ws, b, [], b.viewerSecrets);
      return { ok: true };
    }

    case 'leave': {
      const { ws, me } = await membership(repo, accountId, uuid(b.workspaceId, 'workspace id'));
      if (me.role === 'owner') await keepAnOwner(repo, ws.id, accountId);
      await repo.removeMember(ws.id, accountId);
      return { ok: true };
    }

    case 'delete': {
      const { ws } = await asOwner(repo, accountId, uuid(b.workspaceId, 'workspace id'));
      await repo.deleteWorkspace(ws.id);
      return { ok: true };
    }

    default:
      throw new HttpError(400, 'Unknown workspace action.');
  }
}

async function linkInvite(repo: Repo, b: Record<string, unknown>): Promise<Invite> {
  const invite = await repo.getInvite(uuid(b.inviteId, 'invite id'));
  if (!invite || invite.inviteeId !== null || !invite.authHash || invite.expiresAt <= Date.now()
    || typeof b.auth !== 'string' || !sameHash(sha256(b.auth), invite.authHash)) {
    throw new HttpError(404, 'This invite link is no longer valid. Ask for a new one.');
  }
  return invite;
}

async function keepAnOwner(repo: Repo, workspaceId: string, leavingId: string): Promise<void> {
  const owners = (await repo.members(workspaceId)).filter(m => m.role === 'owner' && m.accountId !== leavingId);
  if (!owners.length) throw new HttpError(400, 'A workspace needs at least one owner. Make someone else an owner first, or delete the workspace.');
}

/**
 * New workspace key number `epoch`: removes `removed`, adds the new sealed key for everyone else and,
 * when viewers may not see secret fields, the new secrets key for owners and editors.
 */
async function rotate(repo: Repo, ws: Workspace, b: Record<string, unknown>, removed: string[], viewerSecrets: boolean): Promise<void> {
  const epoch = b.epoch;
  if (epoch !== ws.epoch + 1) throw new HttpError(409, 'The workspace key changed meanwhile. Please try again.');
  const newKeys = b.keys;
  if (typeof newKeys !== 'object' || newKeys === null) throw new HttpError(400, 'Malformed workspace keys.');
  const remaining = (await repo.members(ws.id)).filter(m => !removed.includes(m.accountId));
  const newSKeys = (typeof b.skeys === 'object' && b.skeys !== null ? b.skeys : {}) as Record<string, unknown>;
  for (const m of remaining) {
    const sealed = (newKeys as Record<string, unknown>)[m.accountId];
    if (typeof sealed !== 'string' || !SEALED_KEY.test(sealed)) throw new HttpError(409, 'The member list changed meanwhile. Please try again.');
    if (!viewerSecrets && m.role !== 'viewer') {
      const s = newSKeys[m.accountId];
      if (typeof s !== 'string' || !SEALED_KEY.test(s)) throw new HttpError(409, 'The member list changed meanwhile. Please try again.');
    }
  }
  const name = meta(b.meta);
  if (name.k !== epoch) throw new HttpError(400, 'Malformed workspace name.');
  for (const id of removed) await repo.removeMember(ws.id, id);
  for (const m of remaining) {
    const skeys = viewerSecrets ? m.skeys ?? {}
      : m.role === 'viewer' ? {} : { ...m.skeys, [epoch]: newSKeys[m.accountId] as string };
    await repo.putMember({
      workspaceId: ws.id, accountId: m.accountId, role: m.role, skeys,
      keys: { ...m.keys, [epoch]: (newKeys as Record<string, string>)[m.accountId]! },
    });
  }
  // Pending invites hold only the old keys: they are cancelled (the owner can invite again).
  for (const i of await repo.invitesOf(ws.id)) await repo.deleteInvite(i.id);
  await repo.updateWorkspace(ws.id, { epoch, meta: name, viewerSecrets });
}

// ---- Sync (POST /api/wsync) ----

export async function workspaceSync(repo: Repo, accountId: string, body: unknown): Promise<{ notes: Envelope[]; rev: number; more: boolean; epoch: number }> {
  const b = obj(body);
  const { ws, me } = await membership(repo, accountId, uuid(b.workspaceId, 'workspace id'));
  const since = typeof b.since === 'number' && Number.isInteger(b.since) && b.since >= 0 ? b.since : 0;
  const incoming = b.notes === undefined ? [] : b.notes;
  if (!Array.isArray(incoming) || incoming.length > 5000 || !incoming.every(isEnvelope)) throw new HttpError(400, 'Malformed notes.');
  if (incoming.length) {
    if (me.role === 'viewer') throw new HttpError(403, 'You can view this workspace but not change it.');
    // New writes must use the current key, so members removed earlier cannot read them.
    if (incoming.some(e => e.k !== ws.epoch)) throw new HttpError(409, 'The workspace key changed. Refresh and try again.');
    await repo.putWorkspaceNotes(ws.id, incoming, accountId);
  }
  const { notes, revs } = await repo.workspaceNotesSince(ws.id, since, PAGE);
  let bytes = 0;
  let count = 0;
  while (count < notes.length) {
    bytes += JSON.stringify(notes[count]).length;
    if (count > 0 && bytes > RESPONSE_BUDGET) break;
    count++;
  }
  return { notes: notes.slice(0, count), rev: count ? revs[count - 1]! : since, more: count < notes.length || notes.length === PAGE, epoch: ws.epoch };
}

// ---- In-memory implementation (development and tests) ----

export function memoryWorkspaceRepo(accounts: () => Iterable<{ id: string; username: string; publicKey?: string | null }>, nextRev: () => number): WorkspaceRepo {
  const workspaces = new Map<string, Workspace>();
  const members = new Map<string, Map<string, Member>>();
  const invites = new Map<string, Invite>();
  const notes = new Map<string, Map<string, { env: Envelope; rev: number }>>();
  const accountById = (id: string) => [...accounts()].find(a => a.id === id);
  const clone = <T>(x: T): T => structuredClone(x);
  return {
    async setPublicKey(accountId, publicKey) {
      const a = accountById(accountId);
      if (!a) throw new HttpError(401, 'Please log in.');
      a.publicKey ??= publicKey;
      return a.publicKey;
    },
    async createWorkspace(ws, owner) {
      workspaces.set(ws.id, clone(ws));
      members.set(ws.id, new Map([[owner.accountId, clone(owner)]]));
    },
    getWorkspace: async id => (workspaces.has(id) ? clone(workspaces.get(id)!) : null),
    async updateWorkspace(id, fields) { const w = workspaces.get(id); if (w) Object.assign(w, clone(fields)); },
    async deleteWorkspace(id) {
      workspaces.delete(id); members.delete(id); notes.delete(id);
      for (const [k, i] of invites) if (i.workspaceId === id) invites.delete(k);
    },
    async workspacesOf(accountId) {
      return [...members.entries()].flatMap(([wsId, m]) => (m.has(accountId) && workspaces.has(wsId)
        ? [{ workspace: clone(workspaces.get(wsId)!), member: clone(m.get(accountId)!) }] : []));
    },
    async members(workspaceId) {
      return [...(members.get(workspaceId)?.values() ?? [])].map(m => {
        const a = accountById(m.accountId);
        return { ...clone(m), username: a?.username ?? '', publicKey: a?.publicKey ?? null };
      });
    },
    getMember: async (w, a) => clone(members.get(w)?.get(a) ?? null),
    async putMember(m) { members.get(m.workspaceId)?.set(m.accountId, clone(m)); },
    async removeMember(w, a) { members.get(w)?.delete(a); },
    async createInvite(i) { invites.set(i.id, clone(i)); },
    getInvite: async id => clone(invites.get(id) ?? null),
    async deleteInvite(id) { invites.delete(id); },
    invitesFor: async accountId => [...invites.values()].filter(i => i.inviteeId === accountId).map(clone),
    invitesOf: async workspaceId => [...invites.values()].filter(i => i.workspaceId === workspaceId).map(clone),
    async putWorkspaceNotes(workspaceId, list) {
      const map = notes.get(workspaceId) ?? new Map();
      notes.set(workspaceId, map);
      for (const env of list) {
        const existing = map.get(env.id);
        if (!existing || existing.env.updatedAt < env.updatedAt) map.set(env.id, { env, rev: nextRev() });
      }
    },
    async workspaceNotesSince(workspaceId, since, limit) {
      const rows = [...(notes.get(workspaceId)?.values() ?? [])].filter(r => r.rev > since).sort((a, b) => a.rev - b.rev).slice(0, limit);
      return { notes: rows.map(r => r.env), revs: rows.map(r => r.rev) };
    },
  };
}
