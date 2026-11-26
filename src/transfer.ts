// Export and import of single pages (with their sub-pages), independent of any vault:
//
//   .cherrion-page  JSON. Lossless (every block type, secrets, 2FA). Optionally encrypted with its own
//                   password (Argon2id + XChaCha20-Poly1305); without one it is readable plaintext.
//   .md             Markdown for reading anywhere. Secret values are masked unless asked for.
//
// Imported pages always get fresh ids, so an import can never overwrite or resurrect existing notes.
import { DEFAULT_KDF_COST, deriveKey, newKdfParams, open, seal, wipe, type KdfParams, type Sealed } from './crypto';
import {
  field, fieldsBlock, isSecretKind, normalizeBlock, normalizeNote, now, SECRET_MASK, textBlock, uid,
  type Block, type Field, type FieldKind, type Note, type TableBlock,
} from './model';
import { isKdfParams, isSealed } from './shapes';

export const PAGE_FILE_EXT = '.cherrion-page';
const AAD = 'cherrion/page-export/v1';

interface Payload { rootId: string; pages: Note[] }
interface PlainFile { format: 'cherrion-page'; v: 1; exportedAt: number; encrypted: false; rootId: string; pages: unknown[] }
interface LockedFile { format: 'cherrion-page'; v: 1; exportedAt: number; encrypted: true; kdf: KdfParams; data: Sealed }
export type PageFile = PlainFile | LockedFile;

export class WrongPagePasswordError extends Error {
  constructor() { super('Wrong password for this file.'); this.name = 'WrongPagePasswordError'; }
}

// ---- Choosing what to export ----

/** The page and (optionally) all its sub-pages, parents before children. Deleted pages are skipped. */
export function collectPages(all: Note[], rootId: string, withSubPages = true): Note[] {
  const live = all.filter(n => !n.deleted);
  const root = live.find(n => n.id === rootId);
  if (!root) return [];
  const out = [root];
  const seen = new Set([root.id]);
  for (let i = 0; withSubPages && i < out.length; i++) {
    for (const n of live) {
      if (n.parentId === out[i]!.id && !seen.has(n.id)) { seen.add(n.id); out.push(n); }
    }
  }
  return out;
}

// ---- .cherrion-page files ----

export function exportPageFile(pages: Note[], rootId: string, password?: string, cost = DEFAULT_KDF_COST): string {
  const base = { format: 'cherrion-page' as const, v: 1 as const, exportedAt: now() };
  if (!password) {
    const file: PlainFile = { ...base, encrypted: false, rootId, pages };
    return JSON.stringify(file, null, 2);
  }
  const kdf = newKdfParams(cost);
  const key = deriveKey(password, kdf);
  try {
    const payload: Payload = { rootId, pages };
    const file: LockedFile = { ...base, encrypted: true, kdf, data: seal(key, JSON.stringify(payload), AAD) };
    return JSON.stringify(file);
  } finally {
    wipe(key);
  }
}

/** Parses a page file (throws if it is not one). Check `encrypted` to know whether a password is needed. */
export function readPageFile(text: string): PageFile {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('That is not a Cherrion page file.'); }
  const f = raw as Partial<PageFile> | null;
  if (!f || typeof f !== 'object' || f.format !== 'cherrion-page' || f.v !== 1) throw new Error('That is not a Cherrion page file.');
  if (f.encrypted === true && isKdfParams(f.kdf) && isSealed(f.data)) return f as LockedFile;
  if (f.encrypted === false && typeof f.rootId === 'string' && Array.isArray(f.pages)) return f as PlainFile;
  throw new Error('This Cherrion page file is damaged.');
}

/** The pages in a file (decrypting it with `password` when it is protected). */
export function pagesFromFile(file: PageFile, password = ''): Payload {
  let payload: { rootId?: unknown; pages?: unknown };
  if (file.encrypted) {
    const key = deriveKey(password, file.kdf);
    try {
      payload = JSON.parse(new TextDecoder().decode(open(key, file.data, AAD))) as typeof payload;
    } catch {
      throw new WrongPagePasswordError();
    } finally {
      wipe(key);
    }
  } else {
    payload = file;
  }
  const pages = (Array.isArray(payload.pages) ? payload.pages : []).map(normalizeNote).filter((n): n is Note => n !== null);
  const rootId = typeof payload.rootId === 'string' && pages.some(p => p.id === payload.rootId) ? payload.rootId : pages[0]?.id;
  if (!rootId) throw new Error('This file has no pages.');
  return { rootId, pages };
}

