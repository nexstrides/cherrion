// Table block: a grid of auto-growing plain-text cells. Typing only updates the model (no re-render);
// adding or removing rows and columns re-renders the editor and puts the cursor back in a cell.
//   Tab / Shift+Tab    next / previous cell (Tab in the last cell adds a row)
//   Enter              cell below (adds a row at the bottom); Shift+Enter is a line break
//   ↑ / ↓ at the edge  cell above / below, then the block before / after the table
import { TABLE_LIMITS, type Note, type TableBlock } from '../model';
import * as store from '../store';
import { confirmDialog } from './dialog';
import { autoResize, el, ICONS, svgIcon, toast } from './dom';
import { createMenuButton } from './dropdown';

export interface TableContext {
  rerender(): void;
  /** Moves the cursor to the block before (-1) or after (1) the table. */
  leave(dir: -1 | 1): void;
}

type Cell = { r: number; c: number };

/** Focuses a cell at once (the editor re-renders synchronously), so keys typed right after Tab land there. */
export function focusCell(blockId: string, cell: Cell, atEnd = false): void {
  const ta = document.querySelector<HTMLTextAreaElement>(
    `[data-block-id="${CSS.escape(blockId)}"] .table-cell[data-r="${cell.r}"][data-c="${cell.c}"]`);
  if (!ta) return;
  ta.focus();
  const pos = atEnd ? ta.value.length : 0;
  ta.setSelectionRange(pos, pos);
}

const isEmpty = (cells: string[]) => cells.every(c => !c.trim());

