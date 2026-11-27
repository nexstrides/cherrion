// File attachments, client side. A file is encrypted here with its own random key, in chunks of up
// to 2 MB, each bound to its file id, position and count. The key goes into the file block inside
// the (encrypted) page; the chunks go to storage: the server on the website, and the vault file
// plus the server in the desktop app (see desktop/session.ts). Content is only fetched to download.
import { api } from './api';
import { DecryptError, fromB64, open, randomKey, seal, toB64, wipe, type Sealed } from './crypto';
import { FILE_LIMITS, FILE_TYPES, fileExtension, uid, type FileBlock } from './model';

const chunkAad = (fileId: string, index: number, count: number) => `cherrion/file/v1/${fileId}/${index}/${count}`;

/** Where encrypted chunks live. */
export interface FileStorage {
  /** Stores a new file's chunks; resolves once they are safe (uploaded, or saved in the vault file). */
  save(fileId: string, chunks: Sealed[]): Promise<void>;
  load(fileId: string, index: number, count: number): Promise<Sealed>;
  /** Deletes a file this account added (best effort: someone else's file is left alone). */
  remove(fileId: string): Promise<void>;
}

/** The website: chunks go straight to the server. */
export const serverFiles: FileStorage = {
  async save(fileId, chunks) {
    for (const [index, c] of chunks.entries()) {
      await api.file({ action: 'put', fileId, index, count: chunks.length, nonce: c.nonce, ct: c.ct });
    }
  },
  async load(fileId, index) {
    const data = await api.file({ action: 'get', fileId, index });
    if (typeof data.nonce !== 'string' || typeof data.ct !== 'string') throw new Error('The server sent a damaged file.');
    return { nonce: data.nonce, ct: data.ct };
  },
  async remove(fileId) {
    await api.file({ action: 'delete', fileId });
  },
};

let storage: FileStorage = serverFiles;
/** The desktop app stores chunks in the vault file too; null goes back to the server only. */
export const setFileStorage = (s: FileStorage | null): void => { storage = s ?? serverFiles; };

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Why a file cannot be attached, or null. */
export function fileProblem(file: { name: string; size: number }): string | null {
  const ext = fileExtension(file.name);
  if (!(FILE_TYPES as readonly string[]).includes(ext)) {
    return `“${file.name}” can’t be attached: ${ext ? `.${ext} files are` : 'files without a type are'} not supported. Documents, spreadsheets, text, archives (ZIP…) and pictures are.`;
  }
  if (file.size > FILE_LIMITS.maxBytes) return `“${file.name}” is ${formatBytes(file.size)}. Files can be up to 10 MB.`;
  return null;
}

/** Encrypts and stores a file; returns the block to put in the page. */
export async function attachFile(file: File): Promise<FileBlock> {
  const problem = fileProblem(file);
  if (problem) throw new Error(problem);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > FILE_LIMITS.maxBytes) throw new Error(`“${file.name}” is larger than 10 MB.`);
  const fileId = crypto.randomUUID();
  const key = randomKey();
  try {
    const count = Math.max(1, Math.ceil(bytes.length / FILE_LIMITS.chunkBytes));
    const chunks: Sealed[] = [];
    for (let i = 0; i < count; i++) {
      chunks.push(seal(key, bytes.subarray(i * FILE_LIMITS.chunkBytes, (i + 1) * FILE_LIMITS.chunkBytes), chunkAad(fileId, i, count)));
    }
    await storage.save(fileId, chunks);
    return {
      id: uid(), type: 'file', fileId, name: file.name.replace(/[\\/]/g, '_').slice(0, 255), size: bytes.length,
      mime: (file.type || 'application/octet-stream').slice(0, 100), chunks: count, key: toB64(key), note: '',
    };
  } finally {
    wipe(key);
  }
}

/** Fetches (from wherever it is stored) and decrypts a file. */
export async function openFile(block: FileBlock): Promise<Uint8Array> {
  const key = fromB64(block.key);
  try {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < block.chunks; i++) {
      const sealed = await storage.load(block.fileId, i, block.chunks);
      try {
        parts.push(open(key, sealed, chunkAad(block.fileId, i, block.chunks)));
      } catch (err) {
        if (err instanceof DecryptError) throw new Error(`“${block.name}” is damaged and cannot be opened.`);
        throw err;
      }
    }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    if (out.length !== block.size) throw new Error(`“${block.name}” is incomplete and cannot be opened.`);
    return out;
  } finally {
    wipe(key);
  }
}

/** Deletes a file that no page shows any more (best effort). */
export async function releaseFile(fileId: string): Promise<void> {
  try { await storage.remove(fileId); } catch (err) { console.warn('Could not delete an attached file', err); }
}

/** A colour emoji for the file type (all with emoji presentation, so they render in colour on Windows). */
export function fileIcon(name: string): string {
  const ext = fileExtension(name);
  if (ext === 'pdf') return '📕';
  if (['doc', 'docx', 'odt', 'rtf'].includes(ext)) return '📘';
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return '📗';
  if (['ppt', 'pptx', 'odp'].includes(ext)) return '📙';
  if (['zip', '7z', 'rar', 'gz', 'tgz', 'tar', 'bz2', 'xz'].includes(ext)) return '📦';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'svg'].includes(ext)) return '🖼️';
  if (['mp3', 'm4a', 'wav'].includes(ext)) return '🎵';
  if (['mp4', 'mov'].includes(ext)) return '🎬';
  if (['pem', 'crt', 'key', 'ovpn', 'kdbx'].includes(ext)) return '🔐';
  return '📄';
}
