import { describe, expect, it } from 'vitest';
import {
  choiceUsage, cleanOptionLabel, normalizeBlock, normalizeNote, noteToPlainText, removeChoice, renameChoice, searchableText, setColumnType,
  splitChoices, tableBlock, tableColumns, TABLE_LIMITS, type TableBlock,
} from '../src/model';

describe('table blocks', () => {
  it('creates an empty 3 × 3 table with a header row', () => {
    const t = tableBlock();
    expect(t.header).toBe(true);
    expect(t.rows).toEqual([['', '', ''], ['', '', ''], ['', '', '']]);
  });

  it('survives storage and makes ragged or hostile data rectangular', () => {
    expect(normalizeBlock(JSON.parse(JSON.stringify(tableBlock(2, 4))))).toMatchObject({ type: 'table', header: true, rows: [['', '', '', ''], ['', '', '', '']] });
    const t = normalizeBlock({ id: 't', type: 'table', rows: [['a'], ['b', 'c', 7], 'not a row', [null, 'd']] }) as TableBlock;
    expect(t.rows).toEqual([['a', '', ''], ['b', 'c', ''], ['', 'd', '']]);
    expect(t.header).toBe(false);
    expect((normalizeBlock({ type: 'table' }) as TableBlock).rows).toEqual([['']]);
    const huge = normalizeBlock({ type: 'table', rows: Array.from({ length: 500 }, () => Array(50).fill('x')) }) as TableBlock;
    expect(huge.rows.length).toBe(TABLE_LIMITS.rows);
    expect(huge.rows[0]!.length).toBe(TABLE_LIMITS.cols);
  });

  it('is searchable and shown as text on sticky cards', () => {
    const note = normalizeNote({ id: 'n', title: 'Accounts', blocks: [{ type: 'table', header: true, rows: [['Site', 'User'], ['Gmail', 'albert\n2nd line']] }] })!;
    expect(searchableText(note)).toContain('gmail');
    expect(noteToPlainText(note)).toBe('| Site | User |\n| Gmail | albert 2nd line |');
  });
});

describe('table columns: select, status and multi-select', () => {
  const sample = (): TableBlock => ({
    id: 't', type: 'table', header: true,
    rows: [['Task', 'Owner', 'Tags'], ['Pay rent', 'Ann', 'home, money'], ['Fix bike', 'Bob', 'home'], ['Taxes', 'Ann', 'money, urgent']],
  });

  it('turns a text column into a dropdown, making its values the options', () => {
    const t = sample();
    setColumnType(t, 1, 'select');
    expect(tableColumns(t)[1]!.options.map(o => o.label)).toEqual(['Ann', 'Bob']);
    expect(new Set(tableColumns(t)[1]!.options.map(o => o.color)).size).toBe(2); // different colours
    setColumnType(t, 2, 'multi');
    expect(tableColumns(t)[2]!.options.map(o => o.label)).toEqual(['home', 'money', 'urgent']);
    expect(t.rows.map(r => r[2])).toEqual(['Tags', 'home, money', 'home', 'money, urgent']); // the header row is left alone
  });

  it('gives a new Status column Not started / In progress / Done', () => {
    const t = sample();
    t.rows = t.rows.map(r => [...r, '']);
    setColumnType(t, 3, 'status');
    expect(tableColumns(t)[3]).toMatchObject({ type: 'status', options: [{ label: 'Not started' }, { label: 'In progress' }, { label: 'Done' }] });
  });

  it('keeps the first tag when a multi-select becomes single-choice, and the text when it becomes text', () => {
    const t = sample();
    setColumnType(t, 2, 'multi');
    setColumnType(t, 2, 'select');
    expect(t.rows.map(r => r[2])).toEqual(['Tags', 'home', 'home', 'money']);
    setColumnType(t, 2, 'text');
    expect(t.rows.map(r => r[2])).toEqual(['Tags', 'home', 'home', 'money']);
    expect(tableColumns(t)[2]!.options.length).toBe(3); // kept, in case it is switched back
  });

  it('renames and deletes options in every cell, and counts their use', () => {
    const t = sample();
    setColumnType(t, 2, 'multi');
    expect(choiceUsage(t, 2, 'home')).toBe(2);
    renameChoice(t, 2, 'home', 'house');
    expect(t.rows.map(r => r[2])).toEqual(['Tags', 'house, money', 'house', 'money, urgent']);
    removeChoice(t, 2, 'money');
    expect(t.rows.map(r => r[2])).toEqual(['Tags', 'house', 'house', 'urgent']);
    setColumnType(t, 1, 'select');
    renameChoice(t, 1, 'Ann', 'Anna');
    removeChoice(t, 1, 'Bob');
    expect(t.rows.map(r => r[1])).toEqual(['Owner', 'Anna', '', 'Anna']);
  });

  it('keeps option labels to one line without commas, and survives storage', () => {
    expect(cleanOptionLabel('  Waiting,\n on   them ')).toBe('Waiting on them');
    expect(splitChoices('a, b,, c ')).toEqual(['a', 'b', 'c']);
    const t = sample();
    setColumnType(t, 2, 'multi');
    const stored = normalizeBlock(JSON.parse(JSON.stringify(t))) as TableBlock;
    expect(stored.columns).toEqual(t.columns);
    // Older pages have no column types; bad ones are repaired.
    expect((normalizeBlock({ type: 'table', rows: [['a']] }) as TableBlock).columns).toBeUndefined();
    const repaired = normalizeBlock({
      type: 'table', rows: [['a', 'b']],
      columns: [{ type: 'bogus', options: [{ label: 'x' }] }, { type: 'multi', options: [{ id: '1', label: 'A', color: 'teal' }, { id: '2', label: 'a' }, { label: '' }] }],
    }) as TableBlock;
    expect(repaired.columns).toEqual([
      { type: 'text', options: [{ id: expect.any(String), label: 'x', color: 'gray' }] },
      { type: 'multi', options: [{ id: '1', label: 'A', color: 'gray' }] },
    ]);
    // Values stay text everywhere: search and plain text see the labels.
    expect(searchableText({ ...normalizeNote({ id: 'n', title: 'T', blocks: [t] })! })).toContain('money, urgent');
  });
});
