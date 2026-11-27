// Table block: a grid of cells. Typing only updates the model (no re-render); adding or removing rows
// and columns, or changing a column's type, re-renders the editor and puts the cursor back in a cell.
//
// Columns are Text (auto-growing text cells), or a dropdown: Select, Status or Multi-select, whose
// cells show coloured tags and open a picker (ui/tableChoice.ts). The bar above the table shows each
// column's type and opens its menu. With a header row, the first row holds the column names as text.
//   Tab / Shift+Tab    next / previous cell (Tab in the last cell adds a row)
//   Enter              text: cell below (adds a row at the bottom), Shift+Enter is a line break
//                      dropdown: open the picker (so do Space and typing); Backspace clears it
//   ↑ / ↓ at the edge  cell above / below, then the block before / after the table
import {
  choiceUsage, findOption, isChoiceColumn, removeChoice, renameChoice, setColumnType, TABLE_LIMITS, tableColumns, TEXT_COLUMN,
  type ColumnType, type Note, type TableBlock, type TableColumn,
} from '../model';
import * as store from '../store';
import { confirmDialog } from './dialog';
import { autoResize, el, ICONS, svgIcon, toast } from './dom';
import { attachMenu, createMenuButton, SEPARATOR, type DropdownOption } from './dropdown';
import { cellChoices, openChoicePicker, optionPill } from './tableChoice';

export interface TableContext {
  rerender(): void;
  /** Moves the cursor to the block before (-1) or after (1) the table. */
  leave(dir: -1 | 1): void;
}

type Cell = { r: number; c: number };

export const COLUMN_TYPE_INFO: Record<ColumnType, { label: string; icon: string; hint: string }> = {
  text: { label: 'Text', icon: 'Aa', hint: 'Any text' },
  select: { label: 'Select', icon: '▾', hint: 'One option from a list' },
  status: { label: 'Status', icon: '◐', hint: 'Not started / In progress / Done (editable)' },
  multi: { label: 'Multi-select', icon: '☰', hint: 'Several tags from a list' },
};

/** Focuses a cell at once (the editor re-renders synchronously), so keys typed right after Tab land there. */
export function focusCell(blockId: string, cell: Cell, atEnd = false): void {
  const target = document.querySelector<HTMLElement>(
    `[data-block-id="${CSS.escape(blockId)}"] .table-cell[data-r="${cell.r}"][data-c="${cell.c}"]`);
  if (!target) return;
  target.focus();
  if (target instanceof HTMLTextAreaElement) {
    const pos = atEnd ? target.value.length : 0;
    target.setSelectionRange(pos, pos);
  }
}

const isEmpty = (cells: string[]) => cells.every(c => !c.trim());

