import { beforeAll, describe, expect, it } from 'vitest';
import { initCrypto, randomKey } from '../src/crypto';
import { encryptNote } from '../src/envelope';
import { stampForMigration } from '../src/legacy';
import { normalizeNote } from '../src/model';
import { planRoom } from '../src/sync';
import { createVault } from '../src/vault';

beforeAll(() => initCrypto());

const FAST = { opslimit: 1, memlimit: 8192 };
const plain = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, parentId: null, title: `Note ${id}`, updatedAt: 100, deleted: false, blocks: [{ id: `${id}-b`, type: 'p', content: 'hi' }], ...extra });

describe('planRoom', () => {
  it('refuses a room that belongs to another vault', () => {
    const other = createVault('another vault password', FAST).header;
    const records = { __vault__: { id: '__vault__', updatedAt: other.updatedAt, header: other } };
    expect(planRoom(records, 'my-vault-id')).toEqual({ kind: 'foreign' });
  });

  it('collects envelopes and the remote header for this vault', () => {
    const { header } = createVault('my vault password', FAST);
    const env = encryptNote(randomKey(), normalizeNote(plain('n1'))!);
    const plan = planRoom({ __vault__: { id: '__vault__', updatedAt: header.updatedAt, header }, n1: env }, header.vaultId);
    expect(plan).toEqual({ kind: 'ok', remoteHeader: header, envelopes: [env], legacy: [] });
  });

  it('imports plaintext notes only from a room no vault has claimed', () => {
    const unclaimed = planRoom({ a: plain('a'), b: plain('b') }, 'my-vault-id');
    expect(unclaimed.kind === 'ok' && unclaimed.legacy.map(n => n.id)).toEqual(['a', 'b']);

    const { header } = createVault('my vault password', FAST);
    const claimed = planRoom({ __vault__: { id: '__vault__', updatedAt: header.updatedAt, header }, a: plain('a') }, header.vaultId);
    expect(claimed.kind === 'ok' && claimed.legacy).toEqual([]);
  });

  it('treats a malformed vault record as a claim, so injected plaintext is still ignored', () => {
    const plan = planRoom({ __vault__: { junk: true }, a: plain('a') }, 'my-vault-id');
    expect(plan).toEqual({ kind: 'ok', remoteHeader: null, envelopes: [], legacy: [] });
  });
});

describe('stampForMigration', () => {
  it('makes migrated notes newer than their plaintext copies and empties tombstones', () => {
    const [live, gone] = stampForMigration(
      [normalizeNote(plain('a'))!, normalizeNote(plain('b', { deleted: true, title: 'secret title' }))!],
      5000,
    );
    expect(live!.updatedAt).toBe(5000);
    expect(live!.blocks).toHaveLength(1);
    expect(gone!.updatedAt).toBe(5000);
    expect(gone!.title).toBe('');
    expect(gone!.blocks).toEqual([]);
  });
});
