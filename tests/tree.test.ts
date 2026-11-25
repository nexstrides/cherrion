import { describe, expect, it } from 'vitest';
import { normalizeNote, type Note } from '../src/model';
import { buildTree, countDescendants, keyboardMove, planMove, type MoveChange } from '../src/tree';

const note = (id: string, parentId: string | null = null, extra: Partial<Note> = {}): Note =>
  ({ ...normalizeNote({ id, title: id.toUpperCase(), parentId })!, ...extra });

/** Applies changes and returns the display order as "parent > child" paths. */
function apply(notes: Note[], changes: MoveChange[] | null): Note[] {
  expect(changes).not.toBeNull();
  return notes.map(n => {
    const c = changes!.find(x => x.id === n.id);
    return c ? { ...n, parentId: c.parentId, order: c.order } : n;
  });
}
function outline(notes: Note[]): string[] {
  const tree = buildTree(notes);
  const out: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const n of tree.children.get(parent) ?? []) { out.push(`${'  '.repeat(depth)}${n.id}`); walk(n.id, depth + 1); }
  };
  walk(null, 0);
  return out;
}

describe('buildTree', () => {
  it('sorts manually ordered notes first, then the rest by title', () => {
    const notes = [note('c'), note('a'), note('b', null, { order: 2048 }), note('d', null, { order: 1024 })];
    expect(outline(notes)).toEqual(['d', 'b', 'a', 'c']);
  });

  it('shows orphans at the top level and breaks parent cycles', () => {
    const notes = [note('orphan', 'gone'), note('x', 'y'), note('y', 'x'), note('self', 'self')];
    const tree = buildTree(notes);
    expect(tree.parentOf.get('orphan')).toBeNull();
    expect(tree.parentOf.get('self')).toBeNull();
    expect([tree.parentOf.get('x'), tree.parentOf.get('y')].filter(p => p === null)).toHaveLength(1);
    expect(outline(notes)).toHaveLength(4);
  });
});

describe('planMove', () => {
  const base = () => [note('a'), note('b'), note('c'), note('a1', 'a'), note('a2', 'a')];

  it('nests a note inside another, at the end of its children', () => {
    expect(outline(apply(base(), planMove(base(), 'c', 'a', 'inside')))).toEqual(['a', '  a1', '  a2', '  c', 'b']);
  });

  it('reorders before and after a sibling', () => {
    expect(outline(apply(base(), planMove(base(), 'c', 'a', 'before')))).toEqual(['c', 'a', '  a1', '  a2', 'b']);
    expect(outline(apply(base(), planMove(base(), 'a2', 'a1', 'before')))).toEqual(['a', '  a2', '  a1', 'b', 'c']);
  });

  it('moves a child out to the top level', () => {
    expect(outline(apply(base(), planMove(base(), 'a1', 'b', 'after')))).toEqual(['a', '  a2', 'b', 'a1', 'c']);
    expect(outline(apply(base(), planMove(base(), 'a1', null, 'inside')))).toEqual(['a', '  a2', 'b', 'c', 'a1']);
  });

  it('refuses to drop a note onto itself or into its own subtree', () => {
    expect(planMove(base(), 'a', 'a', 'inside')).toBeNull();
    expect(planMove(base(), 'a', 'a1', 'inside')).toBeNull();
    expect(planMove(base(), 'a', 'a1', 'before')).toBeNull();
    expect(planMove(base(), 'missing', 'a', 'inside')).toBeNull();
  });

  it('only changes notes whose position actually changes', () => {
    const ordered = apply(base(), planMove(base(), 'c', 'b', 'after'));
    expect(planMove(ordered, 'c', 'b', 'after')).toEqual([]);
  });
});

describe('keyboardMove', () => {
  const base = () => [note('a'), note('b'), note('b1', 'b')];

  it('Alt+Up/Down reorders, Alt+Right nests under the previous sibling, Alt+Left moves out', () => {
    expect(outline(apply(base(), keyboardMove(base(), 'b', 'ArrowUp')))).toEqual(['b', '  b1', 'a']);
    expect(outline(apply(base(), keyboardMove(base(), 'a', 'ArrowDown')))).toEqual(['b', '  b1', 'a']);
    expect(outline(apply(base(), keyboardMove(base(), 'b', 'ArrowRight')))).toEqual(['a', '  b', '    b1']);
    expect(outline(apply(base(), keyboardMove(base(), 'b1', 'ArrowLeft')))).toEqual(['a', 'b', 'b1']);
  });

  it('does nothing at the edges', () => {
    expect(keyboardMove(base(), 'a', 'ArrowUp')).toBeNull();
    expect(keyboardMove(base(), 'a', 'ArrowRight')).toBeNull();
    expect(keyboardMove(base(), 'a', 'ArrowLeft')).toBeNull();
  });
});

it('counts descendants for delete confirmations', () => {
  expect(countDescendants([note('a'), note('a1', 'a'), note('a1x', 'a1'), note('b')], 'a')).toBe(2);
});
