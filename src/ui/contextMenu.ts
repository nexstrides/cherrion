// Right-click menus for the sidebar tree and the page content, on the website and in the desktop app.
//
// Regions (the tree, the page content) register a builder with addContextMenu. Right-clicking a text
// field adds Cut / Copy / Paste / Select all in front of the region's own items.
//
// Desktop: pywebview turns WebView2's own menu off, so every right-click is handled here.
// Website: only the registered regions get this menu; everywhere else, and with Shift+right-click
// anywhere, the browser's own menu opens (spelling suggestions, translate, password manager…).
import { py } from '../desktop/bridge';
import { DESKTOP } from '../platform';
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

/** Clipboard text: through Python on the desktop, the Clipboard API on the website (it may ask first). */
async function clipboardText(): Promise<string | null> {
  try {
    return DESKTOP ? await py('clipboard_text') : await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

async function runText(action: string, field: Editable): Promise<void> {
  field.focus();
  if (action === 'text:selectAll') field.select();
  else if (action === 'text:copy') document.execCommand('copy');
  else if (action === 'text:cut') document.execCommand('cut');
  else if (action === 'text:paste') {
    const text = await clipboardText();
    if (text === null && !DESKTOP) { toast('The browser did not allow reading the clipboard. Press Ctrl+V to paste.'); return; }
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

/** On the website, a reminder that the browser's own menu is one Shift away (e.g. for spelling). */
const BROWSER_MENU_HINT: DropdownOption = { value: 'browser-menu', label: 'Browser menu', svg: 'more', hint: 'Shift+right-click', disabled: true };

/** How the last press was made: a touch long-press also fires `contextmenu`. */
let lastPointer = 'mouse';

export function wireContextMenus(): void {
  document.addEventListener('pointerdown', e => { lastPointer = e.pointerType; }, true);
  document.addEventListener('contextmenu', e => {
    if (!DESKTOP && e.shiftKey) return; // the browser's own menu
    // Website on a phone or tablet: a long-press selects text, or (in the tree) starts dragging a page.
    const pointer = (e as Partial<PointerEvent>).pointerType || lastPointer;
    if (!DESKTOP && pointer === 'touch') return;
    const target = e.target as Node;
    // The innermost registered region wins.
    const region = regions.filter(r => r.root.contains(target)).sort((a, b) => (a.root.contains(b.root) ? 1 : -1))[0];
    if (!region && !DESKTOP) return; // outside the tree and the page: the browser's menu
    const menu = region?.build(e) ?? null;
    const field = editable(e.target);
    const text = field ? textItems(field) : [];
    if (DESKTOP) e.preventDefault(); // WebView2 has no menu of its own to fall back to
    if (!menu && !text.length) return; // website: nothing of ours here, so the browser's menu opens
    e.preventDefault();
    let items = menu ? (text.length ? [...text, SEPARATOR, ...menu.items] : menu.items) : text;
    if (!DESKTOP && field) items = [...items, SEPARATOR, BROWSER_MENU_HINT];

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
