import { describe, expect, it } from 'vitest';
import {
  isPlainTextEditable, isSecretKind, noteToPlainText, normalizeNote, SECRET_MASK, searchableText,
  type Block, type FieldsBlock, type Note,
} from '../src/model';
import { CATEGORIES, createNoteFromTemplate, TEMPLATES } from '../src/templates';

const byId = (id: string) => TEMPLATES.find(t => t.id === id)!;
const fieldsOf = (note: Note) => note.blocks.filter((b): b is FieldsBlock => b.type === 'fields').flatMap(b => b.fields);

describe('templates', () => {
  it('offers blank, email, login, proxy, secure and meeting templates, each with a known category', () => {
    expect(TEMPLATES.map(t => t.id)).toEqual(['blank', 'email', 'login', 'card', 'bank', 'proxy', 'secure', 'meeting']);
    for (const t of TEMPLATES) expect(CATEGORIES[t.category]).toBeDefined();
  });

  it('builds the email account field group with secrets marked', () => {
    const note = createNoteFromTemplate(byId('email'), null);
    expect(note.category).toBe('email');
    const fields = fieldsOf(note);
    expect(fields.map(f => f.label)).toEqual([
      'Email address', 'Password', '2FA code', 'Recovery email', 'Recovery phone', '2-Step Verification', 'Backup codes',
    ]);
    expect(fields.filter(f => isSecretKind(f.kind)).map(f => f.label)).toEqual(['Password', '2FA code', 'Backup codes']);
  });

  it('builds website login and secure note templates', () => {
    expect(fieldsOf(createNoteFromTemplate(byId('login'), null)).map(f => [f.label, f.kind])).toEqual([
      ['Site URL', 'url'], ['Username', 'text'], ['Password', 'password'], ['2FA code', 'totp'],
    ]);
    const secure = createNoteFromTemplate(byId('secure'), 'parent-1');
    expect(secure.parentId).toBe('parent-1');
    expect(fieldsOf(secure).map(f => f.kind)).toEqual(['secret-text']);
  });

  it("prefills the meeting date with today's date", () => {
    const date = fieldsOf(createNoteFromTemplate(byId('meeting'), null))[0]!;
    expect(date.kind).toBe('date');
    expect(date.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${date.value}T00:00`).toDateString()).toBe(new Date().toDateString());
  });

  it('gives every note, block and field a fresh id', () => {
    const a = createNoteFromTemplate(byId('email'), null);
    const b = createNoteFromTemplate(byId('email'), null);
    const ids = [a, b].flatMap(n => [n.id, ...n.blocks.map(x => x.id), ...fieldsOf(n).map(f => f.id)]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('secret handling in plain-text views', () => {
  const note = createNoteFromTemplate(byId('email'), null);
  const fields = fieldsOf(note);
  fields[0]!.value = 'me@gmail.com';
  fields[1]!.value = 'hunter2-super-secret';

  it('masks secret values and skips empty fields when rendering a note as plain text', () => {
    fields[2]!.value = 'JBSWY3DPEHPK3PXP';
    const text = noteToPlainText(note);
    expect(text).toContain('Email address: me@gmail.com');
    expect(text).toContain(`Password: ${SECRET_MASK}`);
    expect(text).toContain(`2FA code: ${SECRET_MASK}`);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('JBSWY3DP');
    expect(text).not.toContain('Recovery phone');
    expect(text).not.toContain('Backup codes');
  });

  it('keeps secret values out of search', () => {
    expect(searchableText(note)).toContain('me@gmail.com');
    expect(searchableText(note)).not.toContain('hunter2');
  });

  it('only lets sticky views edit notes made of paragraphs and to-dos', () => {
    expect(isPlainTextEditable(note)).toBe(false);
    const simple: Note = { ...note, blocks: [{ id: 'a', type: 'p', content: 'x' }, { id: 'b', type: 'todo', content: 'y', checked: true }] };
    expect(isPlainTextEditable(simple)).toBe(true);
  });
});

describe('normalizeNote', () => {
  it('upgrades a note from the original plaintext format', () => {
    const legacy = {
      id: 'abc', parentId: null, title: 'Old', collapsed: false, isSticky: true, stickyColor: 'blue',
      updatedAt: 123, deleted: false, blocks: [{ id: 'b1', type: 'todo', content: 'task', checked: true }],
    };
    const note = normalizeNote(legacy)!;
    expect(note.category).toBe('note');
    expect(note.stickyColor).toBe('blue');
    expect(note.blocks).toEqual<Block[]>([{ id: 'b1', type: 'todo', content: 'task', checked: true }]);
  });

  it('repairs or drops malformed data', () => {
    const note = normalizeNote({ id: 'x', blocks: [{ type: 'bogus' }, 'junk', { type: 'fields', fields: [{ kind: 'evil' }] }], stickyColor: 'toString' })!;
    expect(note.stickyColor).toBe('yellow');
    expect(note.blocks).toHaveLength(1);
    expect((note.blocks[0] as FieldsBlock).fields[0]!.kind).toBe('text');
    expect(normalizeNote({ id: '' })).toBeNull();
    expect(normalizeNote({ id: '__vault__' })).toBeNull();
    expect(normalizeNote('nope')).toBeNull();
  });

  it('gives an empty live note one paragraph but leaves tombstones empty', () => {
    expect(normalizeNote({ id: 'a', blocks: [] })!.blocks).toHaveLength(1);
    expect(normalizeNote({ id: 'a', deleted: true, blocks: [] })!.blocks).toHaveLength(0);
  });
});
