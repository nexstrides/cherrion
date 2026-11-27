// Dropdown cells for table columns of type Select, Status and Multi-select (see model.ts): the picker
// that opens on a cell (search, choose, or create an option by typing) and the option editor
// (rename, recolour, reorder, delete). Cells hold option labels as text; renames and deletions are
// applied to the cells by the table (onOptions).
//   ↑ / ↓   move through the list      Enter   choose (or create)      Esc   close
import {
  cleanOptionLabel, findOption, joinChoices, nextOptionColor, OPTION_COLORS, splitChoices, TABLE_LIMITS, uid,
  type OptionColor, type SelectOption, type TableColumn,
} from '../model';
import { confirmDialog } from './dialog';
import { el, toast } from './dom';

const COLOR_NAMES: Record<OptionColor, string> = {
  gray: 'Gray', brown: 'Brown', orange: 'Orange', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple', pink: 'Pink', red: 'Red',
};

/** A coloured tag. `color` null: a value that is not one of the column's options. */
export function optionPill(label: string, color: OptionColor | null): HTMLElement {
  return el('span', { className: `opt-pill opt-${color ?? 'none'}`, text: label, title: color ? label : `${label} (not an option of this column)` });
}

/** The labels a cell shows (one for Select / Status, any number for Multi-select). */
export function cellChoices(col: TableColumn, value: string): string[] {
  if (col.type === 'multi') return splitChoices(value);
  const label = cleanOptionLabel(value);
  return label ? [label] : [];
}

const nextColor = nextOptionColor;

export interface OptionChange { renamed?: [from: string, to: string]; removed?: string }

interface PickerOptions {
  anchor: HTMLElement;
  column: TableColumn;
  /** The cell's text now (ignored in the option editor). */
  value: string;
  /** Start in the option editor (from the column menu). */
  editOnly?: boolean;
  /** Text already typed (a key pressed on the cell opens the picker with it). */
  query?: string;
  /** The cell's new text. Multi-select keeps the picker open. */
  onPick(value: string): void;
  /** Options changed: added, recoloured or reordered (no argument), renamed or removed. */
  onOptions(change: OptionChange): void;
  /** How many cells use an option (asked before deleting it). */
  usage(label: string): number;
  onClose(): void;
}

let current: { root: HTMLElement; close(): void } | null = null;

/** Closes an open picker (also used when locking). */
export function closeChoicePicker(): void { current?.close(); }

