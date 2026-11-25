// In-app confirmation dialog (replaces window.confirm, which blocks the page and cannot be styled).
import { $ } from './dom';

interface ConfirmOptions { title: string; message: string; confirmLabel?: string; danger?: boolean }

let resolver: ((ok: boolean) => void) | null = null;
let returnFocus: HTMLElement | null = null;

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  resolver?.(false);
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $('confirm-title').textContent = opts.title;
  $('confirm-message').textContent = opts.message;
  const ok = $('confirm-ok');
  ok.textContent = opts.confirmLabel ?? 'Delete';
  ok.classList.toggle('danger', opts.danger ?? true);
  $('confirm-modal').classList.remove('hidden');
  // Destructive by default, so the safe choice gets focus.
  requestAnimationFrame(() => $('confirm-cancel').focus());
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