/**
 * Gives every page, block and field a new id, keeps the hierarchy (and links between the imported
 * pages), and hangs the top page under `parentId`. The result is ready for store.addNote.
 */
export function prepareImport({ rootId, pages }: Payload, parentId: string | null): Note[] {
  const ids = new Map(pages.map(p => [p.id, uid()]));
  const t = now();
  return pages.map(p => ({
    ...p,
    id: ids.get(p.id)!,
    parentId: p.id === rootId ? parentId : ids.get(p.parentId ?? '') ?? ids.get(rootId)!,
    order: p.id === rootId ? undefined : p.order,
    deleted: false,
    updatedAt: t,
    blocks: p.blocks.map(b => rekeyBlock(b, ids)),
  }));
}

function rekeyBlock(b: Block, ids: Map<string, string>): Block {
  const copy = structuredClone(b);
  copy.id = uid();
  if (copy.type === 'fields') copy.fields = copy.fields.map(f => ({ ...f, id: uid() }));
  if (copy.type === 'page') copy.pageId = ids.get(copy.pageId) ?? copy.pageId;
  return copy;
}

// ---- Markdown export ----

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

function tableToMarkdown(t: TableBlock): string[] {
  const cols = t.rows[0]?.length ?? 0;
  if (!cols) return [];
  const row = (r: string[]) => `| ${r.map(cell).join(' | ')} |`;
  const [first = [], ...rest] = t.rows;
  // Markdown tables always have a header row; a table without one gets an empty header.
  const head = t.header ? first : Array<string>(cols).fill('');
  const body = t.header ? rest : t.rows;
  return [row(head), `| ${Array(cols).fill('---').join(' | ')} |`, ...body.map(row)];
}

function blockToMarkdown(b: Block, opts: { includeSecrets: boolean; titleOf: (id: string) => string }): string[] {
  switch (b.type) {
    case 'p': return b.content ? b.content.split('\n') : [];
    case 'h1': return [`## ${b.content}`];
    case 'h2': return [`### ${b.content}`];
    case 'todo': return [`- [${b.checked ? 'x' : ' '}] ${b.content}`];
    case 'callout': return b.content.split('\n').map((l, i) => `> ${i === 0 ? '💡 ' : ''}${l}`);
    case 'quote': return b.content.split('\n').map(l => `> ${l}`);
    case 'code': return ['```', ...b.content.split('\n'), '```'];
    case 'divider': return ['---'];
    case 'page': return [`- 📄 [[${opts.titleOf(b.pageId)}]]`];
    case 'table': return tableToMarkdown(b);
    case 'image': return [`![${b.caption.replace(/[[\]\n]/g, ' ')}](${b.src})`];
    case 'fields':
      return b.fields.flatMap(f => {
        const value = isSecretKind(f.kind) && !opts.includeSecrets ? (f.value ? SECRET_MASK : '') : f.value;
        const [first = '', ...more] = value.split('\n');
        return [`- **${f.label || 'Field'}:** ${first}`.trimEnd(), ...more.map(l => `  ${l}`)];
      });
  }
}

