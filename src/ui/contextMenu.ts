// Right-click menus for the desktop app. pywebview turns WebView2's own menu off, so without this a
// right-click does nothing. The website keeps the browser's menu (spellcheck, etc.): see main.ts.
//
// Regions (the tree, the page content) register a builder with addContextMenu. Right-clicking a text
// field adds Cut / Copy / Paste / Select all in front of the region's own items.
import { py } from '../desktop/bridge';
import { toast } from './dom';
import { openContextMenu, SEPARATOR, type DropdownOption } from './dropdown';

export interface ContextMenu { label: string; items: DropdownOption[]; onSelect: (value: string) => void }
type Builder = (e: MouseEvent) => ContextMenu | null;

const regions: { root: HTMLElement; build: Builder }[] = [];
export const addContextMenu = (root: HTMLElement, build: Builder): void => { regions.push({ root, build }); };

type Editable = HTMLInputElement | HTMLTextAreaElement;
const TEXT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password']);

function editable(target: EventTarget | null): Editable | null {
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement && TEXT_TYPES.has(target.type)) return target;
  return null;
}

function textItems(field: Editable): DropdownOption[] {
  const selected = (field.selectionEnd ?? 0) > (field.selectionStart ?? 0);
  const locked = field.readOnly || field.disabled;
  // Secrets have their own copy button, which clears the clipboard after 30 seconds.
  const secret = field.type === 'password';
  return [
    { value: 'text:cut', label: 'Cut', svg: 'cut', hint: 'Ctrl+X', disabled: !selected || locked || secret },
    { value: 'text:copy', label: 'Copy', svg: 'copy', hint: 'Ctrl+C', disabled: !selected || secret },
    { value: 'text:paste', label: 'Paste', svg: 'paste', hint: 'Ctrl+V', disabled: locked },
    { value: 'text:selectAll', label: 'Select all', svg: 'selectAll', hint: 'Ctrl+A', disabled: !field.value },
  ];
}

async function runText(action: string, field: Editable): Promise<void> {
  field.focus();
  if (action === 'text:selectAll') field.select();
  else if (action === 'text:copy') document.execCommand('copy');
  else if (action === 'text:cut') document.execCommand('cut');
  else if (action === 'text:paste') {
    let text = '';
    try { text = await py('clipboard_text'); } catch { /* treated as empty */ }
    if (!text) { toast('The clipboard has no text to paste.'); return; }
    field.focus();
    // insertText behaves like typing: it fires `input` (so the note saves) and keeps undo working.
    if (!document.execCommand('insertText', false, text)) {
      const start = field.selectionStart ?? field.value.length;
      field.setRangeText(text, start, field.selectionEnd ?? start, 'end');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
}

export function wireContextMenus(): void {
  document.addEventListener('contextmenu', e => {
    e.preventDefault();
    const target = e.target as Node;
    // The innermost registered region wins.
    const region = regions.filter(r => r.root.contains(target)).sort((a, b) => (a.root.contains(b.root) ? 1 : -1))[0];
    const menu = region?.build(e) ?? null;
    const field = editable(e.target);
    const text = field ? textItems(field) : [];
    if (!menu && !text.length) return;
    const items = menu ? (text.length ? [...text, SEPARATOR, ...menu.items] : menu.items) : text;

    // The keyboard menu key (or Shift+F10) reports no pointer position: open at the element instead.
    let { clientX: x, clientY: y } = e;
    if (x === 0 && y === 0 && target instanceof Element) {
      const r = target.getBoundingClientRect();
      x = r.left + 12;
      y = r.top + Math.min(r.height, 24);
    }
    openContextMenu(x, y, menu?.label ?? 'Edit', items, value => {
      if (value.startsWith('text:')) { if (field) void runText(value, field); }
      else menu?.onSelect(value);
    });
  });
}
