// Custom dropdowns (replacing native <select>) and action menus. Both open one shared,
// keyboard-navigable listbox popover that is positioned inside the viewport.
import { el } from './dom';

export interface DropdownOption { value: string; label: string; icon?: string; swatch?: string; danger?: boolean }
export interface Dropdown { readonly el: HTMLElement; readonly value: string; setValue(value: string): void }

interface DropdownConfig {
  id?: string;
  className?: string;
  ariaLabel: string;
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
}

let current: { trigger: HTMLButtonElement; close: (refocus: boolean) => void } | null = null;

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
  if (!menu().contains(t) && !current.trigger.contains(t)) current.close(false);
}, true);
window.addEventListener('resize', () => current?.close(false));
document.addEventListener('scroll', e => { if (current && !menu().contains(e.target as Node)) current.close(false); }, true);

function optionVisual(opt: DropdownOption | undefined): HTMLElement | null {
  if (opt?.swatch) {
    const s = el('span', { className: 'dd-swatch' });
    s.style.background = opt.swatch;
    return s;
  }
  return opt?.icon ? el('span', { className: 'dd-icon', text: opt.icon }) : null;
}

/** Opens the shared popover under `trigger`. `selected` is null for action menus. */
function openPopover(trigger: HTMLButtonElement, ariaLabel: string, options: DropdownOption[], selected: string | null, onChoose: (value: string) => void): void {
  if (current?.trigger === trigger) { current.close(true); return; }
  current?.close(false);
  const m = menu();

  const close = (refocus: boolean) => {
    m.classList.add('hidden');
    m.replaceChildren();
    m.onkeydown = null;
    trigger.setAttribute('aria-expanded', 'false');
    if (current?.trigger === trigger) current = null;
    if (refocus && trigger.isConnected) trigger.focus();
  };
  const choose = (v: string) => { close(true); onChoose(v); };

  const items = options.map(opt => {
    const isSelected = opt.value === selected;
    const v = optionVisual(opt);
    const item = el('div', { className: `dropdown-option${isSelected ? ' selected' : ''}${opt.danger ? ' danger' : ''}`, tabIndex: -1 },
      ...(v ? [v] : []), el('span', { className: 'dd-option-label', text: opt.label }),
      el('span', { className: 'dd-check', text: isSelected ? '✓' : '' }));
    item.dataset.value = opt.value;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(isSelected));
    item.onclick = () => choose(opt.value);
    return item;
  });
  m.replaceChildren(...items);
  m.setAttribute('aria-label', ariaLabel);
  m.classList.remove('hidden');

  // Position below the trigger (above if there is no room), inside the viewport.
  const r = trigger.getBoundingClientRect();
  m.style.minWidth = `${Math.max(r.width, 160)}px`;
  m.style.left = '0px';
  m.style.top = '0px';
  const mh = m.offsetHeight;
  const mw = m.offsetWidth;
  const below = window.innerHeight - r.bottom;
  let top = below >= mh + 8 || below >= r.top ? r.bottom + 4 : r.top - mh - 4;
  top = Math.max(8, Math.min(top, window.innerHeight - mh - 8));
  m.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - mw - 8))}px`;
  m.style.top = `${top}px`;

  trigger.setAttribute('aria-expanded', 'true');
  current = { trigger, close };
  (items.find(i => i.dataset.value === selected) ?? items[0])?.focus();

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
  const trigger = el('button', { type: 'button', className: 'dropdown-trigger' }, visual, label, el('span', { className: 'dd-caret', text: '▾' }));
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
