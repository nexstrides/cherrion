// Tree structure and moves (drag and drop, Alt+arrow keys). Pure functions over live notes.
import type { Note } from './model';

export type DropPosition = 'before' | 'after' | 'inside';
/** New parent and sibling position for one note. Apply with store.touchNote so it syncs. */
export interface MoveChange { id: string; parentId: string | null; order: number }
export interface Tree {
  /** Children per parent id (null = top level), sorted for display. */
  children: Map<string | null, Note[]>;
  /** Effective parent of every live note. */
  parentOf: Map<string, string | null>;
}

export const ORDER_STEP = 1024;

/** Manually ordered notes first (by order), then the rest by title. */
export function compareSiblings(a: Note, b: Note): number {
  const ao = a.order ?? Number.POSITIVE_INFINITY;
  const bo = b.order ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao < bo ? -1 : 1;
  return (a.title || 'Untitled').localeCompare(b.title || 'Untitled');
}

/**
 * Groups live notes by effective parent. A note whose parent is missing, deleted or itself is shown
 * at the top level, and parent cycles (possible after conflicting syncs) are broken at one note.
 */
export function buildTree(active: Note[]): Tree {
  const alive = new Set(active.map(n => n.id));
  const children = new Map<string | null, Note[]>();
  const parentOf = new Map<string, string | null>();
  const push = (key: string | null, n: Note) => {
    const list = children.get(key);
    if (list) list.push(n); else children.set(key, [n]);
    parentOf.set(n.id, key);
  };
  for (const n of active) push(n.parentId && n.parentId !== n.id && alive.has(n.parentId) ? n.parentId : null, n);

  const reachable = new Set<string>();
  const mark = (start: Note[]) => {
    const stack = [...start];
    while (stack.length) {
      const n = stack.pop()!;
      if (reachable.has(n.id)) continue;
      reachable.add(n.id);
      stack.push(...(children.get(n.id) ?? []));
    }
  };
  mark(children.get(null) ?? []);
  for (const n of active) {
    if (reachable.has(n.id)) continue;
    const old = parentOf.get(n.id) ?? null;
    children.set(old, (children.get(old) ?? []).filter(c => c.id !== n.id));
    push(null, n);
    mark([n]);
  }
  for (const list of children.values()) list.sort(compareSiblings);
  return { children, parentOf };
}

export function isAncestor(tree: Tree, ancestorId: string, id: string): boolean {
  const seen = new Set<string>();
  let cur = tree.parentOf.get(id) ?? null;
  while (cur !== null && !seen.has(cur)) {
    if (cur === ancestorId) return true;
    seen.add(cur);
    cur = tree.parentOf.get(cur) ?? null;
  }
  return false;
}

/** Number of live descendants (for delete confirmations). */
export function countDescendants(active: Note[], id: string): number {
  const tree = buildTree(active);
  let count = 0;
  const stack = [...(tree.children.get(id) ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    count++;
    stack.push(...(tree.children.get(n.id) ?? []));
  }
  return count;
}

/**
 * Plans moving `dragId` relative to `targetId` (null target = end of the top level).
 * Returns null when the move is impossible (onto itself or into its own subtree), or the
 * notes whose parent/order must change; siblings are renumbered so the order is explicit.
 */
export function planMove(active: Note[], dragId: string, targetId: string | null, position: DropPosition): MoveChange[] | null {
  const tree = buildTree(active);
  const drag = active.find(n => n.id === dragId);
  if (!drag) return null;
  if (targetId !== null && (targetId === dragId || !tree.parentOf.has(targetId))) return null;

  const newParent = targetId === null ? null : position === 'inside' ? targetId : (tree.parentOf.get(targetId) ?? null);
  if (newParent !== null && (newParent === dragId || isAncestor(tree, dragId, newParent))) return null;

  const siblings = (tree.children.get(newParent) ?? []).filter(n => n.id !== dragId);
  let index = siblings.length;
  if (targetId !== null && position !== 'inside') {
    const i = siblings.findIndex(n => n.id === targetId);
    index = position === 'before' ? i : i + 1;
  }
  siblings.splice(index, 0, drag);

  const changes: MoveChange[] = [];
  siblings.forEach((n, i) => {
    const order = (i + 1) * ORDER_STEP;
    const parentChanged = n.id === dragId && n.parentId !== newParent;
    if (parentChanged || n.order !== order) changes.push({ id: n.id, parentId: newParent, order });
  });
  return changes;
}

/** Alt+↑/↓ reorder among siblings, Alt+→ nests under the previous sibling, Alt+← moves out of the parent. */
export function keyboardMove(active: Note[], id: string, key: string): MoveChange[] | null {
  const tree = buildTree(active);
  const parent = tree.parentOf.get(id);
  if (parent === undefined) return null;
  const siblings = tree.children.get(parent) ?? [];
  const i = siblings.findIndex(n => n.id === id);
  const prev = siblings[i - 1];
  const next = siblings[i + 1];
  switch (key) {
    case 'ArrowUp': return prev ? planMove(active, id, prev.id, 'before') : null;
    case 'ArrowDown': return next ? planMove(active, id, next.id, 'after') : null;
    case 'ArrowRight': return prev ? planMove(active, id, prev.id, 'inside') : null;
    case 'ArrowLeft': return parent !== null ? planMove(active, id, parent, 'after') : null;
    default: return null;
  }
}
