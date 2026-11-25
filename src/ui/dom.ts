// Small DOM helpers. User content is only ever assigned through textContent or value.

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

export function download(filename: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
