// Custom dropdowns (replacing native <select>) and action menus. Both open one shared,
// keyboard-navigable listbox popover that is positioned inside the viewport.
import { el, ICONS, svgIcon, type IconName } from './dom';

/**
 * `icon` is an emoji; `svg` is a stroke icon from ICONS (sharper, and follows the text colour).
 * Menus also take `separator` (a divider line), `disabled` and `hint` (a shortcut shown on the right).
 */
export interface DropdownOption {
  value: string; label: string; icon?: string; svg?: IconName; swatch?: string; danger?: boolean;
  separator?: boolean; disabled?: boolean; hint?: string;
}
export const SEPARATOR: DropdownOption = { value: '', label: '', separator: true };
export interface Dropdown { readonly el: HTMLElement; readonly value: string; setValue(value: string): void }

interface DropdownConfig {
  id?: string;
  className?: string;
  ariaLabel: string;
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
}

/** The open menu. `trigger` is the button it belongs to, or null for a right-click menu. */
let current: { trigger: HTMLElement | null; close: (refocus: boolean) => void } | null = null;

function menu(): HTMLElement {
  let m = document.getElementById('dropdown-menu');
  if (!m) {
    m = el('div', { id: 'dropdown-menu', className: 'dropdown-menu hidden' });
    m.setAttribute('role', 'listbox');
    document.body.append(m);
  }
  return m;
}

export function closeDropdowns(): void { current?.close(false); }

document.addEventListener('pointerdown', e => {
  if (!current) return;
  const t = e.target as Node;
  if (!menu().contains(t) && !current.trigger?.contains(t)) current.close(false);
}, true);
window.addEventListener('resize', () => current?.close(false));
document.addEventListener('scroll', e => { if (current && !menu().contains(e.target as Node)) current.close(false); }, true);

function optionVisual(opt: DropdownOption | undefined): HTMLElement | null {
  if (opt?.swatch) {
    const s = el('span', { className: 'dd-swatch' });
    s.style.background = opt.swatch;
    return s;
  }
  if (opt?.svg) return el('span', { className: 'dd-icon dd-svg' }, svgIcon(ICONS[opt.svg]));
  return opt?.icon ? el('span', { className: 'dd-icon', text: opt.icon }) : null;
}

function caret(): SVGSVGElement {
  const c = svgIcon(ICONS.chevron);
  c.classList.add('dd-caret');
  return c;
}

/** Opens the shared popover under `trigger`. `selected` is null for action menus. */
function openPopover(trigger: HTMLButtonElement, ariaLabel: string, options: DropdownOption[], selected: string | null, onChoose: (value: string) => void): void {
  if (current?.trigger === trigger) { current.close(true); return; }
  present({ trigger, anchor: trigger.getBoundingClientRect(), returnFocus: trigger, ariaLabel, options, selected, onChoose });
}

/**
 * Opens a menu at the mouse pointer (right-click). Focus goes back to whatever had it before, so
 * Paste lands in the text field that was right-clicked.
 */
export function openContextMenu(x: number, y: number, ariaLabel: string, options: DropdownOption[], onChoose: (value: string) => void): void {
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  present({ trigger: null, anchor: { left: x, top: y, right: x, bottom: y, width: 0 }, atPoint: true, returnFocus, ariaLabel, options, selected: null, onChoose });
}

interface PresentOptions {
  trigger: HTMLElement | null;
  anchor: { left: number; top: number; right: number; bottom: number; width: number };
  atPoint?: boolean;
  returnFocus: HTMLElement | null;
  ariaLabel: string;
  options: DropdownOption[];
  selected: string | null;
  onChoose: (value: string) => void;
}

