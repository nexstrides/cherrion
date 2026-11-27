// Shared workspaces end to end: the real client code (store + workspaces.ts) against the real server
// logic (core.ts + workspaces.ts) with the in-memory database. Several people take turns in the one
// client, the way a browser would after logging out and in.
import { beforeAll, describe, expect, it } from 'vitest';
import * as core from '../api/_lib/core';
import { workspaceAction, workspaceSync } from '../api/_lib/workspaces';
import { setSession, setTransport, type Transport } from '../src/api';
import { initCrypto, toB64, type Sealed } from '../src/crypto';
import type { Envelope } from '../src/envelope';
import { normalizeNote, textBlock, uid } from '../src/model';
import * as store from '../src/store';
import { createVault, deriveKek, unlockWithKek } from '../src/vault';
import * as ws from '../src/workspaces';

const FAST = { opslimit: 1, memlimit: 8192 };
const PASSWORD = 'correct horse battery staple';
const repo = core.createMemoryRepo();

/** Routes the API client straight into the server logic. */
const online: Transport = async (path, body, token) => {
    try {
      const auth = token ? `Bearer ${token}` : null;
      const b = JSON.parse(body);
      const data = path === 'signup' ? await core.signup(repo, b)
        : path === 'login' ? await core.login(repo, b)
          : path === 'prelogin' ? await core.prelogin(repo, 's', b)
            : path === 'sync' ? await core.sync(repo, await core.authenticate(repo, auth), b)
              : path === 'workspace' ? await workspaceAction(repo, await core.authenticate(repo, auth), b)
                : path === 'wsync' ? await workspaceSync(repo, await core.authenticate(repo, auth), b)
                  : null;
      return { status: 200, data: data as Record<string, unknown> };
    } catch (err) {
      if (err instanceof core.HttpError) return { status: err.status, data: { error: err.message } };
      throw err;
    }
};
/** No connection at all. */
const offline: Transport = async () => ({ status: 0, data: {} });

beforeAll(async () => {
  await initCrypto();
  setTransport(online);
});

const people = new Map<string, { token: string; vaultKey: Uint8Array }>();

/** Signs someone up (first time) or "logs in" as them: their vault in the one client. */
async function as(name: string): Promise<void> {
  await store.lock();
  ws.reset();
  ws.resetSync();
  let p = people.get(name);
  if (!p) {
    const v = createVault(PASSWORD, FAST, { userName: name });
    const res = await core.signup(repo, { username: name, header: v.header, authKey: toB64(v.authKey), recoveryAuthKey: toB64(v.recoveryAuthKey), notes: [] });
    p = { token: res.token, vaultKey: v.vaultKey };
    people.set(name, p);
  }
  setSession(p.token);
  const account = (await repo.findAccount(name))!;
  const vaultKey = unlockWithKek(account.header, deriveKek(PASSWORD, account.header.kdf));
  store.unlock(account.header, vaultKey, []);
  // First time: makes the identity (nothing published yet); the header then goes up with a sync,
  // and only after that is the public key published.
  if (!(await ws.ensureIdentity())) {
    const h = store.takeDirtyHeader();
    if (h) await core.sync(repo, (await core.authenticate(repo, `Bearer ${p.token}`)), { since: 0, notes: [], header: h });
    expect(await ws.ensureIdentity()).not.toBeNull();
  }
  await ws.refresh();
}

const page = (title: string) => normalizeNote({ id: uid(), title, blocks: [textBlock('p', `${title} body`)] })!;
const titlesIn = (space: string) => { store.setActiveSpace(space); return store.activeNotes().map(n => n.title).sort(); };

