import { describe, expect, it } from 'vitest';
import { normalizeNote, textBlock, type Note } from '../src/model';
import { applyForm, describeForm, formForCategory, hasForm } from '../src/templates';

const page = (blocks: Note['blocks']): Note => normalizeNote({ id: 'n', title: 'Page', blocks })!;

describe('category forms', () => {
  it('maps categories to their forms (plain notes have none)', () => {
    expect(formForCategory('note')).toBeNull();
    expect(formForCategory('email')?.id).toBe('email');
    expect(formForCategory('meeting')?.id).toBe('meeting');
  });

  it('has a Proxy form with its six fields, the link and password kept secret', () => {
    const proxy = formForCategory('proxy')!;
    const [group] = proxy.build();
    expect(group?.type).toBe('fields');
    const fields = group?.type === 'fields' ? group.fields : [];
    expect(fields.map(f => f.label)).toEqual(['Link', 'IP address', 'Port', 'User', 'Password', 'Note']);
    expect(fields.map(f => f.kind)).toEqual(['password', 'text', 'text', 'text', 'password', 'text']);
    expect(fields[0]?.hint).toBe('ip:port:user:password');
  });

  it('describes the fields and sections a form adds', () => {
    const email = describeForm(formForCategory('email')!).map(d => d.text);
    expect(email.slice(0, 3)).toEqual(['Email address', 'Password', '2FA code']);
    expect(email.at(-1)).toBe('Notes section');
  });

  it('fills a blank page with the form', () => {
    const note = page([textBlock()]);
    const first = applyForm(note, formForCategory('login')!);
    expect(note.blocks[0]).toBe(first);
    expect(note.blocks.map(b => b.type)).toEqual(['fields', 'h2', 'p']);
  });

  it('puts the form above existing content and removes nothing', () => {
    const note = page([textBlock('p', 'my old text')]);
    applyForm(note, formForCategory('login')!);
    expect(note.blocks.map(b => b.type)).toEqual(['fields', 'h2', 'p']);
    expect(note.blocks.at(-1)).toMatchObject({ content: 'my old text' });
  });

  it('knows when a page already has the form, so it is not offered twice', () => {
    const note = page([textBlock()]);
    const template = formForCategory('email')!;
    expect(hasForm(note, template)).toBe(false);
    applyForm(note, template);
    expect(hasForm(note, template)).toBe(true);
    expect(hasForm(note, formForCategory('meeting')!)).toBe(false);
  });
});
