import { beforeAll, describe, expect, it } from 'vitest';
import { authenticate, createMemoryRepo, RESPONSE_BUDGET, signup, sync } from '../api/_lib/core';
import { initCrypto, toB64 } from '../src/crypto';
import { encryptNote } from '../src/envelope';
import { IMAGE_LIMITS, normalizeBlock, normalizeNote, noteToPlainText, pictureBytes, searchableText, type ImageBlock } from '../src/model';
import { batchBySize } from '../src/sync';
import { markdownToPages, pagesToMarkdown } from '../src/transfer';
import { createVault } from '../src/vault';

beforeAll(() => initCrypto());

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('picture blocks', () => {
  it('keep valid pictures and drop anything else', () => {
    const ok = normalizeBlock({ id: 'i', type: 'image', src: PNG, width: 1, height: 1, caption: 'dot' }) as ImageBlock;
    expect(ok).toMatchObject({ type: 'image', width: 1, height: 1, caption: 'dot' });
    expect(normalizeBlock({ type: 'image', src: 'https://evil.example/x.png' })).toBeNull();
    expect(normalizeBlock({ type: 'image', src: 'data:image/svg+xml;base64,PHN2Zz4=' })).toBeNull();
    expect(normalizeBlock({ type: 'image', src: 'javascript:alert(1)' })).toBeNull();
    expect(normalizeBlock({ type: 'image', src: `data:image/png;base64,${'A'.repeat(IMAGE_LIMITS.maxSrc)}` })).toBeNull();
    expect((normalizeBlock({ type: 'image', src: PNG, width: -5, height: 'x' }) as ImageBlock).width).toBe(0);
  });

  it('are searchable by caption, shown on sticky cards, and counted per page', () => {
    const note = normalizeNote({ id: 'n', title: 'Trip', blocks: [{ type: 'image', src: PNG, caption: 'Boarding pass' }] })!;
    expect(searchableText(note)).toContain('boarding pass');
    expect(noteToPlainText(note)).toBe('🖼 Boarding pass');
    expect(pictureBytes(note)).toBe(PNG.length);
  });

  it('survive a Markdown round trip', () => {
    const note = normalizeNote({ id: 'n', title: 'Trip', blocks: [{ type: 'image', src: PNG, caption: 'Boarding pass' }] })!;
    const md = pagesToMarkdown([note], { includeSecrets: false, titleOf: () => '' });
    expect(md).toContain(`![Boarding pass](${PNG})`);
    const back = markdownToPages(md, 'x').pages[0]!.blocks[0] as ImageBlock;
    expect(back).toMatchObject({ type: 'image', src: PNG, caption: 'Boarding pass' });
  });
});

describe('syncing large pages', () => {
  it('splits pushes into batches under the size budget', () => {
    const env = (id: string, size: number) => ({ id, updatedAt: 1, deleted: false, v: 1 as const, nonce: 'n', ct: 'x'.repeat(size) });
    const batches = batchBySize([env('a', 1500), env('b', 1500), env('c', 5000), env('d', 10)], 3200);
    expect(batches.map(b => b.map(e => e.id))).toEqual([['a', 'b'], ['c'], ['d']]);
  });

  it('pages server responses by size, always making progress', async () => {
    const repo = createMemoryRepo();
    const v = createVault('correct horse battery staple', { opslimit: 1, memlimit: 8192 });
    const s = await signup(repo, { username: 'pics', header: v.header, authKey: toB64(v.authKey), recoveryAuthKey: toB64(v.recoveryAuthKey), notes: [] });
    const accountId = await authenticate(repo, `Bearer ${s.token}`);
    const big = (id: string) => encryptNote(v.vaultKey, { ...normalizeNote({ id, title: id, blocks: [] })!, blocks: [{ id: 'p', type: 'p', content: 'x'.repeat(RESPONSE_BUDGET / 2) }], updatedAt: 5 });
    await sync(repo, accountId, { since: 0, notes: [big('a'), big('b'), big('c')] });
    const first = await sync(repo, accountId, { since: 0, notes: [] });
    expect(first.notes.length).toBeLessThan(3);
    expect(first.more).toBe(true);
    const seen = [...first.notes];
    let res = first;
    while (res.more) { res = await sync(repo, accountId, { since: res.rev, notes: [] }); seen.push(...res.notes); }
    expect(seen.map(n => n.id).sort()).toEqual(['a', 'b', 'c']);
  });
});