describe('shared workspaces', () => {
  let teamId = '';
  let link = '';

  it('creates a workspace and invites by username', async () => {
    await as('alice');
    teamId = await ws.createWorkspace('Team plans');
    expect(ws.listWorkspaces().map(w => [w.name, w.role])).toEqual([['Team plans', 'owner']]);
    store.addNote(page('Shared roadmap'), teamId);
    await store.flush();
    await ws.syncWorkspaces();

    await as('bob'); // bob needs an account (and identity) to be invited by name
    await as('alice');
    await ws.inviteByUsername(teamId, 'bob', 'editor');
    expect(ws.getWorkspace(teamId)!.invites.map(i => [i.username, i.role])).toEqual([['bob', 'editor']]);
  });

  it('lets the invitee accept and read and edit the pages', async () => {
    await as('bob');
    expect(ws.listInvitations().map(i => [i.name, i.from, i.role])).toEqual([['Team plans', 'alice', 'editor']]);
    await ws.acceptInvitation(ws.listInvitations()[0]!.id);
    await ws.syncWorkspaces();
    expect(titlesIn(teamId)).toEqual(['Shared roadmap']);
    expect(titlesIn(store.PERSONAL)).toEqual([]); // nothing leaked into bob's personal vault
    store.addNote(page('Bob notes'), teamId);
    await store.flush();
    await ws.syncWorkspaces();

    await as('alice');
    await ws.syncWorkspaces();
    expect(titlesIn(teamId)).toEqual(['Bob notes', 'Shared roadmap']);
    expect(ws.getWorkspace(teamId)!.members.map(m => [m.username, m.role]).sort()).toEqual([['alice', 'owner'], ['bob', 'editor']]);
  });

  it('joins with a single-use invite link, as a viewer who cannot write', async () => {
    await as('alice');
    link = await ws.createInviteLink(teamId, 'viewer', 'https://cherrion.test');
    expect(link).toMatch(/^https:\/\/cherrion\.test\/#join=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);

    await as('carol');
    const parsed = ws.parseInviteLink(link)!;
    const preview = await ws.previewInviteLink(parsed);
    expect([preview.name, preview.role, preview.from]).toEqual(['Team plans', 'viewer', 'alice']);
    await ws.joinWithLink(parsed);
    await ws.syncWorkspaces();
    expect(titlesIn(teamId)).toEqual(['Bob notes', 'Shared roadmap']);
    expect(store.isReadOnly(teamId)).toBe(true);
    expect(() => store.addNote(page('Not allowed'), teamId)).toThrow('view');
    // The server refuses viewer writes even if a client tried.
    await expect(workspaceSync(repo, (await repo.findAccount('carol'))!.id, { workspaceId: teamId, notes: [{ id: 'x', updatedAt: 1, deleted: false, v: 1, nonce: 'n', ct: 'c', k: 1 }] }))
      .rejects.toMatchObject({ status: 403 });

    await as('dave');
    await expect(ws.previewInviteLink(ws.parseInviteLink(link)!)).rejects.toThrow('no longer valid'); // used once already
  });

  it('removing a member replaces the key, so they cannot read anything new', async () => {
    await as('alice');
    await ws.removeMember(teamId, (await repo.findAccount('bob'))!.id);
    expect(ws.getWorkspace(teamId)!.epoch).toBe(2);
    store.addNote(page('After bob left'), teamId);
    await store.flush();
    await ws.syncWorkspaces();
    await ws.syncWorkspaces();
    expect(titlesIn(teamId)).toEqual(['After bob left', 'Bob notes', 'Shared roadmap']);

    await as('bob');
    expect(ws.listWorkspaces()).toEqual([]);
    await expect(workspaceSync(repo, (await repo.findAccount('bob'))!.id, { workspaceId: teamId, since: 0 })).rejects.toMatchObject({ status: 404 });

    await as('carol'); // still a member: gets the new key and reads everything
    await ws.syncWorkspaces();
    expect(titlesIn(teamId)).toEqual(['After bob left', 'Bob notes', 'Shared roadmap']);
  });

  it('only owners manage, and a workspace keeps an owner', async () => {
    await as('carol');
    await expect(ws.inviteByUsername(teamId, 'dave', 'editor')).rejects.toMatchObject({ status: 403 });
    await as('alice');
    await expect(ws.leaveWorkspace(teamId)).rejects.toThrow('at least one owner');
  });

  it('keeps the first identity when a second device sets one up at the same time', async () => {
    await as('alice');
    const id = (await repo.findAccount('alice'))!.id;
    const published = (await repo.findAccount('alice'))!.publicKey;
    // A second device made its own identity before seeing the first one's header.
    store.setIdentity((await import('../src/crypto')).newBoxKeyPair());
    const rival = store.takeDirtyHeader()!;
    const res = await core.sync(repo, id, { since: 0, notes: [], header: rival });
    expect(res.header.identity?.publicKey).toBe(published); // refused
    ws.resetSync();
    expect(ws.myPublicKey()).not.toBe(published);
    await ws.ensureIdentity(); // notices and takes the account's identity
    expect(ws.myPublicKey()).toBe(published);
    await ws.refresh();
    expect(ws.listWorkspaces().map(w => w.name)).toEqual(['Team plans']);
  });

  it('never stores a readable name or page on the server', async () => {
    const dump = JSON.stringify(await repo.workspaceNotesSince(teamId, 0, 1000)) + JSON.stringify(await repo.getWorkspace(teamId));
    for (const secret of ['Team plans', 'Shared roadmap', 'Bob notes', 'body']) expect(dump).not.toContain(secret);
  });
});

/** The workspace tables of a desktop vault file, as vaultfile.py keeps them (newest copy wins). */
function vaultFile() {
  const spaces = new Map<string, Sealed>();
  const pages = new Map<string, { space: string; envelope: Envelope; dirty: boolean }>();
  const journal: store.Journal = {
    put: (envs, dirty, space) => {
      if (!space) return;
      for (const envelope of envs) {
        const current = pages.get(`${space}/${envelope.id}`);
        if (!current || envelope.updatedAt >= current.envelope.updatedAt) pages.set(`${space}/${envelope.id}`, { space, envelope, dirty });
      }
    },
    clean: (envs, space) => {
      for (const e of envs) {
        const current = pages.get(`${space}/${e.id}`);
        if (current && current.envelope.updatedAt === e.updatedAt) current.dirty = false;
      }
    },
    header: () => {},
    space: (id, record) => {
      if (record) { spaces.set(id, record); return; }
      spaces.delete(id);
      for (const key of [...pages.keys()]) if (key.startsWith(`${id}/`)) pages.delete(key);
    },
  };
  const contents = () => ({ spaces: [...spaces].map(([id, record]) => ({ id, record })), spaceNotes: [...pages.values()] });
  return { journal, spaces, pages, contents };
}

describe('owned workspaces in the desktop vault file', () => {
  const olgaFile = vaultFile();
  const edFile = vaultFile();
  let id = '';

  /** As `as()`, with that person's vault file open (the desktop app attaches it before syncing). */
  async function withFile(name: string, file: ReturnType<typeof vaultFile>): Promise<void> {
    store.setJournal(null);
    await as(name);
    store.setJournal(file.journal);
    ws.syncSoon();
    await ws.syncAll();
  }

  it('keeps an owner’s workspace and its pages in the file, encrypted', async () => {
    await withFile('olga', olgaFile);
    id = await ws.createWorkspace('Field notes');
    expect([...olgaFile.spaces.keys()]).toEqual([id]);
    store.addNote(page('Olga plan'), id);
    await store.flush();
    expect([...olgaFile.pages.values()].map(p => p.dirty)).toEqual([true]); // saved in the file before the server
    await ws.syncWorkspaces();
    expect([...olgaFile.pages.values()].map(p => p.dirty)).toEqual([false]);
    const raw = JSON.stringify([...olgaFile.spaces.values(), ...[...olgaFile.pages.values()].map(p => p.envelope)]);
    for (const secret of ['Field notes', 'Olga plan', 'olga']) expect(raw).not.toContain(secret);
  });

  it('keeps nothing for members who are not owners', async () => {
    await withFile('eddie', edFile); // eddie needs an account first
    await withFile('olga', olgaFile);
    await ws.inviteByUsername(id, 'eddie', 'editor');
    await withFile('eddie', edFile);
    await ws.acceptInvitation(ws.listInvitations().find(i => i.workspaceId === id)!.id);
    await ws.syncWorkspaces();
    store.addNote(page('Ed idea'), id);
    await store.flush();
    await ws.syncWorkspaces();
    expect(edFile.spaces.size + edFile.pages.size).toBe(0);
    await withFile('olga', olgaFile); // pulls Ed's page into her file
    expect([...olgaFile.pages.values()].length).toBe(2);
  });

  it('opens offline from the file, and uploads offline edits later', async () => {
    store.setJournal(null);
    await store.lock();
    ws.reset();
    ws.resetSync();
    setTransport(offline);
    try {
      const account = (await repo.findAccount('olga'))!;
      store.unlock(account.header, unlockWithKek(account.header, deriveKek(PASSWORD, account.header.kdf)), []);
      store.setJournal(olgaFile.journal);
      const { spaces, spaceNotes } = olgaFile.contents();
      ws.loadFromFile(spaces, spaceNotes);
      expect(ws.listWorkspaces().map(w => [w.name, w.role])).toEqual([['Field notes', 'owner']]);
      expect(titlesIn(id)).toEqual(['Ed idea', 'Olga plan']);
      store.addNote(page('Written offline'), id);
      await store.flush();
      await ws.syncAll(); // no connection: nothing happens
      expect([...olgaFile.pages.values()].filter(p => p.dirty).length).toBe(1);
    } finally {
      setTransport(online);
    }
    setSession(people.get('olga')!.token);
    ws.syncSoon();
    await ws.syncAll();
    expect([...olgaFile.pages.values()].some(p => p.dirty)).toBe(false);
    await withFile('eddie', edFile);
    await ws.syncWorkspaces();
    expect(titlesIn(id)).toEqual(['Ed idea', 'Olga plan', 'Written offline']);
  });

  it('removes the copy when the workspace is deleted', async () => {
    await withFile('olga', olgaFile);
    await ws.deleteWorkspace(id);
    expect(olgaFile.spaces.size + olgaFile.pages.size).toBe(0);
  });
});

describe('secret fields hidden from viewers', () => {
  let wid = '';
  let editorLink = '';
  let viewerLink = '';
  const fieldsBlock = (password: string) => ({
    id: uid(), type: 'fields',
    fields: [{ id: uid(), label: 'User', value: 'alice', kind: 'text' }, { id: uid(), label: 'Password', value: password, kind: 'password' }],
  });
  const secretPage = (title: string, password: string) => normalizeNote({ id: uid(), title, blocks: [fieldsBlock(password)] })!;
  /** [label, value, locked] of the page's fields, as this account sees them. */
  const fields = (title: string) => {
    store.setActiveSpace(wid);
    const note = store.activeNotes().find(n => n.title === title)!;
    const block = note.blocks[0]!;
    return block.type === 'fields' ? block.fields.map(f => [f.label, f.value, !!f.locked]) : [];
  };
  const accountId = async (name: string) => (await repo.findAccount(name))!.id;

  it('seals secret values so a viewer cannot read them, while editors can', async () => {
    for (const name of ['vera', 'eric', 'lena']) await as(name);
    await as('owen');
    wid = await ws.createWorkspace('Vault team');
    store.addNote(secretPage('Router', 'hunter2'), wid);
    await store.flush();
    await ws.syncWorkspaces();
    expect(await ws.setViewerSecrets(wid, false)).toBe(1); // the existing page is sealed again
    expect(ws.getWorkspace(wid)!.viewerSecrets).toBe(false);
    await ws.inviteByUsername(wid, 'vera', 'viewer');
    editorLink = await ws.createInviteLink(wid, 'editor', 'https://cherrion.test');
    viewerLink = await ws.createInviteLink(wid, 'viewer', 'https://cherrion.test');

    await as('vera');
    await ws.acceptInvitation(ws.listInvitations().find(i => i.workspaceId === wid)!.id);
    await ws.syncWorkspaces();
    expect(fields('Router')).toEqual([['User', 'alice', false], ['Password', '', true]]);
    // Not anywhere in the page she decrypted with the workspace key either.
    expect(JSON.stringify(store.getNote(store.activeNotes().find(n => n.title === 'Router')!.id))).not.toContain('hunter2');

    await as('eric');
    await ws.joinWithLink(ws.parseInviteLink(editorLink)!);
    await ws.syncWorkspaces();
    expect(fields('Router')).toEqual([['User', 'alice', false], ['Password', 'hunter2', false]]);
    const note = store.activeNotes().find(n => n.title === 'Router')!;
    const block = note.blocks[0]!;
    if (block.type === 'fields') block.fields[1]!.value = 'swordfish';
    store.touchNote(note);
    await store.flush();
    await ws.syncWorkspaces();

    await as('lena');
    await ws.joinWithLink(ws.parseInviteLink(viewerLink)!);
    await ws.syncWorkspaces();
    expect(fields('Router')).toEqual([['User', 'alice', false], ['Password', '', true]]);
  });

  it('gives the secrets key to a promoted viewer and replaces it when an editor becomes a viewer', async () => {
    await as('owen');
    await ws.syncWorkspaces();
    expect(fields('Router')[1]).toEqual(['Password', 'swordfish', false]);
    await ws.setRole(wid, await accountId('vera'), 'editor');
    await ws.setRole(wid, await accountId('eric'), 'viewer');
    const note = store.activeNotes().find(n => n.title === 'Router')!;
    const block = note.blocks[0]!;
    if (block.type === 'fields') block.fields[1]!.value = 'newsecret';
    store.touchNote(note);
    await store.flush();
    await ws.syncWorkspaces();

    await as('vera');
    await ws.syncWorkspaces();
    expect(fields('Router')[1]).toEqual(['Password', 'newsecret', false]);
    await as('eric');
    await ws.syncWorkspaces();
    expect(fields('Router')[1]).toEqual(['Password', '', true]);
    // The server refuses editors without the secrets key.
    await expect(workspaceAction(repo, await accountId('owen'), { action: 'setRole', workspaceId: wid, accountId: await accountId('eric'), role: 'editor' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('lets viewers see secret fields again when the owner allows it', async () => {
    await as('owen');
    await ws.syncWorkspaces();
    expect(await ws.setViewerSecrets(wid, true)).toBe(1);
    await as('lena');
    await ws.syncWorkspaces();
    expect(fields('Router')).toEqual([['User', 'alice', false], ['Password', 'newsecret', false]]);
  });
});