export function renderTable(note: Note, block: TableBlock, body: HTMLElement, ctx: TableContext): void {
  const cols = block.rows[0]?.length ?? 1;
  /** The cell the row/column actions apply to (the last focused one). */
  let active: Cell = { r: block.rows.length - 1, c: cols - 1 };

  const changed = (focus?: Cell) => {
    store.touchNote(note);
    ctx.rerender();
    if (focus) focusCell(block.id, focus);
  };

  const addRow = (at: number): boolean => {
    if (block.rows.length >= TABLE_LIMITS.rows) { toast(`Tables can have up to ${TABLE_LIMITS.rows} rows.`, 'error'); return false; }
    block.rows.splice(at, 0, Array<string>(cols).fill(''));
    return true;
  };
  const addCol = (at: number): boolean => {
    if (cols >= TABLE_LIMITS.cols) { toast(`Tables can have up to ${TABLE_LIMITS.cols} columns.`, 'error'); return false; }
    for (const row of block.rows) row.splice(at, 0, '');
    return true;
  };
  const removeRow = async (r: number) => {
    if (block.rows.length <= 1) { toast('A table needs at least one row. Delete the block to remove the table.'); return; }
    if (!isEmpty(block.rows[r] ?? []) && !(await confirmDialog({ title: 'Delete row?', message: 'This row and its text will be deleted.' }))) return;
    block.rows.splice(r, 1);
    changed({ r: Math.min(r, block.rows.length - 1), c: Math.min(active.c, cols - 1) });
  };
  const removeCol = async (c: number) => {
    if (cols <= 1) { toast('A table needs at least one column. Delete the block to remove the table.'); return; }
    if (!isEmpty(block.rows.map(row => row[c] ?? '')) && !(await confirmDialog({ title: 'Delete column?', message: 'This column and its text will be deleted.' }))) return;
    for (const row of block.rows) row.splice(c, 1);
    changed({ r: active.r, c: Math.min(c, cols - 2) });
  };

  const onKey = (e: KeyboardEvent, ta: HTMLTextAreaElement, r: number, c: number) => {
    if (e.isComposing) return;
    const last = { r: block.rows.length - 1, c: cols - 1 };
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        if (r === 0 && c === 0) ctx.leave(-1);
        else focusCell(block.id, c > 0 ? { r, c: c - 1 } : { r: r - 1, c: cols - 1 }, true);
      } else if (r === last.r && c === last.c) {
        if (addRow(block.rows.length)) changed({ r: r + 1, c: 0 });
      } else {
        focusCell(block.id, c < last.c ? { r, c: c + 1 } : { r: r + 1, c: 0 });
      }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (r < last.r) focusCell(block.id, { r: r + 1, c }, true);
      else if (addRow(block.rows.length)) changed({ r: r + 1, c });
    } else if (e.key === 'ArrowUp' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      e.preventDefault();
      if (r > 0) focusCell(block.id, { r: r - 1, c });
      else ctx.leave(-1);
    } else if (e.key === 'ArrowDown' && ta.selectionStart === ta.value.length) {
      e.preventDefault();
      if (r < last.r) focusCell(block.id, { r: r + 1, c });
      else ctx.leave(1);
    }
  };

  const table = el('table', { className: `table-block${block.header ? ' has-header' : ''}` });
  const tbody = el('tbody');
  block.rows.forEach((row, r) => {
    const tr = el('tr');
    row.forEach((value, c) => {
      const ta = el('textarea', { className: 'table-cell', value, rows: 1, spellcheck: true });
      ta.dataset.r = String(r);
      ta.dataset.c = String(c);
      ta.setAttribute('aria-label', `${block.header && r === 0 ? 'Header' : `Row ${block.header ? r : r + 1}`}, column ${c + 1}`);
      ta.addEventListener('input', () => {
        const target = block.rows[r];
        if (!target) return;
        target[c] = ta.value.slice(0, TABLE_LIMITS.cell);
        autoResize(ta);
        store.touchNote(note);
      });
      ta.addEventListener('focus', () => { active = { r, c }; });
      ta.addEventListener('keydown', e => onKey(e, ta, r, c));
      requestAnimationFrame(() => autoResize(ta));
      tr.append(el(block.header && r === 0 ? 'th' : 'td', {}, ta));
    });
    tbody.append(tr);
  });
  table.append(tbody);

  const tool = (icon: string, text: string, title: string, onclick: () => void) =>
    el('button', { type: 'button', className: 'table-tool', title, onclick }, svgIcon(icon), text);

  const tools = el('div', { className: 'table-tools' },
    tool(ICONS.rowAdd, 'Row', 'Add a row at the bottom', () => { if (addRow(block.rows.length)) changed({ r: block.rows.length - 1, c: 0 }); }),
    tool(ICONS.colAdd, 'Column', 'Add a column on the right', () => { if (addCol(cols)) changed({ r: 0, c: cols }); }),
    createMenuButton({
      className: 'table-tool table-more',
      text: '⋯',
      ariaLabel: 'Table options (for the selected cell)',
      items: [
        { value: 'row-above', label: 'Insert row above', icon: '↑' },
        { value: 'row-below', label: 'Insert row below', icon: '↓' },
        { value: 'col-left', label: 'Insert column left', icon: '←' },
        { value: 'col-right', label: 'Insert column right', icon: '→' },
        { value: 'header', label: block.header ? 'Turn off header row' : 'Use first row as header', icon: '▤' },
        { value: 'del-row', label: 'Delete row', icon: '✕', danger: true },
        { value: 'del-col', label: 'Delete column', icon: '✕', danger: true },
      ],
      onSelect: action => {
        const { r, c } = active;
        if (action === 'row-above') { if (addRow(r)) changed({ r, c }); }
        else if (action === 'row-below') { if (addRow(r + 1)) changed({ r: r + 1, c }); }
        else if (action === 'col-left') { if (addCol(c)) changed({ r, c }); }
        else if (action === 'col-right') { if (addCol(c + 1)) changed({ r, c: c + 1 }); }
        else if (action === 'header') { block.header = !block.header; changed({ r, c }); }
        else if (action === 'del-row') void removeRow(r);
        else if (action === 'del-col') void removeCol(c);
      },
    }),
  );

  body.append(el('div', { className: 'table-wrap' }, table), tools);
}
