import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authenticate, createMemoryRepo, HttpError, login, logout, prelogin, recover, signup, sync, updateAccount, type Repo,
} from '../api/_lib/core';
import { initCrypto, toB64, wipe } from '../src/crypto';
import { encryptNote } from '../src/envelope';
import { normalizeNote } from '../src/model';
import {
  authKeyFromKek, createVault, deriveKek, recoveryAuthKey, rewrapPasswordWithAuth, setProfile, unlockWithKek,
  unlockWithRecoveryKey, type VaultHeader,
} from '../src/vault';

const FAST = { opslimit: 1, memlimit: 8192 };
const PASSWORD = 'correct horse battery staple';
let repo: Repo;

beforeAll(() => initCrypto());
beforeEach(() => { repo = createMemoryRepo(); });

/** What the browser does to sign up. */
async function newAccount(username = 'albert') {
  const v = createVault(PASSWORD, FAST, { userName: 'Albert' });
  const res = await signup(repo, { username, header: v.header, authKey: toB64(v.authKey), recoveryAuthKey: toB64(v.recoveryAuthKey), notes: [] });
  return { ...v, token: res.token };
}
/** What the browser does to log in. */
async function browserLogin(username: string, password: string) {
  const { kdf } = await prelogin(repo, 'secret', { username });
  const kek = deriveKek(password, kdf);
  try {
    const res = await login(repo, { username, authKey: toB64(authKeyFromKek(kek)) });
    return { ...res, vaultKey: unlockWithKek(res.header, kek) };
  } finally {
    wipe(kek);
  }
}
const auth = (token: string) => `Bearer ${token}`;
const note = (id: string, updatedAt: number, key: Uint8Array) =>
  encryptNote(key, { ...normalizeNote({ id, title: `Note ${id}`, blocks: [] })!, updatedAt });

const rejects = async (p: Promise<unknown>, status: number) => {
  await expect(p).rejects.toBeInstanceOf(HttpError);
  await p.catch((e: HttpError) => expect(e.status).toBe(status));
};

describe('accounts', () => {
  it('signs up and logs in on another device without ever sending the password', async () => {
    const a = await newAccount();
    const b = await browserLogin('albert', PASSWORD);
    expect(b.header.vaultId).toBe(a.header.vaultId);
    // The unwrapped vault key is the same: device B can read what A encrypts.
    expect(() => unlockWithKek(b.header, deriveKek(PASSWORD, b.header.kdf))).not.toThrow();
    expect(await authenticate(repo, auth(b.token))).toBeTruthy();
  });

  it('rejects a wrong password and unknown users with the same message', async () => {
    await newAccount();
    await expect(browserLogin('albert', 'wrong password!!')).rejects.toThrow('Wrong username or password.');
    await expect(browserLogin('nobody', PASSWORD)).rejects.toThrow('Wrong username or password.');
  });

  it('does not reveal which usernames exist (stable fake KDF parameters)', async () => {
    const a = await prelogin(repo, 'secret', { username: 'ghost' });
    const b = await prelogin(repo, 'secret', { username: 'ghost' });
    expect(a).toEqual(b);
    expect(a.kdf.alg).toBe('argon2id13');
  });

  it('refuses taken and malformed usernames, and malformed keys', async () => {
    await newAccount();
    const v = createVault(PASSWORD, FAST);
    await rejects(signup(repo, { username: 'albert', header: v.header, authKey: toB64(v.authKey), recoveryAuthKey: toB64(v.recoveryAuthKey) }), 409);
    await rejects(signup(repo, { username: 'A!', header: v.header, authKey: toB64(v.authKey), recoveryAuthKey: toB64(v.recoveryAuthKey) }), 400);
    await rejects(login(repo, { username: 'albert', authKey: 'short' }), 400);
  });

  it('logs out (the session token stops working)', async () => {
    const a = await newAccount();
    await logout(repo, auth(a.token));
    await rejects(authenticate(repo, auth(a.token)), 401);
    await rejects(authenticate(repo, null), 401);
  });
});

describe('sync', () => {
  it('moves notes between devices with last-write-wins and server revisions', async () => {
    const a = await newAccount();
    const accountId = await authenticate(repo, auth(a.token));
    const first = await sync(repo, accountId, { since: 0, notes: [note('n1', 100, a.vaultKey), note('n2', 100, a.vaultKey)] });
    expect(first.notes.map(n => n.id)).toEqual(['n1', 'n2']);

    // An older copy does not overwrite a newer one; a newer copy does.
    await sync(repo, accountId, { since: first.rev, notes: [note('n1', 50, a.vaultKey)] });
    const unchanged = await sync(repo, accountId, { since: first.rev, notes: [] });
    expect(unchanged.notes).toEqual([]);
    const newer = await sync(repo, accountId, { since: first.rev, notes: [note('n1', 200, a.vaultKey)] });
    expect(newer.notes.map(n => [n.id, n.updatedAt])).toEqual([['n1', 200]]);
  });

  it('accepts a pushed header only for profile changes', async () => {
    const a = await newAccount();
    const accountId = await authenticate(repo, auth(a.token));
    const renamed = setProfile(a.header, a.vaultKey, { userName: 'Albert T.' });
    expect((await sync(repo, accountId, { since: 0, notes: [], header: renamed })).header).toEqual(renamed);

    // Swapping the password slot through sync is ignored (it needs the current password).
    const hijack: VaultHeader = { ...rewrapPasswordWithAuth(renamed, a.vaultKey, 'attacker password', FAST).header };
    expect((await sync(repo, accountId, { since: 0, notes: [], header: hijack })).header).toEqual(renamed);
  });

  it('rejects malformed notes', async () => {
    const a = await newAccount();
    const accountId = await authenticate(repo, auth(a.token));
    await rejects(sync(repo, accountId, { since: 0, notes: [{ id: 'x', title: 'plaintext!' }] }), 400);
  });
});

describe('password changes', () => {
  it('changes the password only with the current one', async () => {
    const a = await newAccount();
    const accountId = await authenticate(repo, auth(a.token));
    const next = rewrapPasswordWithAuth(a.header, a.vaultKey, 'a brand new password', FAST);
    await rejects(updateAccount(repo, accountId, { currentAuthKey: toB64(next.authKey), header: next.header, authKey: toB64(next.authKey) }), 403);
    await updateAccount(repo, accountId, { currentAuthKey: toB64(a.authKey), header: next.header, authKey: toB64(next.authKey) });
    await expect(browserLogin('albert', PASSWORD)).rejects.toThrow('Wrong username or password.');
    expect((await browserLogin('albert', 'a brand new password')).header).toEqual(next.header);
  });

  it('resets a forgotten password with the recovery key', async () => {
    const a = await newAccount();
    const rAuth = toB64(recoveryAuthKey(a.recoveryKey));
    await rejects(recover(repo, { username: 'albert', recoveryAuthKey: toB64(new Uint8Array(32)) }), 401);
    const { header } = await recover(repo, { username: 'albert', recoveryAuthKey: rAuth });
    const vaultKey = unlockWithRecoveryKey(header, a.recoveryKey);
    const next = rewrapPasswordWithAuth(header, vaultKey, 'my new password!', FAST);
    const done = await recover(repo, { username: 'albert', recoveryAuthKey: rAuth, header: next.header, authKey: toB64(next.authKey) });
    expect(done.token).toBeTruthy();
    expect((await browserLogin('albert', 'my new password!')).header.vaultId).toBe(a.header.vaultId);
  });
});