function present(o: PresentOptions): void {
  current?.close(false);
  const m = menu();
  const { trigger } = o;

  const close = (refocus: boolean) => {
    m.classList.add('hidden');
    m.replaceChildren();
    m.onkeydown = null;
    trigger?.setAttribute('aria-expanded', 'false');
    if (current?.close === close) current = null;
    if (refocus && o.returnFocus?.isConnected) o.returnFocus.focus({ preventScroll: true });
  };
  const choose = (v: string) => { close(true); o.onChoose(v); };

  const items: HTMLElement[] = [];
  const rows = o.options.map(opt => {
    if (opt.separator) {
      const sep = el('div', { className: 'dd-sep' });
      sep.setAttribute('role', 'separator');
      return sep;
    }
    const isSelected = opt.value === o.selected;
    const v = optionVisual(opt);
    const cls = `dropdown-option${isSelected ? ' selected' : ''}${opt.danger ? ' danger' : ''}${opt.disabled ? ' disabled' : ''}`;
    const item = el('div', { className: cls, tabIndex: -1 },
      ...(v ? [v] : []), el('span', { className: 'dd-option-label', text: opt.label }),
      opt.hint ? el('span', { className: 'dd-hint', text: opt.hint }) : el('span', { className: 'dd-check', text: isSelected ? '✓' : '' }));
    item.dataset.value = opt.value;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(isSelected));
    if (opt.disabled) item.setAttribute('aria-disabled', 'true');
    else {
      item.onclick = () => choose(opt.value);
      items.push(item);
    }
    return item;
  });
  m.replaceChildren(...rows);
  m.setAttribute('aria-label', o.ariaLabel);
  m.classList.toggle('context', !!o.atPoint);
  m.classList.remove('hidden');

  // Below the anchor (above if there is no room), inside the viewport. A right-click menu opens at
  // the pointer and flips left/up near the edges, like a desktop menu.
  const r = o.anchor;
  m.style.minWidth = `${Math.max(r.width, o.atPoint ? 200 : 160)}px`;
  m.style.left = '0px';
  m.style.top = '0px';
  const mh = m.offsetHeight;
  const mw = m.offsetWidth;
  let top: number;
  let left: number;
  if (o.atPoint) {
    top = r.top + mh + 8 <= window.innerHeight ? r.top : r.top - mh;
    left = r.left + mw + 8 <= window.innerWidth ? r.left : r.left - mw;
  } else {
    const below = window.innerHeight - r.bottom;
    top = below >= mh + 8 || below >= r.top ? r.bottom + 4 : r.top - mh - 4;
    left = r.left;
  }
  m.style.top = `${Math.max(8, Math.min(top, window.innerHeight - mh - 8))}px`;
  m.style.left = `${Math.max(8, Math.min(left, window.innerWidth - mw - 8))}px`;

  trigger?.setAttribute('aria-expanded', 'true');
  current = { trigger, close };
  (items.find(i => i.dataset.value === o.selected) ?? items[0])?.focus();

  m.onkeydown = e => {
    const i = items.indexOf(document.activeElement as HTMLDivElement);
    const focusAt = (n: number) => items[Math.max(0, Math.min(items.length - 1, n))]?.focus();
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(items.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const v = items[i]?.dataset.value; if (v !== undefined) choose(v); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
    else if (e.key.length === 1) {
      const k = e.key.toLowerCase();
      const starts = (it: HTMLElement) => (it.textContent ?? '').trim().toLowerCase().startsWith(k);
      const next = items.findIndex((it, n) => n > i && starts(it));
      const first = items.findIndex(starts);
      focusAt(next >= 0 ? next : first >= 0 ? first : i);
    }
  };
}

function wireTrigger(trigger: HTMLButtonElement, open: () => void): void {
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.onclick = open;
  trigger.onkeydown = e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
  };
}

/** A select-like dropdown: shows the chosen option and calls onChange when it changes. */
export function createDropdown(cfg: DropdownConfig): Dropdown {
  let value = cfg.value;
  const visual = el('span', { className: 'dd-visual' });
  const label = el('span', { className: 'dd-label' });
  const trigger = el('button', { type: 'button', className: 'dropdown-trigger' }, visual, label, caret());
  const root = el('div', { className: `dropdown ${cfg.className ?? ''}`.trim() }, trigger);
  if (cfg.id) root.id = cfg.id;

  const paint = () => {
    const opt = cfg.options.find(o => o.value === value) ?? cfg.options[0];
    const v = optionVisual(opt);
    visual.replaceChildren(...(v ? [v] : []));
    visual.hidden = !v;
    label.textContent = opt?.label ?? '';
    trigger.title = `${cfg.ariaLabel}: ${opt?.label ?? ''}`;
    trigger.setAttribute('aria-label', trigger.title);
    root.dataset.value = value;
  };
  wireTrigger(trigger, () => openPopover(trigger, cfg.ariaLabel, cfg.options, value, v => {
    if (v === value) return;
    value = v;
    paint();
    cfg.onChange(v);
  }));
  paint();

  return {
    el: root,
    get value() { return value; },
    setValue(v: string) { value = v; paint(); },
  };
}

/** Makes an existing button open a list of actions. `items` is read each time, so labels can change. */
export function attachMenu(trigger: HTMLButtonElement, cfg: { ariaLabel: string; items: () => DropdownOption[]; onSelect: (value: string) => void }): void {
  wireTrigger(trigger, () => openPopover(trigger, cfg.ariaLabel, cfg.items(), null, cfg.onSelect));
}

/** A small button that opens a list of actions (e.g. the ⋮ block menu). */
export function createMenuButton(cfg: { className?: string; text: string; ariaLabel: string; items: DropdownOption[]; onSelect: (value: string) => void }): HTMLButtonElement {
  const trigger = el('button', { type: 'button', className: cfg.className ?? '', text: cfg.text, title: cfg.ariaLabel });
  trigger.setAttribute('aria-label', cfg.ariaLabel);
  attachMenu(trigger, { ariaLabel: cfg.ariaLabel, items: () => cfg.items, onSelect: cfg.onSelect });
  return trigger;
}

/** Replaces a placeholder element (same id) with the dropdown. */
export function mountDropdown(placeholderId: string, cfg: Omit<DropdownConfig, 'id'>): Dropdown {
  const dd = createDropdown({ ...cfg, id: placeholderId });
  document.getElementById(placeholderId)?.replaceWith(dd.el);
  return dd;
}
