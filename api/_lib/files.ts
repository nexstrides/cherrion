// File attachments, server side. Zero-knowledge like the rest of the API: a file is encrypted in the
// browser with its own random key, which lives only inside the (encrypted) page that shows it, and
// arrives here as encrypted chunks of up to 2 MB (the host accepts request bodies up to 4.5 MB).
//
// Anyone signed in may fetch a chunk by its file id: the id is random and the content is useless
// without the key from the page, and this lets everyone who can open a page (workspace members, a
// page exported to someone else) download its files. Only the account that uploaded a file can
// replace or delete it.
import { HttpError, type Repo } from './core.js';

export const FILE_LIMITS = {
  /** Largest file, before encryption. */
  maxBytes: 10 * 1024 * 1024,
  /** Size of each chunk before encryption (the last one may be smaller). */
  chunkBytes: 2 * 1024 * 1024,
  /** All files of one account, as stored (encrypted, base64). Protects the database's free tier. */
  quotaChars: 200 * 1024 * 1024,
};
const MAX_CHUNKS = Math.ceil(FILE_LIMITS.maxBytes / FILE_LIMITS.chunkBytes);
// base64url of (chunk + 16-byte tag), without padding.
const MAX_CT_CHARS = Math.ceil(((FILE_LIMITS.chunkBytes + 16) * 4) / 3);

export interface FileChunk { fileId: string; index: number; count: number; ownerId: string; nonce: string; ct: string }

export interface FileRepo {
  putFileChunk(chunk: FileChunk): Promise<void>;
  getFileChunk(fileId: string, index: number): Promise<FileChunk | null>;
  /** The account that uploaded a file (null if there is no such file). */
  fileOwner(fileId: string): Promise<string | null>;
  /** Characters stored for an account's files (ciphertext, base64). */
  fileCharsOf(ownerId: string): Promise<number>;
  deleteFile(fileId: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
const obj = (body: unknown): Record<string, unknown> =>
  (typeof body === 'object' && body !== null ? body as Record<string, unknown> : {});

function fileId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, 'Missing or malformed file id.');
  return value;
}

function integer(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new HttpError(400, `Malformed ${what}.`);
  return value;
}

/** POST /api/file with { action: 'put' | 'get' | 'delete', fileId, ... }. */
export async function fileAction(repo: Repo, accountId: string, body: unknown): Promise<unknown> {
  const b = obj(body);
  const id = fileId(b.fileId);
  switch (b.action) {
    case 'put': {
      const count = integer(b.count, 1, MAX_CHUNKS, 'chunk count');
      const index = integer(b.index, 0, count - 1, 'chunk number');
      if (typeof b.nonce !== 'string' || !B64.test(b.nonce) || b.nonce.length > 64) throw new HttpError(400, 'Files must be encrypted.');
      if (typeof b.ct !== 'string' || !B64.test(b.ct) || b.ct.length > MAX_CT_CHARS) throw new HttpError(400, 'Malformed or too large file chunk.');
      const owner = await repo.fileOwner(id);
      if (owner && owner !== accountId) throw new HttpError(403, 'That file belongs to someone else.');
      if (!owner && (await repo.fileCharsOf(accountId)) + b.ct.length * (count - index) > FILE_LIMITS.quotaChars) {
        throw new HttpError(413, 'Your files have reached the storage limit (200 MB). Delete some file blocks to make room.');
      }
      await repo.putFileChunk({ fileId: id, index, count, ownerId: accountId, nonce: b.nonce, ct: b.ct });
      return { ok: true };
    }
    case 'get': {
      const index = integer(b.index, 0, MAX_CHUNKS - 1, 'chunk number');
      const chunk = await repo.getFileChunk(id, index);
      if (!chunk) throw new HttpError(404, 'This file is no longer available. It may have been deleted, or not uploaded yet from the device that added it.');
      return { count: chunk.count, nonce: chunk.nonce, ct: chunk.ct };
    }
    case 'delete': {
      // Only the uploader's delete counts; for anyone else it quietly does nothing.
      if ((await repo.fileOwner(id)) === accountId) await repo.deleteFile(id);
      return { ok: true };
    }
    default:
      throw new HttpError(400, 'Unknown file action.');
  }
}

// ---- In-memory implementation (development and tests) ----

export function memoryFileRepo(): FileRepo {
  const chunks = new Map<string, FileChunk>();
  const key = (fileId: string, index: number) => `${fileId}/${index}`;
  return {
    async putFileChunk(c) { chunks.set(key(c.fileId, c.index), { ...c }); },
    getFileChunk: async (fileId, index) => { const c = chunks.get(key(fileId, index)); return c ? { ...c } : null; },
    fileOwner: async fileId => [...chunks.values()].find(c => c.fileId === fileId)?.ownerId ?? null,
    fileCharsOf: async ownerId => [...chunks.values()].filter(c => c.ownerId === ownerId).reduce((n, c) => n + c.ct.length, 0),
    async deleteFile(fileId) { for (const [k, c] of chunks) if (c.fileId === fileId) chunks.delete(k); },
  };
}
