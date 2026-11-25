// "New page" template picker, shown for ＋, the tree's row +, ↳ Sub-note, "/page" and the empty-state button.
import type { Note } from '../model';
import * as store from '../store';
import { CATEGORIES, createNoteFromTemplate, TEMPLATES, type Template } from '../templates';
import { $, $input, el } from './dom';
import { render, selectNote, shell, ui } from './state';

interface PickerOptions {
  /** Runs after the note is created, before it is opened (e.g. to insert a link to it). */
  onCreate?: (note: Note) => void;
}

let parentId: string | null = null;
let options: PickerOptions = {};

export function openTemplatePicker(parent: string | null, opts: PickerOptions = {}): void {
  parentId = parent;
  options = opts;
  const parentNote = store.getNote(parent);
  $('template-subtitle').textContent = parentNote
    ? `New sub-note under “${parentNote.title || 'Untitled'}”. Pick a template.`
    : 'Pick a template. You can change the category later.';

  const grid = $('template-grid');
  grid.replaceChildren(...TEMPLATES.map(t => {
    const card = el('button', { className: 'template-card', type: 'button', onclick: () => choose(t) },
      el('span', { className: 'template-icon', text: t.id === 'blank' ? '📄' : CATEGORIES[t.category].icon }),
      el('strong', { text: t.name }),
      el('span', { className: 'template-desc', text: t.description }),
    );
    card.dataset.template = t.id;
    return card;
  }));
  $('template-modal').classList.remove('hidden');
  (grid.firstElementChild as HTMLElement | null)?.focus();
}

export function closeTemplatePicker(): void {
  $('template-modal').classList.add('hidden');
  $('template-subtitle').textContent = ''; // may name the parent note, which must not outlive a lock
  parentId = null;
  options = {};
}

function choose(template: Template): void {
  const note = createNoteFromTemplate(template, parentId);
  const parent = store.getNote(parentId);
  if (parent?.collapsed) { parent.collapsed = false; store.touchNote(parent); }
  store.addNote(note);
  options.onCreate?.(note);
  closeTemplatePicker();
  selectNote(note.id);
  ui.activeTab = 'tree';
  shell.closeNav();
  render.all();
  $input('note-title').focus();
}

export function wireTemplatePicker(): void {
  const modal = $('template-modal');
  $('btn-close-templates').onclick = closeTemplatePicker;
  modal.addEventListener('mousedown', e => { if (e.target === modal) closeTemplatePicker(); });
  modal.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); closeTemplatePicker(); return; }
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const cards = [...$('template-grid').querySelectorAll<HTMLElement>('.template-card')];
    const i = cards.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    cards[(i + step + cards.length) % cards.length]?.focus();
  });
}