export function openChoicePicker(o: PickerOptions): void {
  closeChoicePicker();
  const col = o.column;
  const multi = col.type === 'multi';
  let chosen = cellChoices(col, o.value);
  let mode: 'pick' | 'edit' = o.editOnly ? 'edit' : 'pick';
  let highlight = 0;

  const root = el('div', { className: 'choice-picker', tabIndex: -1 });
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', multi ? 'Choose tags' : 'Choose an option');

  const search = el('input', {
    className: 'cp-search', type: 'text', maxLength: TABLE_LIMITS.option, autocomplete: 'off', spellcheck: false,
    placeholder: multi ? 'Search or add tags…' : 'Search or add an option…',
  });
  const list = el('div', { className: 'cp-list' });
  list.setAttribute('role', 'listbox');
  if (multi) list.setAttribute('aria-multiselectable', 'true');
  const editButton = el('button', { type: 'button', className: 'cp-footer-btn', text: '✎ Edit options' });

  /** Rows of the list: options matching the search, then "Create" and "Clear". */
  type Row = { kind: 'option'; option: SelectOption } | { kind: 'unknown'; label: string } | { kind: 'create'; label: string } | { kind: 'clear' };
  const rows = (): Row[] => {
    const q = search.value.trim().toLowerCase();
    const out: Row[] = col.options.filter(opt => !q || opt.label.toLowerCase().includes(q)).map(option => ({ kind: 'option' as const, option }));
    for (const label of chosen) if (!findOption(col, label) && (!q || label.toLowerCase().includes(q))) out.push({ kind: 'unknown', label });
    const label = cleanOptionLabel(search.value);
    if (label && !findOption(col, label)) out.push({ kind: 'create', label });
    if (!q && chosen.length) out.push({ kind: 'clear' });
    return out;
  };

  const choose = (label: string | null) => {
    if (multi) {
      if (label === null) chosen = [];
      else chosen = chosen.some(l => l.toLowerCase() === label.toLowerCase()) ? chosen.filter(l => l.toLowerCase() !== label.toLowerCase()) : [...chosen, label];
      // Keep the column's order, then any values that are not options.
      chosen = [...col.options.map(opt => opt.label).filter(l => chosen.includes(l)), ...chosen.filter(l => !findOption(col, l))];
      o.onPick(joinChoices(chosen));
      search.value = '';
      // Only the list is repainted: rebuilding the picker would take the focus out of the search box.
      paintList();
      search.focus();
    } else {
      chosen = label ? [label] : [];
      o.onPick(label ?? '');
      close();
    }
  };

  const create = (raw: string) => {
    const label = cleanOptionLabel(raw);
    if (!label) return;
    const existing = findOption(col, label);
    if (existing) { choose(existing.label); return; }
    if (col.options.length >= TABLE_LIMITS.options) { toast(`A column can have up to ${TABLE_LIMITS.options} options.`, 'error'); return; }
    col.options.push({ id: uid(), label, color: nextColor(col) });
    o.onOptions({});
    choose(label);
  };

  const activate = (row: Row) => {
    if (row.kind === 'option') choose(row.option.label);
    else if (row.kind === 'unknown') choose(row.label);
    else if (row.kind === 'create') create(row.label);
    else choose(null);
  };

  const paintList = () => {
    const all = rows();
    highlight = Math.max(0, Math.min(highlight, all.length - 1));
    list.replaceChildren(...all.map((row, i) => {
      const item = el('div', { className: `cp-item${i === highlight ? ' active' : ''}` });
      item.setAttribute('role', 'option');
      if (row.kind === 'option' || row.kind === 'unknown') {
        const label = row.kind === 'option' ? row.option.label : row.label;
        const selected = chosen.some(l => l.toLowerCase() === label.toLowerCase());
        item.setAttribute('aria-selected', String(selected));
        item.append(optionPill(label, row.kind === 'option' ? row.option.color : null), el('span', { className: 'cp-check', text: selected ? '✓' : '' }));
      } else if (row.kind === 'create') {
        item.classList.add('cp-create');
        item.append(el('span', { className: 'cp-muted', text: 'Create' }), optionPill(row.label, nextColor(col)));
      } else {
        item.classList.add('cp-clear');
        item.append(el('span', { className: 'cp-muted', text: multi ? 'Clear all' : 'Clear' }));
      }
      item.onmousedown = e => e.preventDefault(); // keep focus in the search box
      item.onclick = () => { highlight = i; activate(row); };
      return item;
    }));
    if (!all.length) list.append(el('div', { className: 'cp-empty', text: 'Type to add an option.' }));
  };

  // ---- Option editor ----

  const editor = el('div', { className: 'cp-editor' });
  const paintEditor = () => {
    const items = col.options.map((opt, i) => {
      const dot = el('button', { type: 'button', className: `cp-dot opt-${opt.color}`, title: `Colour: ${COLOR_NAMES[opt.color]}` });
      dot.setAttribute('aria-label', `Colour of ${opt.label}: ${COLOR_NAMES[opt.color]}`);
      const palette = el('div', { className: 'cp-palette hidden' }, ...OPTION_COLORS.map(color => {
        const swatch = el('button', { type: 'button', className: `cp-dot opt-${color}${color === opt.color ? ' selected' : ''}`, title: COLOR_NAMES[color] });
        swatch.setAttribute('aria-label', COLOR_NAMES[color]);
        swatch.onclick = () => { opt.color = color; o.onOptions({}); paintEditor(); };
        return swatch;
      }));
      dot.onclick = () => palette.classList.toggle('hidden');
      const name = el('input', { className: 'cp-name', type: 'text', value: opt.label, maxLength: TABLE_LIMITS.option, spellcheck: false });
      name.setAttribute('aria-label', `Option name: ${opt.label}`);
      const rename = () => {
        const label = cleanOptionLabel(name.value);
        if (label === opt.label) { name.value = label; return; }
        if (!label) { name.value = opt.label; return; }
        const clash = findOption(col, label);
        if (clash && clash !== opt) { toast(`There is already an option “${clash.label}”.`, 'error'); name.value = opt.label; return; }
        const from = opt.label;
        opt.label = label;
        chosen = chosen.map(l => (l === from ? label : l));
        o.onOptions({ renamed: [from, label] });
        paintEditor();
      };
      name.addEventListener('change', rename);
      name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });
      const move = (dir: -1 | 1) => {
        const j = i + dir;
        if (j < 0 || j >= col.options.length) return;
        [col.options[i], col.options[j]] = [col.options[j]!, col.options[i]!];
        o.onOptions({});
        paintEditor();
      };
      const small = (text: string, label: string, onclick: () => void, disabled = false) => {
        const b = el('button', { type: 'button', className: 'cp-small', text, title: label, onclick, disabled });
        b.setAttribute('aria-label', `${label}: ${opt.label}`);
        return b;
      };
      const remove = small('✕', 'Delete option', async () => {
        const used = o.usage(opt.label);
        if (used) {
          const ok = await confirmDialog({
            title: `Delete “${opt.label}”?`,
            message: `${used} cell${used === 1 ? ' uses' : 's use'} this option; ${used === 1 ? 'it is' : 'they are'} cleared.`,
            confirmLabel: 'Delete option',
          });
          if (!ok) return;
        }
        col.options.splice(col.options.indexOf(opt), 1);
        chosen = chosen.filter(l => l !== opt.label);
        o.onOptions({ removed: opt.label });
        paintEditor();
      });
      return el('div', { className: 'cp-edit-item' },
        el('div', { className: 'cp-edit-row' }, dot, name,
          small('↑', 'Move up', () => move(-1), i === 0), small('↓', 'Move down', () => move(1), i === col.options.length - 1), remove),
        palette);
    });
    const add = el('input', { className: 'cp-name cp-add', type: 'text', placeholder: '+ Add an option', maxLength: TABLE_LIMITS.option, spellcheck: false });
    add.setAttribute('aria-label', 'New option');
    add.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const label = cleanOptionLabel(add.value);
      if (!label) return;
      if (findOption(col, label)) { toast(`There is already an option “${label}”.`, 'error'); return; }
      if (col.options.length >= TABLE_LIMITS.options) { toast(`A column can have up to ${TABLE_LIMITS.options} options.`, 'error'); return; }
      col.options.push({ id: uid(), label, color: nextColor(col) });
      o.onOptions({});
      paintEditor();
      root.querySelector<HTMLInputElement>('.cp-add')?.focus();
    });
    editor.replaceChildren(
      el('div', { className: 'cp-edit-head' },
        o.editOnly ? el('span', { text: 'Options' }) : el('button', { type: 'button', className: 'cp-small cp-back', text: '← Options', onclick: () => { mode = 'pick'; paint(); search.focus(); } }),
        el('span', { className: 'cp-muted', text: 'Commas are not allowed in names.' })),
      ...(items.length ? items : [el('div', { className: 'cp-empty', text: 'No options yet.' })]),
      add,
    );
    // Repainting removed the focused control: keep the focus in the picker, so Esc still closes it.
    if (root.isConnected && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
  };

  const paint = () => {
    root.replaceChildren(...(mode === 'pick'
      ? [search, list, el('div', { className: 'cp-footer' }, editButton)]
      : [editor]));
    if (mode === 'pick') paintList(); else paintEditor();
  };
  editButton.onclick = () => { mode = 'edit'; paint(); root.querySelector<HTMLInputElement>('.cp-add')?.focus(); };

  search.addEventListener('input', () => { highlight = 0; paintList(); });
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (mode === 'edit' && !o.editOnly) { mode = 'pick'; paint(); search.focus(); } else close();
      return;
    }
    if (mode !== 'pick') return;
    const all = rows();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      highlight = (highlight + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % Math.max(1, all.length);
      paintList();
      list.querySelector('.cp-item.active')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = all[highlight];
      if (row) activate(row);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      close();
    }
  });

  // Outside clicks close it (not clicks in the confirmation dialog it opened).
  const outside = (e: PointerEvent) => {
    const t = e.target as Node;
    if (root.contains(t) || document.getElementById('confirm-modal')?.contains(t)) return;
    close();
  };
  const reposition = () => {
    const r = o.anchor.isConnected ? o.anchor.getBoundingClientRect() : null;
    if (!r) return;
    const w = root.offsetWidth;
    const h = root.offsetHeight;
    const below = window.innerHeight - r.bottom;
    root.style.top = `${below >= h + 8 || below >= r.top ? r.bottom + 4 : Math.max(8, r.top - h - 4)}px`;
    root.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  };

  function close(): void {
    if (current?.root !== root) return;
    current = null;
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', close);
    root.remove();
    o.onClose();
  }

  current = { root, close };
  if (o.query) search.value = o.query;
  paint();
  document.body.append(root);
  root.style.minWidth = `${Math.max(240, o.anchor.getBoundingClientRect().width)}px`;
  reposition();
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('resize', close);
  if (mode === 'pick') search.focus();
  else root.querySelector<HTMLInputElement>('.cp-add')?.focus();
}
