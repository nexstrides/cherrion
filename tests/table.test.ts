import { describe, expect, it } from 'vitest';
import { normalizeBlock, normalizeNote, noteToPlainText, searchableText, tableBlock, TABLE_LIMITS, type TableBlock } from '../src/model';

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
