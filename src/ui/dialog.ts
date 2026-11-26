// In-app confirmation dialog (replaces window.confirm, which blocks the page and cannot be styled).
import { $, el } from './dom';

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive (red button, Cancel focused) unless false. */
  danger?: boolean;
  /** An optional list under the message, e.g. the fields a form adds. */
  details?: { icon?: string; text: string }[];
}

let resolver: ((ok: boolean) => void) | null = null;
let returnFocus: HTMLElement | null = null;

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  resolver?.(false);
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $('confirm-title').textContent = opts.title;
  $('confirm-message').textContent = opts.message;
  $('confirm-details').replaceChildren(...(opts.details ?? []).map(d =>
    el('li', {}, el('span', { className: 'cd-icon', text: d.icon ?? '•' }), el('span', { text: d.text }))));
  $('confirm-details').classList.toggle('hidden', !opts.details?.length);
  const ok = $('confirm-ok');
  ok.textContent = opts.confirmLabel ?? 'Delete';
  ok.classList.toggle('danger', opts.danger ?? true);
  $('confirm-cancel').textContent = opts.cancelLabel ?? 'Cancel';
  $('confirm-modal').classList.remove('hidden');
  // Destructive by default, so the safe choice gets focus; otherwise the main action does.
  requestAnimationFrame(() => $(opts.danger === false ? 'confirm-ok' : 'confirm-cancel').focus());
  return new Promise(resolve => { resolver = resolve; });
}

function finish(ok: boolean): void {
  if (!resolver) return;
  const resolve = resolver;
  resolver = null;
  $('confirm-modal').classList.add('hidden');
  // Messages name pages, so they must not stay in the (hidden) DOM after a lock.
  $('confirm-title').textContent = '';
  $('confirm-message').textContent = '';
  $('confirm-details').replaceChildren();
  if (returnFocus?.isConnected) returnFocus.focus();
  returnFocus = null;
  resolve(ok);
}

export const closeDialog = (): void => finish(false);

export function wireDialog(): void {
  const modal = $('confirm-modal');
  $('confirm-ok').onclick = () => finish(true);
  $('confirm-cancel').onclick = () => finish(false);
  modal.addEventListener('mousedown', e => { if (e.target === modal) finish(false); });
  modal.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); finish(false); return; }
    if (e.key === 'Tab') {
      // Keep focus inside the dialog.
      const ok = $('confirm-ok');
      const cancel = $('confirm-cancel');
      e.preventDefault();
      (document.activeElement === ok ? cancel : ok).focus();
    }
  });
}
