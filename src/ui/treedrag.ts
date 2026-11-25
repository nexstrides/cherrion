// Drag and drop in the sidebar tree with pointer events, so it works with mouse, pen and touch.
// Mouse: drag after moving 5 px. Touch: long-press (~0.4 s) then drag; a quick swipe still scrolls.
// Dropping on the top/bottom quarter of a row places the note before/after it; the middle nests
// it inside. Empty space below the rows moves it to the end of the top level.
import * as store from '../store';
import { planMove, type DropPosition } from '../tree';
import { el } from './dom';

type Target = { id: string | null; pos: DropPosition };

export function wireTreeDrag(container: HTMLElement, onMove: (dragId: string, target: Target) => void): void {
  let pending: { id: string; row: HTMLElement; x: number; y: number; pointerId: number; touch: boolean; timer: number } | null = null;
  let drag: { id: string; row: HTMLElement; ghost: HTMLElement; target: Target | null; pointerId: number; x: number; y: number } | null = null;
  let suppressClick = false;
  let scrollFrame = 0;

  const cancelPending = () => { if (pending) { clearTimeout(pending.timer); pending = null; } };

  container.addEventListener('pointerdown', e => {
    if (e.button !== 0 || drag) return;
    const target = e.target as Element;
    const row = target.closest<HTMLElement>('.tree-row');
    if (!row?.dataset.noteId || target.closest('button, .tree-toggle')) return;
    const touch = e.pointerType !== 'mouse';
    pending = {
      id: row.dataset.noteId, row, x: e.clientX, y: e.clientY, pointerId: e.pointerId, touch,
      timer: touch ? window.setTimeout(() => start(), 400) : 0,
    };
  });

  window.addEventListener('pointermove', e => {
    if (pending && !drag && e.pointerId === pending.pointerId) {
      const dist = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
      if (pending.touch) { if (dist > 10) cancelPending(); } // finger moved first: it's a scroll
      else if (dist > 5) start();
    }
    if (drag && e.pointerId === drag.pointerId) {
      e.preventDefault();
      drag.x = e.clientX;
      drag.y = e.clientY;
      update();
    }
  }, { passive: false });
  window.addEventListener('pointerup', e => {
    if (drag && e.pointerId === drag.pointerId) finish(true);
    cancelPending();
  });
  window.addEventListener('pointercancel', () => { if (drag) finish(false); cancelPending(); });
  window.addEventListener('keydown', e => { if (drag && e.key === 'Escape') finish(false); });
  // While dragging on touch, stop the sidebar from scrolling instead.
  container.addEventListener('touchmove', e => { if (drag) e.preventDefault(); }, { passive: false });
  container.addEventListener('contextmenu', e => { if (pending || drag) e.preventDefault(); });
  // The click that ends a drag must not open the note under the pointer.
  container.addEventListener('click', e => {
    if (!suppressClick) return;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  function start(): void {
    const p = pending;
    if (!p) return;
    clearTimeout(p.timer);
    pending = null;
    const ghost = el('div', { className: 'drag-ghost', text: store.getNote(p.id)?.title || 'Untitled' });
    document.body.append(ghost);
    p.row.classList.add('dragging');
    document.body.classList.add('tree-dragging');
    drag = { id: p.id, row: p.row, ghost, target: null, pointerId: p.pointerId, x: p.x, y: p.y };
    navigator.vibrate?.(12);
    update();
    autoScroll();
  }

  function clearIndicators(): void {
    container.querySelectorAll('.drop-before, .drop-after, .drop-inside')
      .forEach(n => n.classList.remove('drop-before', 'drop-after', 'drop-inside'));
    container.classList.remove('drop-root');
  }

  function update(): void {
    const d = drag;
    if (!d) return;
    d.ghost.style.left = `${d.x + 14}px`;
    d.ghost.style.top = `${d.y + 10}px`;
    clearIndicators();
    d.target = null;
    const under = document.elementFromPoint(d.x, d.y);
    if (!under || !container.contains(under)) return;
    const row = under.closest<HTMLElement>('.tree-row');
    let target: Target;
    if (row?.dataset.noteId) {
      const r = row.getBoundingClientRect();
      const f = (d.y - r.top) / r.height;
      target = { id: row.dataset.noteId, pos: f < 0.28 ? 'before' : f > 0.72 ? 'after' : 'inside' };
    } else {
      target = { id: null, pos: 'inside' };
    }
    if (!planMove(store.activeNotes(), d.id, target.id, target.pos)) return;
    d.target = target;
    if (row && target.id) row.classList.add(`drop-${target.pos}`);
    else container.classList.add('drop-root');
  }

  // Scrolls the tree while the pointer is held near its top or bottom edge.
  function autoScroll(): void {
    if (!drag) return;
    const r = container.getBoundingClientRect();
    const edge = 36;
    const dy = drag.y < r.top + edge ? -8 : drag.y > r.bottom - edge ? 8 : 0;
    if (dy) { container.scrollTop += dy; update(); }
    scrollFrame = requestAnimationFrame(autoScroll);
  }

  function finish(commit: boolean): void {
    const d = drag;
    if (!d) return;
    drag = null;
    cancelAnimationFrame(scrollFrame);
    d.ghost.remove();
    d.row.classList.remove('dragging');
    document.body.classList.remove('tree-dragging');
    clearIndicators();
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 60);
    if (commit && d.target) onMove(d.id, d.target);
  }
}