export function renderTable(note: Note, block: TableBlock, body: HTMLElement, ctx: TableContext): void {
  const cols = block.rows[0]?.length ?? 1;
  const readOnly = store.isReadOnly(store.spaceOf(note.id));
  const columnOf = (c: number): TableColumn => block.columns?.[c] ?? TEXT_COLUMN;
  const isHeaderCell = (r: number) => block.header && r === 0;
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
    block.columns?.splice(at, 0, { type: 'text', options: [] });
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
    block.columns?.splice(c, 1);
    changed({ r: active.r, c: Math.min(c, cols - 2) });
  };

  // ---- Keys shared by text and dropdown cells ----

  const last = () => ({ r: block.rows.length - 1, c: cols - 1 });
  const tab = (r: number, c: number, back: boolean) => {
    if (back) {
      if (r === 0 && c === 0) ctx.leave(-1);
      else focusCell(block.id, c > 0 ? { r, c: c - 1 } : { r: r - 1, c: cols - 1 }, true);
    } else if (r === last().r && c === last().c) {
      if (addRow(block.rows.length)) changed({ r: r + 1, c: 0 });
    } else {
      focusCell(block.id, c < last().c ? { r, c: c + 1 } : { r: r + 1, c: 0 });
    }
  };
  const vertical = (r: number, c: number, dir: -1 | 1) => {
    if (dir < 0) { if (r > 0) focusCell(block.id, { r: r - 1, c }); else ctx.leave(-1); }
    else if (r < last().r) focusCell(block.id, { r: r + 1, c });
    else ctx.leave(1);
  };

  const onTextKey = (e: KeyboardEvent, ta: HTMLTextAreaElement, r: number, c: number) => {
    if (e.isComposing) return;
    if (e.key === 'Tab') { e.preventDefault(); tab(r, c, e.shiftKey); }
    else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (r < last().r) focusCell(block.id, { r: r + 1, c }, true);
      else if (addRow(block.rows.length)) changed({ r: r + 1, c });
    } else if (e.key === 'ArrowUp' && ta.selectionStart === 0 && ta.selectionEnd === 0) { e.preventDefault(); vertical(r, c, -1); }
    else if (e.key === 'ArrowDown' && ta.selectionStart === ta.value.length) { e.preventDefault(); vertical(r, c, 1); }
  };

  // ---- Dropdown cells ----

  /** Dropdown cell buttons by "r,c", so changes repaint them in place (no re-render while picking). */
  const choiceCells = new Map<string, HTMLElement>();
  const paintChoice = (cell: HTMLElement, c: number, value: string) => {
    const col = columnOf(c);
    const labels = cellChoices(col, value);
    cell.replaceChildren(...(labels.length
      ? labels.map(l => optionPill(findOption(col, l)?.label ?? l, findOption(col, l)?.color ?? null))
      : [el('span', { className: 'table-choice-empty', text: readOnly ? '' : col.type === 'multi' ? 'Add tags…' : 'Choose…' })]));
    const where = `${block.header ? `Row ${Number(cell.dataset.r)}` : `Row ${Number(cell.dataset.r) + 1}`}, column ${c + 1}`;
    cell.setAttribute('aria-label', `${where}: ${labels.join(', ') || 'empty'}${readOnly ? '' : '. Press Enter to choose'}`);
  };
  const repaintColumn = (c: number) => {
    for (const [key, cell] of choiceCells) {
      const [r, cc] = key.split(',').map(Number) as [number, number];
      if (cc === c) paintChoice(cell, c, block.rows[r]?.[c] ?? '');
    }
  };
  const optionsChanged = (c: number, change: { renamed?: [string, string]; removed?: string }) => {
    if (change.renamed) renameChoice(block, c, change.renamed[0], change.renamed[1]);
    if (change.removed !== undefined) removeChoice(block, c, change.removed);
    store.touchNote(note);
    repaintColumn(c);
  };
  const openPicker = (r: number, c: number, cell: HTMLElement, query?: string) => {
    if (readOnly) return;
    const column = tableColumns(block)[c]!;
    openChoicePicker({
      anchor: cell.closest('td') ?? cell,
      column,
      value: block.rows[r]?.[c] ?? '',
      ...(query ? { query } : {}),
      onPick: value => {
        const row = block.rows[r];
        if (!row) return;
        row[c] = value;
        paintChoice(cell, c, value);
        store.touchNote(note);
      },
      onOptions: change => optionsChanged(c, change),
      usage: label => choiceUsage(block, c, label),
      onClose: () => { if (cell.isConnected) cell.focus(); else focusCell(block.id, { r, c }); },
    });
  };
  const onChoiceKey = (e: KeyboardEvent, cell: HTMLElement, r: number, c: number) => {
    if (e.key === 'Tab') { e.preventDefault(); tab(r, c, e.shiftKey); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); vertical(r, c, e.key === 'ArrowUp' ? -1 : 1); }
    else if (e.key === 'ArrowLeft' && (r > 0 || c > 0)) { e.preventDefault(); tab(r, c, true); }
    else if (e.key === 'ArrowRight' && (r < last().r || c < last().c)) { e.preventDefault(); tab(r, c, false); }
    else if (readOnly) return;
    else if (e.key === 'Enter' || e.key === ' ' || e.key === 'F2') { e.preventDefault(); openPicker(r, c, cell); }
    else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      const row = block.rows[r];
      if (!row?.[c]) return;
      row[c] = '';
      paintChoice(cell, c, '');
      store.touchNote(note);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      openPicker(r, c, cell, e.key); // start typing to search or add an option
    }
  };

  // ---- Column bar: each column's type and menu ----

  const columnItems = (c: number): DropdownOption[] => {
    const type = columnOf(c).type;
    return [
      ...(Object.keys(COLUMN_TYPE_INFO) as ColumnType[]).map(t => ({
        value: `type:${t}`, label: COLUMN_TYPE_INFO[t].label, icon: COLUMN_TYPE_INFO[t].icon, hint: t === type ? '✓' : COLUMN_TYPE_INFO[t].hint,
      })),
      SEPARATOR,
      { value: 'options', label: 'Edit options…', svg: 'edit' as const, disabled: !isChoiceColumn(type) },
      SEPARATOR,
      { value: 'col-left', label: 'Insert column left', icon: '←' },
      { value: 'col-right', label: 'Insert column right', icon: '→' },
      { value: 'del-col', label: 'Delete column', icon: '✕', danger: true },
    ];
  };
  const firstValueCell = (c: number): Cell => ({ r: block.header && block.rows.length > 1 ? 1 : 0, c });
  const onColumnAction = (c: number, action: string, button: HTMLButtonElement) => {
    if (action.startsWith('type:')) {
      const to = action.slice(5) as ColumnType;
      if (to === columnOf(c).type) return;
      setColumnType(block, c, to);
      changed(firstValueCell(c));
    } else if (action === 'options') {
      openChoicePicker({
        anchor: button, column: tableColumns(block)[c]!, value: '', editOnly: true,
        onPick: () => {},
        onOptions: change => optionsChanged(c, change),
        usage: label => choiceUsage(block, c, label),
        onClose: () => { if (button.isConnected) button.focus(); },
      });
    } else if (action === 'col-left') { if (addCol(c)) changed({ r: active.r, c }); }
    else if (action === 'col-right') { if (addCol(c + 1)) changed({ r: active.r, c: c + 1 }); }
    else if (action === 'del-col') void removeCol(c);
  };

  const table = el('table', { className: `table-block${block.header ? ' has-header' : ''}` });
  if (!readOnly) {
    const bar = el('tr', { className: 'table-colbar' });
    for (let c = 0; c < cols; c++) {
      const info = COLUMN_TYPE_INFO[columnOf(c).type];
      const caret = svgIcon(ICONS.chevron);
      caret.classList.add('colbar-caret');
      const button = el('button', { type: 'button', className: 'colbar-btn', title: `Column ${c + 1}: ${info.label}. Change the type or the options` },
        el('span', { className: 'colbar-icon', text: info.icon }), el('span', { className: 'colbar-label', text: info.label }), caret);
      button.setAttribute('aria-label', `Column ${c + 1}, ${info.label}. Column menu`);
      attachMenu(button, { ariaLabel: `Column ${c + 1}`, items: () => columnItems(c), onSelect: action => onColumnAction(c, action, button) });
      bar.append(el('th', { className: 'colbar-cell' }, button));
    }
    table.append(el('thead', {}, bar));
  }

  const tbody = el('tbody');
  block.rows.forEach((row, r) => {
    const tr = el('tr');
    row.forEach((value, c) => {
      let cell: HTMLElement;
      if (isChoiceColumn(columnOf(c).type) && !isHeaderCell(r)) {
        cell = readOnly
          ? el('div', { className: 'table-cell table-choice', tabIndex: 0 })
          : el('button', { type: 'button', className: 'table-cell table-choice', onclick: () => openPicker(r, c, cell) });
        cell.dataset.r = String(r);
        cell.dataset.c = String(c);
        choiceCells.set(`${r},${c}`, cell);
        paintChoice(cell, c, value);
        cell.addEventListener('keydown', e => onChoiceKey(e, cell, r, c));
      } else {
        const ta = el('textarea', { className: 'table-cell', value, rows: 1, spellcheck: true });
        ta.dataset.r = String(r);
        ta.dataset.c = String(c);
        ta.setAttribute('aria-label', `${isHeaderCell(r) ? 'Header' : `Row ${block.header ? r : r + 1}`}, column ${c + 1}`);
        ta.addEventListener('input', () => {
          const target = block.rows[r];
          if (!target) return;
          target[c] = ta.value.slice(0, TABLE_LIMITS.cell);
          autoResize(ta);
          store.touchNote(note);
        });
        ta.addEventListener('keydown', e => onTextKey(e, ta, r, c));
        requestAnimationFrame(() => autoResize(ta));
        cell = ta;
      }
      cell.addEventListener('focus', () => { active = { r, c }; });
      tr.append(el(isHeaderCell(r) ? 'th' : 'td', {}, cell));
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
