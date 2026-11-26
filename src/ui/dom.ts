// Small DOM helpers. User content is only ever assigned through textContent or value.
import { py } from '../desktop/bridge';
import { DESKTOP } from '../platform';

export function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node;
}
export const $input = (id: string) => $(id) as HTMLInputElement;
export const $select = (id: string) => $(id) as HTMLSelectElement;

type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], 'style'>> & { text?: string };

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, props: Props<K> = {}, ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { text, ...rest } = props;
  // `type` first: changing an input's type afterwards would re-sanitise its value.
  const type = (rest as { type?: string }).type;
  if (type !== undefined) (node as HTMLInputElement).type = type;
  Object.assign(node, rest);
  if (text !== undefined) node.textContent = text;
  node.append(...children);
  return node;
}

/** Box-with-arrow "open in new window" icon (same drawing as the toolbar Pop-Out button). */
export const POPOUT_ICON = 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5';

/** Stroke icons (24×24, drawn with currentColor). In HTML: <span data-icon="name"></span>, see hydrateIcons. */
export const ICONS = {
  chevron: 'M6 9l6 6 6-6',
  check: 'M20 6 9 17l-5-5',
  subPage: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 11v6M9 14h6',
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  unpin: 'M12 17v5M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h12M15 9.34V6a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89M2 2l20 20',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  copy: 'M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  unlink: 'M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71M5.17 11.75l-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71M8 2v3M2 8h3M16 22v-3M22 16h-3',
  userPlus: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM19 8v6M22 11h-6',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  key: 'M2.5 21.5l9.6-9.6M16 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM6 18l2 2M9 15l2 2',
  layers: 'M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  cut: 'M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12',
  paste: 'M9 2h6v4H9zM16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2',
  selectAll: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 12l3 3 5-6',
  trash: 'M4 7h16M10 3h4a1 1 0 0 1 1 1v3H9V4a1 1 0 0 1 1-1zM6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6',
  arrowUp: 'M12 19V5M5 12l7-7 7 7',
  arrowDown: 'M12 5v14M19 12l-7 7-7-7',
  plus: 'M12 5v14M5 12h14',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  pin: 'M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
  turnInto: 'M4 7V4h16v3M9 20h6M12 4v16',
  folder: 'M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  table: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18',
  more: 'M5 11.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6zM12 11.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6zM19 11.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6z',
  power: 'M12 2v10M18.36 6.64a9 9 0 1 1-12.73 0',
  tray: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  rowAdd: 'M3 3h18v11H3zM3 8.5h18M9 3v11M15 3v11M12 17v5M9.5 19.5h5',
  colAdd: 'M3 3h11v18H3zM3 9h11M3 15h11M8.5 3v18M19.5 9v6M16.5 12h6',
} as const;
export type IconName = keyof typeof ICONS;

/** Replaces each <span data-icon="name"> placeholder in the page with its SVG (keeps its other classes). */
export function hydrateIcons(root: ParentNode = document): void {
  for (const slot of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    const name = slot.dataset.icon as IconName;
    if (!(name in ICONS)) continue;
    const svg = svgIcon(ICONS[name]);
    for (const c of slot.classList) svg.classList.add(c);
    slot.replaceWith(svg);
  }
}

/** Shows "Working…" on a button while keeping its icon and label to put back afterwards. */
export function setWorking(button: HTMLButtonElement, text = 'Working…'): () => void {
  const original = [...button.childNodes];
  button.textContent = text;
  return () => button.replaceChildren(...original);
}

/** Stroke icon drawn with currentColor (styled by the .icon class). */
export function svgIcon(path: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}

export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 4500): void {
  const item = el('div', { className: `toast ${kind}`, text: message });
  item.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  $('toasts').append(item);
  setTimeout(() => item.remove(), ms);
}

/** Resolves after the browser has painted, so a "Working…" state shows before blocking work. */
export const nextPaint = (): Promise<void> =>
  new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

export function autoResize(area: HTMLTextAreaElement): void {
  area.style.height = 'auto';
  area.style.height = `${area.scrollHeight}px`;
}

/**
 * Saves text as a file. Resolves to where it was saved (desktop), true (browser download started),
 * or null when the person cancelled the save dialog. With `quiet`, the caller reports the result.
 */
export async function download(filename: string, text: string, type = 'application/json', opts: { quiet?: boolean } = {}): Promise<string | true | null> {
  if (DESKTOP) {
    // The desktop window has no download bar: ask where to save with the system dialog.
    try {
      const saved = await py('save_text', filename, text);
      if (saved && !opts.quiet) toast(`Saved to ${saved}`);
      return saved;
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error', 7000);
      return null;
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