/** Markdown for the pages; sub-pages get "Parent / Child" titles so the hierarchy can be rebuilt. */
export function pagesToMarkdown(pages: Note[], opts: { includeSecrets: boolean; titleOf: (id: string) => string }): string {
  const byId = new Map(pages.map(p => [p.id, p]));
  const path = (p: Note): string => {
    const names: string[] = [];
    for (let cur: Note | undefined = p, guard = 0; cur && guard < 50; cur = byId.get(cur.parentId ?? ''), guard++) {
      names.unshift(cur.title || 'Untitled');
    }
    return names.join(' / ');
  };
  const out: string[] = [];
  for (const p of pages) {
    if (out.length) out.push('');
    out.push(`# ${path(p)}`, '');
    for (const b of p.blocks) {
      const lines = blockToMarkdown(b, opts);
      if (lines.length) out.push(...lines, '');
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

// ---- Markdown import ----

function guessKind(label: string, value: string): FieldKind {
  const l = label.toLowerCase();
  if (value === SECRET_MASK || /password|passcode|secret|\bpin\b|backup codes?/.test(l)) return 'password';
  if (/e-?mail/.test(l) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'email';
  if (/^https?:\/\//i.test(value)) return 'url';
  return 'text';
}

const splitRow = (line: string) =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|').replace(/<br\s*\/?>/gi, '\n'));

/**
 * Turns Markdown (or plain text) into pages. "# A" starts a page; "# A / B" becomes B under A.
 * `fallbackTitle` names the first page when the text does not start with a "# " heading.
 */
export function markdownToPages(text: string, fallbackTitle: string): Payload {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const pages: Note[] = [];
  const byPath = new Map<string, Note>();
  let page: Note | null = null;

  const newPage = (title: string, parentId: string | null): Note => {
    const n = normalizeNote({ id: uid(), parentId, title, blocks: [], updatedAt: now() })!;
    n.blocks = []; // normalizeNote adds an empty paragraph; the parsed blocks come next
    pages.push(n);
    return n;
  };
  const current = (): Note => (page ??= newPage(fallbackTitle || 'Imported page', null));
  const push = (b: Block) => current().blocks.push(b);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;
    if (/^```/.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) body.push(lines[i]!);
      push(textBlock('code', body.join('\n')));
    } else if ((m = /^# (.+)$/.exec(line))) {
      const parts = m[1]!.split(' / ').map(s => s.trim()).filter(Boolean);
      const title = parts.pop() ?? 'Untitled';
      const parent = byPath.get(parts.join(' / ')) ?? (pages.length ? pages[0]! : null);
      page = newPage(title, parts.length || pages.length ? parent?.id ?? null : null);
      byPath.set([...parts, title].join(' / '), page);
    } else if ((m = /^#{3,6} (.+)$/.exec(line))) push(textBlock('h2', m[1]!));
    else if ((m = /^## (.+)$/.exec(line))) push(textBlock('h1', m[1]!));
    else if ((m = /^\s*[-*] \[( |x|X)\] ?(.*)$/.exec(line))) push({ ...textBlock('todo', m[2]!), checked: m[1] !== ' ' });
    else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) push({ id: uid(), type: 'divider' });
    else if (/^>/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && /^>/.test(lines[i]!); i++) body.push(lines[i]!.replace(/^> ?/, ''));
      i--;
      const callout = body[0]?.startsWith('💡');
      if (callout) body[0] = body[0]!.replace(/^💡\s*/, '');
      push(textBlock(callout ? 'callout' : 'quote', body.join('\n')));
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      let header = false;
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!); i++) {
        if (/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[i]!)) { header = rows.length === 1; continue; }
        rows.push(splitRow(lines[i]!));
      }
      i--;
      const cols = Math.max(1, ...rows.map(r => r.length));
      const grid = rows.map(r => [...r, ...Array<string>(cols - r.length).fill('')]);
      const headerEmpty = header && grid[0]!.every(c => !c);
      push({ id: uid(), type: 'table', header: header && !headerEmpty, rows: headerEmpty ? grid.slice(1) : grid });
    } else if (/^\s*[-*] \*\*(.+?):\*\*/.test(line)) {
      const fields: Field[] = [];
      for (; i < lines.length && (m = /^\s*[-*] \*\*(.+?):\*\*\s?(.*)$/.exec(lines[i]!)); i++) {
        const label = m[1]!;
        const more: string[] = [];
        while (i + 1 < lines.length && /^ {2}\S/.test(lines[i + 1]!)) more.push(lines[++i]!.slice(2));
        const value = [m[2]!.trim(), ...more].join('\n');
        const kind = guessKind(label, value);
        fields.push(field(label, kind === 'password' && more.length ? 'secret-text' : kind, {}));
        fields[fields.length - 1]!.value = value === SECRET_MASK ? '' : value;
      }
      i--;
      push(fieldsBlock(fields));
    } else if ((m = /^\s*[-*] 📄 \[\[(.*)\]\]\s*$/.exec(line))) push(textBlock('p', `📄 ${m[1]!}`));
    else if ((m = /^!\[([^\]]*)\]\((data:image\/[^)\s]+)\)\s*$/.exec(line))) {
      const image = normalizeBlock({ type: 'image', src: m[2], caption: m[1] });
      push(image ?? textBlock('p', `🖼 ${m[1] || 'Picture'} (picture could not be imported)`));
    }
    else if (line.trim()) {
      const body = [line];
      for (; i + 1 < lines.length && lines[i + 1]!.trim() && !/^(#|```|>|\s*[-*] |\s*\|)/.test(lines[i + 1]!); i++) body.push(lines[i + 1]!);
      push(textBlock('p', body.join('\n')));
    }
  }
  for (const p of pages) if (!p.blocks.length) p.blocks.push(textBlock());
  if (!pages.length) current().blocks.push(textBlock());
  return { rootId: pages[0]!.id, pages };
}
