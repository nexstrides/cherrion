// Sticky board and floating pop-out windows. Both show notes as plain text: notes made only of
// paragraphs and to-dos are editable there; anything else (fields, headings, code…) is shown
// read-only with secrets masked, so the lossy plain-text round trip can never destroy data.
import { isPlainTextEditable, noteToPlainText, plainTextToBlocks, STICKY_COLORS, type Note } from '../model';
import * as store from '../store';
import { $, el, ICONS, POPOUT_ICON, svgIcon, toast } from './dom';
import { markActivity, render, selectNote, ui } from './state';

const popouts = new Set<Window>();
const titleOf = (id: string): string | undefined => { const n = store.getNote(id); return n && !n.deleted ? n.title : 'Deleted page'; };

/** Pop-outs show decrypted text, so they are closed whenever the vault locks. */
export function closeAllPopouts(): void {
  for (const win of popouts) { try { win.close(); } catch { /* already closed */ } }
  popouts.clear();
}

export function renderStickyBoard(): void {
  const stickies = store.activeNotes().filter(n => n.isSticky);
  $('sticky-count').textContent = String(stickies.length);
  const grid = $('sticky-grid');
  if (!stickies.length) {
    grid.replaceChildren(el('p', { className: 'muted', text: 'No pinned stickies yet. Open any note and click "📌 Pin Sticky".' }));
    return;
  }
  grid.replaceChildren(...stickies.map(stickyCard));
}

function stickyCard(note: Note): HTMLElement {
  const title = el('input', { className: 'sticky-card-title', value: note.title || 'Untitled', type: 'text' });
  title.setAttribute('aria-label', 'Sticky title');
  title.onchange = () => { note.title = title.value; store.touchNote(note); render.tree(); };

  const head = el('div', { className: 'sticky-card-head' },
    title,
    el('button', { className: 'sticky-mini sticky-popout', type: 'button', title: 'Pop out as a floating window', onclick: () => void openFloatingSticky(note.id) },
      svgIcon(POPOUT_ICON), 'Pop-Out'),
  );

  let body: HTMLElement;
  if (isPlainTextEditable(note)) {
    const area = el('textarea', { className: 'sticky-card-body', value: noteToPlainText(note) });
    area.setAttribute('aria-label', 'Sticky text');
    area.addEventListener('input', () => { note.blocks = plainTextToBlocks(area.value); store.touchNote(note); });
    body = area;
  } else {
    body = el('div', { className: 'sticky-card-body readonly', text: noteToPlainText(note, titleOf), title: 'Open in the editor to change fields and formatted blocks' });
  }

  const foot = el('div', { className: 'sticky-card-foot' },
    el('button', {
      className: 'sticky-mini', type: 'button', title: 'Open this page in the editor',
      onclick: () => { selectNote(note.id); ui.activeTab = 'tree'; render.all(); },
    }, svgIcon(ICONS.edit), 'Open'),
    el('button', {
      className: 'sticky-mini sticky-unpin', type: 'button', title: 'Remove from the sticky board (the page is kept)',
      onclick: () => { note.isSticky = false; store.touchNote(note); render.all(); },
    }, svgIcon(ICONS.unpin), 'Unpin'),
  );

  return el('div', { className: `sticky-card sticky-${note.stickyColor}` }, head, body, foot);
}

export async function openFloatingSticky(noteId: string): Promise<void> {
  const note = store.getNote(noteId);
  if (!note || note.deleted) return;
  note.isSticky = true;
  store.touchNote(note);
  render.all();

  let win: Window | null;
  try {
    win = window.documentPictureInPicture
      ? await window.documentPictureInPicture.requestWindow({ width: 320, height: 360 })
      : window.open('', `sticky_${noteId}`, 'width=320,height=360,resizable=yes');
  } catch {
    win = null;
  }
  if (!win) {
    toast('Pop-out was blocked. Allow pop-ups for this site to float sticky notes.', 'error');
    return;
  }
  popouts.add(win);
  win.addEventListener('pagehide', () => popouts.delete(win));
  for (const type of ['keydown', 'pointerdown'] as const) win.addEventListener(type, markActivity, { capture: true });

  const doc = win.document;
  doc.title = `📌 ${note.title || 'Sticky Note'}`;
  doc.body.replaceChildren();
  doc.body.style.cssText = `margin:0;padding:12px;background:${STICKY_COLORS[note.stickyColor]};font-family:sans-serif;display:flex;flex-direction:column;height:100vh;box-sizing:border-box;color:#222;`;

  // The window can outlive this Note object (sync or another tab may replace it), so every
  // edit looks the note up again instead of holding on to `note`.
  const live = (): Note | null => {
    const current = store.getNote(noteId);
    return current && !current.deleted ? current : null;
  };

  const titleInput = doc.createElement('input');
  titleInput.value = note.title;
  titleInput.placeholder = 'Sticky Title';
  titleInput.style.cssText = 'border:none;background:transparent;font-weight:700;font-size:16px;outline:none;margin-bottom:8px;color:#222;';
  titleInput.addEventListener('input', () => {
    const current = live();
    if (!current) return;
    current.title = titleInput.value;
    doc.title = `📌 ${current.title || 'Sticky Note'}`;
    store.touchNote(current);
    render.tree();
    if (ui.activeNoteId === noteId) render.editor();
  });

  const textStyle = 'flex:1;border:none;background:transparent;outline:none;font-family:inherit;font-size:14px;line-height:1.5;color:#222;';
  if (isPlainTextEditable(note)) {
    const area = doc.createElement('textarea');
    area.value = noteToPlainText(note);
    area.placeholder = 'Jot quick thoughts...';
    area.style.cssText = `${textStyle}resize:none;`;
    area.addEventListener('input', () => {
      const current = live();
      if (!current || !isPlainTextEditable(current)) return;
      current.blocks = plainTextToBlocks(area.value);
      store.touchNote(current);
      if (ui.activeNoteId === noteId) render.editor();
    });
    doc.body.append(titleInput, area);
  } else {
    const view = doc.createElement('div');
    view.textContent = noteToPlainText(note, titleOf);
    view.style.cssText = `${textStyle}white-space:pre-wrap;overflow:auto;`;
    const hint = doc.createElement('div');
    hint.textContent = 'Read-only: this note has fields or formatted blocks. Edit it in Cherrion.';
    hint.style.cssText = 'font-size:11px;opacity:0.7;margin-top:6px;';
    doc.body.append(titleInput, view, hint);
  }
}
