import { beforeAll, describe, expect, it } from 'vitest';
import { initCrypto } from '../src/crypto';
import { field, fieldsBlock, normalizeNote, tableBlock, textBlock, type Note } from '../src/model';
import {
  collectPages, exportPageFile, markdownToPages, pagesFromFile, pagesToMarkdown, prepareImport, readPageFile,
  WrongPagePasswordError,
} from '../src/transfer';

const FAST = { opslimit: 1, memlimit: 8192 };
beforeAll(() => initCrypto());

function sample(): Note[] {
  const pw = field('Password', 'password'); pw.value = 'hunter2!';
  const user = field('Username'); user.value = 'albert';
  const table = tableBlock(2, 2); table.rows = [['Site', 'User'], ['Gmail', 'a|b']];
  const root = normalizeNote({ id: 'root', title: 'Accounts', blocks: [fieldsBlock([user, pw]), table, { id: 'l', type: 'page', pageId: 'child' }] })!;
  const child = normalizeNote({ id: 'child', parentId: 'root', title: 'Gmail', blocks: [textBlock('todo', 'rotate password'), textBlock('code', 'a\nb')] })!;
  const other = normalizeNote({ id: 'other', title: 'Elsewhere', blocks: [] })!;
  const gone = normalizeNote({ id: 'gone', parentId: 'root', title: 'Deleted', deleted: true, blocks: [] })!;
  return [root, child, other, gone];
}

describe('choosing pages', () => {
  it('takes the page and its live sub-pages, or the page alone', () => {
    expect(collectPages(sample(), 'root').map(p => p.id)).toEqual(['root', 'child']);
    expect(collectPages(sample(), 'root', false).map(p => p.id)).toEqual(['root']);
  });
});

describe('.cherrion-page files', () => {
  it('round-trips with a password, and the file does not contain the secrets', () => {
    const pages = collectPages(sample(), 'root');
    const text = exportPageFile(pages, 'root', 'file password', FAST);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('Accounts');
    const file = readPageFile(text);
    expect(file.encrypted).toBe(true);
    expect(() => pagesFromFile(file, 'wrong')).toThrow(WrongPagePasswordError);
    expect(pagesFromFile(file, 'file password').pages.map(p => p.title)).toEqual(['Accounts', 'Gmail']);
  });

  it('can be saved without a password (readable, no password needed to import)', () => {
    const text = exportPageFile(collectPages(sample(), 'root'), 'root');
    expect(text).toContain('hunter2');
    const file = readPageFile(text);
    expect(file.encrypted).toBe(false);
    expect(pagesFromFile(file).rootId).toBe('root');
  });

  it('rejects other files', () => {
    expect(() => readPageFile('hello')).toThrow('not a Cherrion page file');
    expect(() => readPageFile('{"format":"cherrion-backup"}')).toThrow('not a Cherrion page file');
  });

  it('imports with fresh ids, keeping the hierarchy and links between imported pages', () => {
    const payload = pagesFromFile(readPageFile(exportPageFile(collectPages(sample(), 'root'), 'root')));
    const imported = prepareImport(payload, 'target');
    const [root, child] = imported;
    expect(root!.id).not.toBe('root');
    expect(root!.parentId).toBe('target');
    expect(child!.parentId).toBe(root!.id);
    const link = root!.blocks.find(b => b.type === 'page');
    expect(link?.type === 'page' && link.pageId).toBe(child!.id);
    expect(new Set(imported.flatMap(p => p.blocks.map(b => b.id))).size).toBe(imported.reduce((n, p) => n + p.blocks.length, 0));
  });
});

describe('Markdown', () => {
  it('exports readable Markdown with secrets masked unless asked for', () => {
    const pages = collectPages(sample(), 'root');
    const titleOf = (id: string) => pages.find(p => p.id === id)?.title ?? 'Untitled';
    const md = pagesToMarkdown(pages, { includeSecrets: false, titleOf });
    expect(md).toContain('# Accounts\n');
    expect(md).toContain('# Accounts / Gmail\n');
    expect(md).toContain('- **Username:** albert');
    expect(md).toContain('- **Password:** ••••••••');
    expect(md).not.toContain('hunter2');
    expect(md).toContain('| Site | User |\n| --- | --- |\n| Gmail | a\\|b |');
    expect(md).toContain('- [ ] rotate password');
    expect(md).toContain('```\na\nb\n```');
    expect(pagesToMarkdown(pages, { includeSecrets: true, titleOf })).toContain('- **Password:** hunter2!');
  });

  it('imports Markdown back into pages and blocks', () => {
    const pages = collectPages(sample(), 'root');
    const md = pagesToMarkdown(pages, { includeSecrets: true, titleOf: () => 'Gmail' });
    const { rootId, pages: back } = markdownToPages(md, 'file');
    expect(back.map(p => p.title)).toEqual(['Accounts', 'Gmail']);
    expect(back[1]!.parentId).toBe(rootId);
    const fields = back[0]!.blocks.find(b => b.type === 'fields');
    expect(fields?.type === 'fields' && fields.fields.map(f => [f.label, f.kind, f.value])).toEqual([['Username', 'text', 'albert'], ['Password', 'password', 'hunter2!']]);
    const table = back[0]!.blocks.find(b => b.type === 'table');
    expect(table?.type === 'table' && table.rows).toEqual([['Site', 'User'], ['Gmail', 'a|b']]);
    expect(back[1]!.blocks.map(b => b.type)).toEqual(['todo', 'code']);
  });

  it('turns plain text into a page named after the file', () => {
    const { pages } = markdownToPages('first line\nsecond line\n\n> a quote\n- [x] done', 'notes');
    expect(pages[0]!.title).toBe('notes');
    expect(pages[0]!.blocks.map(b => b.type)).toEqual(['p', 'quote', 'todo']);
  });
});
