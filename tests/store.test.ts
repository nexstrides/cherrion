// The store's desktop hooks: the journal (writes to the vault file), unsent notes restored from the
// file, local-only password changes, and taking an account's header when a file is linked.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initCrypto } from '../src/crypto';
import type { Envelope } from '../src/envelope';
import { encryptNote } from '../src/envelope';
import { normalizeNote } from '../src/model';
import * as store from '../src/store';
import { setTransport } from '../src/api';
import {
  authKeyFromKek, createVault, deriveKek, readProfile, rewrapPasswordWithAuth, setProfile, unlockWithPassword, type VaultHeader,
} from '../src/vault';

const FAST = { opslimit: 1, memlimit: 8192 };
const PASSWORD = 'correct horse battery staple';

beforeAll(() => initCrypto());
afterEach(async () => {
  await store.lock();
  store.setJournal(null);
  store.setRemoteAccount(true);
});

function recorder() {
  const log = { put: [] as [string[], boolean][], clean: [] as string[][], header: [] as VaultHeader[] };
  const journal: store.Journal = {
    put: (envs, dirty) => log.put.push([envs.map(e => e.id), dirty]),
    clean: envs => log.clean.push(envs.map(e => e.id)),
    header: h => log.header.push(h),
  };
  return { log, journal };
}

const note = (id: string, key: Uint8Array, updatedAt = 100): Envelope =>
  encryptNote(key, { ...normalizeNote({ id, title: `Note ${id}`, blocks: [] })!, updatedAt });

describe('desktop journal', () => {
  it('writes edits as unsent, server copies as sent, and confirmations as clean', async () => {
    const v = createVault(PASSWORD, FAST);
    const { log, journal } = recorder();
    store.unlock(v.header, v.vaultKey, [note('a', v.vaultKey)]);
    store.setJournal(journal);

    const a = store.getNote('a')!;
    a.title = 'changed';
    store.touchNote(a);
    await store.flush();
    expect(log.put).toEqual([[['a'], true]]);

    const sent = store.outgoing();
    store.confirmSent(sent);
    expect(log.clean).toEqual([['a']]);
    expect(store.unsavedCount()).toBe(0);

    store.applyEnvelopes([note('b', v.vaultKey, 200)]);
    expect(log.put.at(-1)).toEqual([['b'], false]);
  });

  it('restores unsent notes from the file into the outbox', () => {
    const v = createVault(PASSWORD, FAST);
    store.unlock(v.header, v.vaultKey, [note('a', v.vaultKey), note('b', v.vaultKey)], ['b', 'gone']);
    expect(store.outgoing().map(e => e.id)).toEqual(['b']);
  });

  it('queues every note when a file is linked to an account', () => {
    const v = createVault(PASSWORD, FAST);
    const { log, journal } = recorder();
    store.unlock(v.header, v.vaultKey, [note('a', v.vaultKey), note('b', v.vaultKey)]);
    store.setJournal(journal);
    store.markAllUnsent();
    expect(store.outgoing().map(e => e.id).sort()).toEqual(['a', 'b']);
    expect(log.put).toEqual([[['a', 'b'], true]]);
  });
});

describe('online accounts', () => {
  it('hands the new login key to its keepers after a password change', async () => {
    const v = createVault(PASSWORD, FAST);
    store.unlock(v.header, v.vaultKey, []);
    store.setRemoteAccount(true);
    // A fake server that accepts the change and echoes the new header.
    setTransport(async (_path, body) => ({ status: 200, data: { header: JSON.parse(body).header } }));
    const seen: Uint8Array[] = [];
    store.onAuthKeyChange(key => seen.push(key.slice()));
    await store.changePassword(PASSWORD, 'a brand new password');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(authKeyFromKek(deriveKek('a brand new password', store.getHeader()!.kdf)));
    setTransport(async () => ({ status: 0, data: {} }));
  });
});

describe('local vault files', () => {
  it('changes the password locally when the file is not linked', async () => {
    const v = createVault(PASSWORD, FAST);
    const { log, journal } = recorder();
    store.unlock(v.header, v.vaultKey, []);
    store.setJournal(journal);
    store.setRemoteAccount(false);
    await store.changePassword(PASSWORD, 'a brand new password');
    const saved = log.header.at(-1)!;
    expect(() => unlockWithPassword(saved, 'a brand new password')).not.toThrow();
    expect(() => unlockWithPassword(saved, PASSWORD)).toThrow();
  });

  it('takes an account header (its password) while keeping a newer local name', () => {
    const v = createVault(PASSWORD, FAST, { userName: 'Old' });
    const account = rewrapPasswordWithAuth(v.header, v.vaultKey, 'account password!', FAST).header;
    store.unlock(setProfile(v.header, v.vaultKey, { userName: 'New name' }), v.vaultKey, []);
    expect(store.adoptAccountHeader(account)).toBe(true);
    const h = store.getHeader()!;
    expect(readProfile(h, v.vaultKey)?.userName).toBe('New name');
    expect(() => unlockWithPassword(h, 'account password!')).not.toThrow();
    expect(store.takeDirtyHeader()).toEqual(h); // the name goes up with the next sync
  });

  it('refuses another vault’s header', () => {
    const v = createVault(PASSWORD, FAST);
    store.unlock(v.header, v.vaultKey, []);
    expect(store.adoptAccountHeader(createVault(PASSWORD, FAST).header)).toBe(false);
  });

  it('prepares an online account with a fresh recovery key, changing nothing yet', () => {
    const v = createVault(PASSWORD, FAST);
    store.unlock(v.header, v.vaultKey, []);
    const prepared = store.prepareAccount(PASSWORD);
    expect(prepared.recoveryKey).not.toBe(v.recoveryKey);
    expect(store.getHeader()).toEqual(v.header);
    expect(() => store.prepareAccount('wrong password!!')).toThrow();
  });
});
