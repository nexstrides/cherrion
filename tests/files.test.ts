// Attached files: the real client (src/files.ts) against the real server logic (api/_lib/files.ts)
// with the in-memory database.
import { beforeAll, describe, expect, it } from 'vitest';
import * as core from '../api/_lib/core';
import { FILE_LIMITS as SERVER_LIMITS, fileAction } from '../api/_lib/files';
import { setSession, setTransport } from '../src/api';
import { initCrypto, toB64 } from '../src/crypto';
import { attachFile, fileProblem, openFile, releaseFile } from '../src/files';
import { normalizeBlock, type FileBlock } from '../src/model';
import { createVault } from '../src/vault';

const repo = core.createMemoryRepo();
const tokens = new Map<string, string>();

beforeAll(async () => {
  await initCrypto();
  setTransport(async (path, body, token) => {
    try {
      if (path !== 'file') throw new Error(`unexpected ${path}`);
      const data = await fileAction(repo, await core.authenticate(repo, token ? `Bearer ${token}` : null), JSON.parse(body));
      return { status: 200, data: data as Record<string, unknown> };
    } catch (err) {
      if (err instanceof core.HttpError) return { status: err.status, data: { error: err.message } };
      throw err;
    }
  });
});

async function as(name: string): Promise<void> {
  if (!tokens.has(name)) {
    const v = createVault('correct horse battery staple', { opslimit: 1, memlimit: 8192 }, { userName: name });
    const res = await core.signup(repo, { username: name, header: v.header, authKey: toB64(v.authKey), recoveryAuthKey: toB64(v.recoveryAuthKey), notes: [] });
    tokens.set(name, res.token);
  }
  setSession(tokens.get(name)!);
}

const bytesOf = (n: number, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251);
const fileOf = (name: string, bytes: Uint8Array, type = 'application/pdf') => new File([bytes as BlobPart], name, { type });

describe('attached files', () => {
  let block: FileBlock;
  const content = bytesOf(3 * 1024 * 1024 + 123); // two chunks

  it('encrypts a file in chunks, stores it, and opens it again', async () => {
    await as('filer');
    block = await attachFile(fileOf('Contract.pdf', content));
    expect([block.name, block.size, block.chunks, block.mime]).toEqual(['Contract.pdf', content.length, 2, 'application/pdf']);
    expect(normalizeBlock(JSON.parse(JSON.stringify(block)))).toEqual(block); // survives saving in a page
    expect(await openFile(block)).toEqual(content);
  });

  it('stores only ciphertext on the server', async () => {
    const stored = await repo.getFileChunk(block.fileId, 0);
    expect(stored?.ct).toBeTruthy();
    expect(stored!.ct).not.toContain(toB64(content.subarray(0, 64)));
  });

  it('lets anyone with the page download it, but only the uploader replace or delete it', async () => {
    await as('reader');
    expect(await openFile(block)).toEqual(content);
    await expect(fileAction(repo, (await repo.findAccount('reader'))!.id, { action: 'put', fileId: block.fileId, index: 0, count: 2, nonce: 'abc', ct: 'abc' }))
      .rejects.toMatchObject({ status: 403 });
    await releaseFile(block.fileId); // not theirs: nothing happens
    expect(await openFile(block)).toEqual(content);
    await as('filer');
    await releaseFile(block.fileId);
    await expect(openFile(block)).rejects.toThrow('no longer available');
  });

  it('refuses programs, files over 10 MB, and tampered chunks', async () => {
    expect(fileProblem({ name: 'setup.exe', size: 10 })).toContain('.exe files are not supported');
    expect(fileProblem({ name: 'notes', size: 10 })).toContain('without a type');
    expect(fileProblem({ name: 'big.zip', size: 10 * 1024 * 1024 + 1 })).toContain('up to 10 MB');
    expect(fileProblem({ name: 'ok.docx', size: 10 * 1024 * 1024 })).toBeNull();
    await as('filer');
    const small = await attachFile(fileOf('notes.txt', bytesOf(500), 'text/plain'));
    const chunk = (await repo.getFileChunk(small.fileId, 0))!;
    await repo.putFileChunk({ ...chunk, ct: `${chunk.ct.slice(0, -4)}AAAA` });
    await expect(openFile(small)).rejects.toThrow('damaged');
    // Another file's key cannot open it either.
    await expect(openFile({ ...small, key: block.key })).rejects.toThrow('damaged');
  });

  it('keeps each account under its storage limit', async () => {
    const saved = SERVER_LIMITS.quotaChars;
    SERVER_LIMITS.quotaChars = 3000;
    try {
      await as('hoarder');
      await attachFile(fileOf('a.txt', bytesOf(1000), 'text/plain'));
      await expect(attachFile(fileOf('b.txt', bytesOf(2000), 'text/plain'))).rejects.toThrow('storage limit');
    } finally {
      SERVER_LIMITS.quotaChars = saved;
    }
  });

  it('rejects file blocks that do not make sense', () => {
    const good = { id: 'b', type: 'file', fileId: '00000000-0000-4000-8000-000000000000', name: 'a.pdf', size: 10, mime: 'application/pdf', chunks: 1, key: 'A'.repeat(43), note: '' };
    expect(normalizeBlock(good)).not.toBeNull();
    expect(normalizeBlock({ ...good, name: '..\\evil/a.pdf' })).toMatchObject({ name: '.._evil_a.pdf' });
    for (const bad of [{ key: 'short' }, { fileId: 'x' }, { size: 11 * 1024 * 1024 }, { chunks: 2 }, { name: '' }]) {
      expect(normalizeBlock({ ...good, ...bad })).toBeNull();
    }
  });
});
