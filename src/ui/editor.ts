// Block editor. Typing only mutates the model and calls store.touchNote (no re-render, so the
// cursor survives); structural edits re-render and then restore focus with focusBlock/focusField.
import {
  CATEGORY_IDS, field, fieldsBlock, isSecretKind, isTextBlock, SECRET_MASK, STICKY_COLORS, tableBlock, textBlock, uid,
  type Block, type CategoryId, type Field, type FieldKind, type FieldsBlock, type FileBlock, type ImageBlock, type Note, type PageBlock,
  type StickyColor, type TextBlock, type TextBlockType,
} from '../model';
import * as store from '../store';
import { applyForm, CATEGORIES, describeForm, formForCategory, hasForm } from '../templates';
import { confirmDialog } from './dialog';
import { $, $input, autoResize, el, toast } from './dom';
import { addContextMenu, type ContextMenu } from './contextMenu';
import { createDropdown, createMenuButton, mountDropdown, openContextMenu, SEPARATOR, type Dropdown, type DropdownOption } from './dropdown';
import { proxyFields, syncProxyFields } from '../proxy';
import { parseTotp, secondsRemaining, totpCode, type TotpParams } from '../totp';
import { openTemplatePicker } from './picker';
import { render, selectNote, ui } from './state';
import { addPictures, choosePictureFiles, pictureFiles, renderImage } from './images';
import { attachFile, fileProblem, releaseFile } from '../files';
import { chooseFiles, fileErrorMessage, renderFileBlock } from './fileBlock';
import { scanQrCode } from './qrScan';
import { focusCell, renderTable } from './tableBlock';
import { createTotpDisplay } from './totpWidget';

type SlashType = TextBlockType | 'divider' | 'fields' | 'secret' | 'totp' | 'page' | 'table' | 'image' | 'file';
interface SlashCommand { type: SlashType; label: string; icon: string; hint: string }

const SLASH_COMMANDS: SlashCommand[] = [
  { type: 'p', label: 'Text', icon: '¶', hint: 'Plain paragraph' },
  { type: 'page', label: 'Page', icon: '📄', hint: 'New sub-page from a template' },
  { type: 'h1', label: 'Heading 1', icon: 'H1', hint: 'Large section title' },
  { type: 'h2', label: 'Heading 2', icon: 'H2', hint: 'Medium heading' },
  { type: 'todo', label: 'To-do Checkbox', icon: '☑', hint: 'Track tasks' },
  { type: 'callout', label: 'Callout', icon: '💡', hint: 'Highlighted note' },
  { type: 'quote', label: 'Quote', icon: '❝', hint: 'Blockquote' },
  { type: 'code', label: 'Code Block', icon: '<>', hint: 'Monospace snippet' },
  { type: 'table', label: 'Table', icon: '▦', hint: 'Rows and columns' },
  { type: 'image', label: 'Picture', icon: '🖼', hint: 'Add a picture from a file (you can also paste or drop one)' },
  { type: 'file', label: 'File', icon: '📎️', hint: 'Attach a PDF, Word, ZIP, text… file up to 10 MB (or drop one)' },
  { type: 'divider', label: 'Divider', icon: '―', hint: 'Horizontal line' },
  { type: 'fields', label: 'Field group', icon: '▤', hint: 'Labelled inputs' },
  { type: 'secret', label: 'Secret field', icon: '🔒', hint: 'Hidden value with copy' },
  { type: 'totp', label: '2FA code', icon: '🔐', hint: 'Live authenticator code from a secret key' },
];

const MARKDOWN_SHORTCUTS: { prefix: string; type: TextBlockType }[] = [
  { prefix: '# ', type: 'h1' }, { prefix: '## ', type: 'h2' },
  { prefix: '[] ', type: 'todo' }, { prefix: '[ ] ', type: 'todo' },
  { prefix: '> ', type: 'quote' }, { prefix: '``` ', type: 'code' },
];

const CLIPBOARD_CLEAR_MS = 30_000;

const slash = { open: false, blockId: null as string | null, filter: '', selectedIdx: 0 };

export function currentNote(): Note | null {
  const note = store.getNote(ui.activeNoteId);
  return note && !note.deleted ? note : null;
}

/** The note and its ancestors, top level first. */
function breadcrumbTrail(note: Note): Note[] {
  const trail: Note[] = [];
  const seen = new Set<string>();
  let curr: Note | undefined = note;
  while (curr && !seen.has(curr.id)) {
    seen.add(curr.id);
    trail.unshift(curr);
    const parent: Note | undefined = curr.parentId ? store.getNote(curr.parentId) : undefined;
    curr = parent && !parent.deleted ? parent : undefined;
  }
  return trail;
}

export function openNote(id: string): void {
  selectNote(id);
  ui.activeTab = 'tree';
  render.all();
}

/** Ancestors are buttons that open that page; the current page is plain text. */
export function renderBreadcrumbs(note: Note | null): void {
  const nav = $('breadcrumbs');
  if (!note) { nav.replaceChildren(); return; }
  const trail = breadcrumbTrail(note);
  const parts: HTMLElement[] = [];
  trail.forEach((n, i) => {
    const name = n.title || 'Untitled';
    if (i) parts.push(el('span', { className: 'crumb-sep', text: '/' }));
    if (i === trail.length - 1) {
      const cur = el('span', { className: 'crumb current', text: name, title: name });
      cur.setAttribute('aria-current', 'page');
      parts.push(cur);
    } else {
      parts.push(el('button', { className: 'crumb', type: 'button', text: name, title: `Open “${name}”`, onclick: () => openNote(n.id) }));
    }
  });
  nav.replaceChildren(...parts);
}

// ---- Rendering ----

const STICKY_COLOR_OPTIONS = (Object.keys(STICKY_COLORS) as StickyColor[]).map(c => ({
  value: c, label: c[0]!.toUpperCase() + c.slice(1), swatch: STICKY_COLORS[c],
}));
let colorDropdown: Dropdown | null = null;

function stickyColorDropdown(): Dropdown {
  colorDropdown ??= mountDropdown('sticky-color-select', {
    className: 'dd-compact-narrow',
    ariaLabel: 'Sticky color',
    options: STICKY_COLOR_OPTIONS,
    value: 'yellow',
    onChange: v => {
      const note = currentNote();
      if (!note) return;
      note.stickyColor = v as StickyColor;
      store.touchNote(note);
      render.stickies();
    },
  });
  return colorDropdown;
}

export function renderEditor(): void {
  const note = currentNote();
  const empty = $('empty-state');
  const container = $('note-container');
  const actions = $('note-actions');
  const blocksEl = $('blocks-container');
  renderBreadcrumbs(note);

  if (!note) {
    empty.classList.remove('hidden');
    container.classList.add('hidden');
    actions.classList.add('hidden');
    blocksEl.replaceChildren();
    return;
  }

  empty.classList.add('hidden');
  container.classList.remove('hidden');
  actions.classList.remove('hidden');

  const title = $('note-title') as HTMLTextAreaElement;
  title.value = note.title;
  title.placeholder = CATEGORIES[note.category].titlePlaceholder;
  requestAnimationFrame(() => autoResize(title));
  renderMeta(note);

  const pinBtn = $('btn-pin-sticky');
  const pinLabel = note.isSticky ? 'Pinned' : 'Pin Sticky';
  pinBtn.classList.toggle('active', note.isSticky);
  pinBtn.setAttribute('aria-pressed', String(note.isSticky));
  pinBtn.setAttribute('aria-label', pinLabel);
  pinBtn.title = note.isSticky ? 'Unpin from the sticky board' : 'Pin to the sticky board';
  const label = pinBtn.querySelector('.btn-label');
  if (label) label.textContent = ` ${pinLabel}`;
  stickyColorDropdown().setValue(note.stickyColor);

  blocksEl.replaceChildren(...note.blocks.map(block => renderBlock(note, block)));

  // Viewers of a shared workspace can read (and copy) but not change anything.
  const readOnly = store.isReadOnly(store.spaceOf(note.id));
  container.classList.toggle('read-only', readOnly);
  actions.classList.toggle('read-only', readOnly);
  $('readonly-banner').classList.toggle('hidden', !readOnly);
  title.readOnly = readOnly;
  if (readOnly) lockEditing(blocksEl);
}

/** Makes rendered blocks read-only: text can be selected and copied, nothing can be typed or toggled. */
function lockEditing(root: HTMLElement): void {
  for (const node of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) {
    if (node.type === 'checkbox') node.disabled = true;
    else { node.readOnly = true; node.placeholder = ''; }
  }
  for (const node of root.querySelectorAll<HTMLElement>('[contenteditable="true"]')) node.contentEditable = 'false';
}

/** Keys that only move, select or copy, which a viewer may use in a read-only page. */
function readingKey(e: KeyboardEvent): boolean {
  if (e.key.startsWith('Arrow') || ['Home', 'End', 'PageUp', 'PageDown', 'Tab', 'Escape', 'Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return true;
  return (e.ctrlKey || e.metaKey) && ['c', 'a', 'f'].includes(e.key.toLowerCase());
}

/** Read-only pages: block keys (Enter, Backspace, /…), paste, drop and cut before the editor sees them. */
export function wireReadOnlyGuard(): void {
  const container = $('note-container');
  const readOnly = () => container.classList.contains('read-only');
  container.addEventListener('keydown', e => { if (readOnly() && !readingKey(e)) { e.preventDefault(); e.stopPropagation(); } }, true);
  for (const type of ['paste', 'drop', 'cut'] as const) {
    container.addEventListener(type, e => { if (readOnly()) { e.preventDefault(); e.stopPropagation(); } }, true);
  }
}

function renderMeta(note: Note): void {
  const category = createDropdown({
    className: 'meta-dropdown',
    ariaLabel: 'Category',
    options: CATEGORY_IDS.map(id => ({ value: id, label: CATEGORIES[id].label, icon: CATEGORIES[id].icon })),
    value: note.category,
    onChange: v => {
      note.category = v as CategoryId;
      store.touchNote(note);
      $input('note-title').placeholder = CATEGORIES[note.category].titlePlaceholder;
      render.tree();
      void offerCategoryForm(note.id);
    },
  });
  const info = el('span', { className: 'meta-info', text: `Updated ${new Date(note.updatedAt).toLocaleString()} • ${note.blocks.length} block(s)` });
  if (store.isReadOnly(store.spaceOf(note.id))) {
    const { icon, label } = CATEGORIES[note.category];
    $('note-meta').replaceChildren(el('span', { className: 'meta-category', text: `${icon} ${label}` }), info);
    return;
  }
  $('note-meta').replaceChildren(category.el, info);
}

/** After a category change: offers to add that category's predefined form (unless the page has it). */
async function offerCategoryForm(noteId: string): Promise<void> {
  const before = store.getNote(noteId);
  if (!before || before.deleted) return;
  const category = before.category;
  const template = formForCategory(category);
  if (!template || hasForm(before, template)) return;
  const { label, icon } = CATEGORIES[category];
  const blank = before.blocks.every(b => b.type === 'p' && !b.content.trim());
  const ok = await confirmDialog({
    title: `Add the ${label} form?`,
    message: blank
      ? `${icon} This page is now ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}. Fill it with the ${label} form:`
      : `${icon} This page is now ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}. Add the ${label} form at the top? Nothing on the page is removed.`,
    details: describeForm(template),
    confirmLabel: 'Add form',
    cancelLabel: 'Not now',
    danger: false,
  });
  // The page may have been replaced (sync) or changed again while the dialog was open.
  const note = store.getNote(noteId);
  if (!ok || !note || note.deleted || note.category !== category || hasForm(note, template)) return;
  const first = applyForm(note, template);
  store.touchNote(note);
  if (ui.activeNoteId !== noteId) return;
  renderEditor();
  const firstField = first?.type === 'fields' ? first.fields[0] : undefined;
  if (firstField) focusField(firstField.id, firstField.kind === 'totp' ? 'label' : 'value');
  else if (first) focusBlock(first.id);
}

function ctrlButton(text: string, label: string, onclick: () => void): HTMLButtonElement {
  const b = el('button', { className: 'block-ctrl-btn', text, title: label, type: 'button', onclick });
  b.setAttribute('aria-label', label);
  return b;
}

function renderBlock(note: Note, block: Block): HTMLElement {
  const checked = block.type === 'todo' && block.checked;
  const row = el('div', { className: `block-row block-${block.type}${checked ? ' checked' : ''}` });
  row.dataset.blockId = block.id;

  // Wide screens show the three buttons in the left margin; narrow screens show one ⋮ menu (CSS decides).
  const actions = (action: string) => {
    if (action === 'up') moveBlock(note, block.id, -1);
    else if (action === 'down') moveBlock(note, block.id, 1);
    else if (action === 'delete') void confirmRemoveBlock(note, block);
  };
  const ctrls = el('div', { className: 'block-controls' },
    ctrlButton('↑', 'Move block up', () => actions('up')),
    ctrlButton('↓', 'Move block down', () => actions('down')),
    ctrlButton('✕', 'Delete block', () => actions('delete')),
    createMenuButton({
      className: 'block-menu',
      text: '⋮',
      ariaLabel: 'Block actions',
      items: [
        { value: 'up', label: 'Move up', icon: '↑' },
        { value: 'down', label: 'Move down', icon: '↓' },
        { value: 'delete', label: 'Delete', icon: '✕', danger: true },
      ],
      onSelect: actions,
    }),
  );
  const body = el('div', { className: 'block-body' });

  if (block.type === 'divider') body.append(el('hr', { className: 'block-divider' }));
  else if (block.type === 'fields') renderFields(note, block, body);
  else if (block.type === 'page') renderPageLink(block, body);
  else if (block.type === 'table') {
    renderTable(note, block, body, {
      rerender: renderEditor,
      leave: dir => {
        const next = note.blocks[indexOf(note, block.id) + dir];
        if (next) focusBlock(next.id, dir < 0);
        else if (dir > 0) addBlockAtEnd(note);
      },
    });
  } else if (block.type === 'image') renderImage(note, block, body);
  else if (block.type === 'file') renderFileBlock(note, block, body);
  else renderTextBlock(note, block, row, body);

  row.append(ctrls, body);
  return row;
}

/** Adds picture files after `afterId` and shows them (used by "/picture", paste and drop). */
async function insertPictures(noteId: string, files: File[], afterId: string | null): Promise<ImageBlock[]> {
  if (files.length) toast(files.length === 1 ? 'Adding picture…' : `Adding ${files.length} pictures…`, 'info', 1500);
  const added = await addPictures(noteId, files, afterId);
  if (added.length && ui.activeNoteId === noteId) {
    renderEditor();
    focusBlock(added[added.length - 1]!.id);
  }
  return added;
}

/** Attaches files after `afterId` (used by "/file" and drop). Each is encrypted and stored first. */
async function insertFiles(noteId: string, files: File[], afterId: string | null): Promise<FileBlock[]> {
  const added: FileBlock[] = [];
  for (const file of files) {
    const problem = fileProblem(file);
    if (problem) { toast(problem, 'error', 8000); continue; }
    if (store.isReadOnly(store.spaceOf(noteId))) { toast('You can view this workspace but not change it.'); break; }
    toast(`Adding “${file.name}”…`, 'info', 2500);
    try {
      const block = await attachFile(file);
      const note = store.getNote(noteId);
      if (!note || note.deleted) { void releaseFile(block.fileId); break; }
      const at = afterId ? indexOf(note, afterId) : -1;
      note.blocks.splice(at >= 0 ? at + 1 : note.blocks.length, 0, block);
      afterId = block.id;
      store.touchNote(note);
      added.push(block);
    } catch (err) {
      toast(fileErrorMessage(err), 'error', 8000);
    }
  }
  if (added.length && ui.activeNoteId === noteId) {
    renderEditor();
    focusBlock(added[added.length - 1]!.id);
  }
  return added;
}

/** Paste a picture into a page, or drop picture files (or other files) onto it. Other drops never navigate away. */
export function wireEditorPictures(): void {
  const view = $('editor-view');
  view.addEventListener('paste', e => {
    const files = pictureFiles(e.clipboardData);
    const note = currentNote();
    if (!files.length || !note) return;
    e.preventDefault();
    const row = (e.target as Element | null)?.closest?.<HTMLElement>('.block-row');
    void insertPictures(note.id, files, row?.dataset.blockId ?? null);
  });
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  view.addEventListener('dragover', e => {
    if (!hasFiles(e) || !currentNote()) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    view.classList.add('drop-target');
  });
  view.addEventListener('dragleave', e => { if (!view.contains(e.relatedTarget as Node | null)) view.classList.remove('drop-target'); });
  view.addEventListener('drop', e => {
    view.classList.remove('drop-target');
    const note = currentNote();
    const files = pictureFiles(e.dataTransfer);
    const others = [...(e.dataTransfer?.files ?? [])].filter(f => !files.includes(f));
    if (!note || (!files.length && !others.length)) return;
    e.preventDefault();
    const row = (e.target as Element | null)?.closest?.<HTMLElement>('.block-row');
    const after = row?.dataset.blockId ?? note.blocks[note.blocks.length - 1]?.id ?? null;
    void (async () => {
      const pictures = files.length ? await insertPictures(note.id, files, after) : [];
      if (others.length) await insertFiles(note.id, others, pictures[pictures.length - 1]?.id ?? after);
    })();
  });
  // A file dropped anywhere else would make the window open it and leave the app.
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', e => { if (hasFiles(e)) e.preventDefault(); });
}

function renderPageLink(block: PageBlock, body: HTMLElement): void {
  const target = store.getNote(block.pageId);
  const alive = !!target && !target.deleted;
  const link = el('button', { className: `page-link${alive ? '' : ' missing'}`, type: 'button', disabled: !alive },
    el('span', { className: 'page-link-icon', text: alive ? CATEGORIES[target.category].icon : '📄' }),
    el('span', { className: 'page-link-title', text: alive ? target.title || 'Untitled' : 'Deleted page' }),
  );
  if (alive) link.onclick = () => openNote(target.id);
  body.append(link);
}

function renderTextBlock(note: Note, block: TextBlock, row: HTMLElement, body: HTMLElement): void {
  if (block.type === 'todo') {
    const cb = el('input', { type: 'checkbox', checked: !!block.checked });
    cb.setAttribute('aria-label', 'Done');
    cb.onchange = () => {
      block.checked = cb.checked;
      row.classList.toggle('checked', cb.checked);
      store.touchNote(note);
    };
    body.append(cb);
  }
  const ta = el('textarea', {
    className: 'block-input',
    rows: 1,
    value: block.content,
    placeholder: block.type === 'p' ? "Type '/' for commands..." : `${block.type.toUpperCase()}...`,
  });
  ta.addEventListener('input', () => {
    block.content = ta.value;
    autoResize(ta);
    if (checkMarkdownShortcuts(note, block, ta.value)) return;
    checkSlashMenu(note, block, ta);
    store.touchNote(note);
  });
  ta.addEventListener('keydown', e => handleBlockKeydown(e, note, block, ta));
  ta.addEventListener('blur', () => { if (slash.open && slash.blockId === block.id) closeSlashMenu(); });
  body.append(ta);
  requestAnimationFrame(() => autoResize(ta));
}

// ---- Field groups ----

function toolButton(text: string, label: string, onclick: () => void): HTMLButtonElement {
  const b = el('button', { className: 'fg-tool', text, title: label, type: 'button', onclick });
  b.setAttribute('aria-label', label);
  return b;
}

/** Marks a control that changes the page (hidden on read-only pages). */
function editOnly<T extends HTMLElement>(node: T): T {
  node.classList.add('edit-only');
  return node;
}

function renderFields(note: Note, block: FieldsBlock, body: HTMLElement): void {
  const group = el('div', { className: 'fg' });
  for (const f of block.fields) group.append(renderFieldRow(note, block, f));

  const add = (kind: FieldKind) => {
    const f = field(kind === 'totp' ? '2FA code' : kind === 'secret-text' ? 'Secret note' : '', kind);
    block.fields.push(f);
    if (kind === 'totp') ui.editing.add(f.id);
    // A new secret note opens for typing; it is hidden again when the page changes or locks.
    if (kind === 'secret-text') ui.revealed.add(f.id);
    store.touchNote(note);
    renderEditor();
    focusField(f.id, kind === 'totp' || kind === 'secret-text' ? 'value' : 'label');
  };
  group.append(el('div', { className: 'fg-actions' },
    el('button', { className: 'fg-add', type: 'button', text: '+ Field', onclick: () => add('text') }),
    el('button', { className: 'fg-add', type: 'button', text: '+ Secret field', onclick: () => add('password') }),
    el('button', { className: 'fg-add', type: 'button', text: '+ Secret note', title: 'Hidden multi-line text, e.g. recovery codes or a license', onclick: () => add('secret-text') }),
    el('button', { className: 'fg-add', type: 'button', text: '+ 2FA code', onclick: () => add('totp') }),
  ));
  body.append(group);
}

function renderFieldRow(note: Note, block: FieldsBlock, f: Field): HTMLElement {
  const secret = isSecretKind(f.kind);
  const revealed = ui.revealed.has(f.id);
  const row = el('div', { className: `fg-row${secret ? ' is-secret' : ''}` });
  row.dataset.fieldId = f.id;

  const label = el('input', { className: 'fg-label', value: f.label, placeholder: 'Label', type: 'text' });
  label.setAttribute('aria-label', 'Field label');
  label.addEventListener('input', () => { f.label = label.value; store.touchNote(note); });

  const value = el('div', { className: 'fg-value' });
  const valueLabel = f.label || 'Field value';
  if (f.locked) {
    // Sealed with the workspace's secrets key, which viewers do not get: nothing to show or copy.
    row.classList.add('is-locked');
    value.append(el('span', {
      className: 'secret-locked', text: '🔒 Hidden from viewers',
      title: 'The workspace owner hides secret fields (passwords, secret notes, 2FA codes) from viewers.',
    }));
    row.append(label, value, el('div', { className: 'fg-tools' }, editOnly(toolButton('✕', 'Remove field', () => void confirmRemoveField(note, block, f)))));
    return row;
  }
  if (f.kind === 'totp') return renderTotpRow(note, block, f, row, label);
  if (f.kind === 'secret-text' && !revealed) {
    // A click copies it, like 📋 (👁 shows it for editing). An empty one opens for typing.
    const mask = el('button', {
      className: `secret-mask${f.value ? ' copy-on-click' : ''}`,
      type: 'button',
      text: f.value ? `${SECRET_MASK}  hidden · click to copy` : 'Empty. Click to add.',
      title: f.value ? 'Click to copy. 👁 shows it for editing.' : '',
      onclick: () => (f.value ? void copyText(f.value, f.label || 'Secret', true) : setRevealed(f.id, true)),
    });
    mask.setAttribute('aria-label', f.value ? `Copy ${valueLabel}` : `Add ${valueLabel}`);
    value.append(mask);
  } else if (f.kind === 'secret-text') {
    const area = el('textarea', { className: 'fg-input secret-area', value: f.value, rows: 3, spellcheck: false });
    area.setAttribute('aria-label', valueLabel);
    area.addEventListener('input', () => { f.value = area.value; autoResize(area); store.touchNote(note); });
    requestAnimationFrame(() => autoResize(area));
    value.append(area);
  } else {
    const inputType = f.kind === 'password' ? (revealed ? 'text' : 'password') : f.kind;
    const input = el('input', { className: 'fg-input', type: inputType, value: f.value, placeholder: f.hint ?? '' });
    input.setAttribute('aria-label', valueLabel);
    input.autocomplete = f.kind === 'password' ? 'new-password' : 'off';
    if (secret) input.spellcheck = false;
    input.addEventListener('input', e => {
      const before = f.value;
      f.value = input.value;
      syncProxyInPage(block, f, before, (e as InputEvent).inputType === 'insertFromPaste');
      store.touchNote(note);
    });
    if (f.kind === 'password' && !revealed && f.value) {
      // A hidden secret copies on click (or Enter), like 📋; 👁 shows it for editing. Empty ones
      // stay normal inputs, so a new secret can be typed or pasted straight in.
      input.readOnly = true;
      input.classList.add('copy-on-click');
      input.title = 'Click to copy. 👁 shows it for editing.';
      input.setAttribute('aria-label', `${valueLabel} (hidden). Press Enter to copy`);
      const copy = () => void copyText(f.value, f.label || 'Value', true);
      input.addEventListener('click', copy);
      input.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copy(); } });
    }
    value.append(input);
  }

  const tools = el('div', { className: 'fg-tools' });
  if (secret) tools.append(toolButton(revealed ? '🙈' : '👁', revealed ? 'Hide value' : 'Reveal value', () => setRevealed(f.id, !revealed)));
  tools.append(
    toolButton('📋', 'Copy value', () => void copyText(f.value, f.label || 'Value', secret)),
    editOnly(toolButton('✕', 'Remove field', () => void confirmRemoveField(note, block, f))),
  );

  row.append(label, value, tools);
  return row;
}

/**
 * Proxy forms: a pasted "ip:port:user:password" link fills the IP address, port, user and password
 * fields, and editing those rebuilds the link. Inputs are updated in place, so the cursor stays put.
 */
function syncProxyInPage(block: FieldsBlock, edited: Field, before: string, pasted: boolean): void {
  const changed = syncProxyFields(block, edited, before);
  for (const f of changed) {
    const input = document.querySelector<HTMLInputElement>(`[data-field-id="${CSS.escape(f.id)}"] .fg-input`);
    if (!input) continue;
    input.value = f.value;
    input.classList.remove('autofilled');
    void input.offsetWidth; // restart the highlight
    input.classList.add('autofilled');
  }
  if (pasted && changed.length && changed.every(f => f !== edited) && proxyFields(block)?.link === edited) {
    toast('Filled IP address, port, user and password from the link.');
  }
}

/**
 * 2FA field: shows the live 6-digit code with a countdown ring, like an authenticator app.
 * ✎ switches to editing the stored secret key (masked, with 👁 to show it).
 */
function renderTotpRow(note: Note, block: FieldsBlock, f: Field, row: HTMLElement, label: HTMLInputElement): HTMLElement {
  row.classList.add('is-totp');
  const name = f.label || '2FA code';
  const editing = ui.editing.has(f.id);
  const revealed = ui.revealed.has(f.id);
  const params = parseTotp(f.value);
  const value = el('div', { className: 'fg-value' });
  const tools = el('div', { className: 'fg-tools' });

  if (editing) {
    const input = el('input', {
      className: 'fg-input totp-secret', type: revealed ? 'text' : 'password', value: f.value,
      placeholder: 'Secret key or otpauth:// link from the 2FA setup page',
    });
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', `${name} secret key`);
    input.addEventListener('input', () => { f.value = input.value.trim(); input.classList.remove('invalid'); store.touchNote(note); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finishTotpEdit(f, input); } });
    value.append(input);
    tools.append(
      editOnly(toolButton('📷', 'Scan the QR code', () => void scanTotpInto(note.id, f.id))),
      toolButton(revealed ? '🙈' : '👁', revealed ? 'Hide secret key' : 'Show secret key', () => setRevealed(f.id, !revealed)),
      toolButton('✓', 'Done editing', () => finishTotpEdit(f, input)),
    );
  } else {
    if (!f.value) {
      value.append(el('button', { className: 'secret-mask', type: 'button', text: 'Not set up. Click to add the secret key, or 📷 to scan the QR code.', onclick: () => editTotp(f.id) }));
      tools.append(editOnly(toolButton('📷', 'Scan the QR code', () => void scanTotpInto(note.id, f.id))));
    } else if (!params) {
      value.append(el('button', { className: 'secret-mask invalid', type: 'button', text: 'Not a valid 2FA key. Click to fix it.', onclick: () => editTotp(f.id) }));
    } else {
      // A click on the code copies it, like 📋.
      const display = createTotpDisplay(params, name);
      display.classList.add('copy-on-click');
      display.title = 'Click to copy the current code';
      display.tabIndex = 0;
      display.setAttribute('role', 'button');
      display.addEventListener('click', () => void copyTotpCode(name, params));
      display.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void copyTotpCode(name, params); } });
      value.append(display);
    }
    tools.append(editOnly(toolButton('✎', 'Edit secret key', () => editTotp(f.id))));
    if (params) tools.append(toolButton('📋', 'Copy current code', () => void copyTotpCode(name, params)));
  }
  tools.append(editOnly(toolButton('✕', 'Remove field', () => void confirmRemoveField(note, block, f))));
  row.append(label, value, tools);
  return row;
}

/** Scans a 2FA setup QR code into a field; an unnamed field takes the site's name from the code. */
async function scanTotpInto(noteId: string, fieldId: string): Promise<void> {
  const text = await scanQrCode();
  if (!text) return;
  // The page may have changed while the scanner was open: find the field again.
  const note = store.getNote(noteId);
  const field = note?.blocks.flatMap(b => (b.type === 'fields' ? b.fields : [])).find(x => x.id === fieldId);
  if (!note || note.deleted || !field) { toast('That 2FA field no longer exists.', 'error'); return; }
  const params = parseTotp(text);
  field.value = text.trim();
  const site = params?.issuer || params?.account;
  if (site && (!field.label.trim() || field.label.trim() === '2FA code')) field.label = params?.issuer && params.account ? `${params.issuer} (${params.account})` : site;
  if (params?.issuer && !note.title.trim()) note.title = params.issuer; // an untitled page takes the site's name
  ui.editing.delete(fieldId);
  ui.revealed.delete(fieldId);
  store.touchNote(note);
  if (ui.activeNoteId === noteId) renderEditor();
  toast(`2FA code set up${site ? ` for ${site}` : ''}. The QR code was read on this device only.`);
}

function editTotp(fieldId: string): void {
  ui.editing.add(fieldId);
  renderEditor();
  focusField(fieldId, 'value');
}

function finishTotpEdit(f: Field, input: HTMLInputElement): void {
  if (f.value && !parseTotp(f.value)) {
    input.classList.add('invalid');
    toast('That is not a 2FA secret key. Paste the key (letters A–Z and digits 2–7) or the otpauth:// link from the setup page.', 'error', 7000);
    input.focus();
    return;
  }
  ui.editing.delete(f.id);
  ui.revealed.delete(f.id);
  renderEditor();
}

async function copyTotpCode(name: string, params: TotpParams): Promise<void> {
  const now = Date.now();
  await copyText(await totpCode(params, now), name, true, `${name} copied. It changes in ${secondsRemaining(params, now)} s.`);
}

function setRevealed(fieldId: string, on: boolean): void {
  if (on) ui.revealed.add(fieldId); else ui.revealed.delete(fieldId);
  renderEditor();
  focusField(fieldId, 'value');
}

async function confirmRemoveField(note: Note, block: FieldsBlock, f: Field): Promise<void> {
  const name = f.label || 'Untitled field';
  const ok = await confirmDialog({
    title: 'Remove field?',
    message: isSecretKind(f.kind)
      ? `“${name}” and its hidden value will be removed from this page.`
      : `“${name}”${f.value ? ' and its value' : ''} will be removed from this page.`,
    confirmLabel: 'Remove',
  });
  if (!ok) return;
  block.fields = block.fields.filter(x => x.id !== f.id);
  ui.revealed.delete(f.id);
  if (!block.fields.length) { removeBlock(note, block.id); return; }
  store.touchNote(note);
  renderEditor();
}

/** Asks first, unless the block is empty (an empty paragraph or a divider). */
async function confirmRemoveBlock(note: Note, block: Block): Promise<void> {
  let question: { title: string; message: string; confirmLabel?: string } | null = null;
  if (block.type === 'fields') {
    question = { title: 'Delete field group?', message: `All ${block.fields.length} field(s) in this group and their values will be deleted.` };
  } else if (block.type === 'page') {
    const target = store.getNote(block.pageId);
    question = {
      title: 'Remove page link?',
      message: target && !target.deleted
        ? `The link is removed from this page. “${target.title || 'Untitled'}” itself is kept in the tree.`
        : 'The link to the deleted page is removed.',
      confirmLabel: 'Remove',
    };
  } else if (block.type === 'image') {
    question = { title: 'Delete picture?', message: 'The picture is removed from this page.' };
  } else if (block.type === 'file') {
    question = { title: 'Delete file?', message: `“${block.name}” is removed from this page and deleted (unless another page shows it too).`, confirmLabel: 'Delete file' };
  } else if (block.type === 'table') {
    if (block.rows.some(r => r.some(c => c.trim()))) {
      question = { title: 'Delete table?', message: `The table (${block.rows.length} × ${block.rows[0]?.length ?? 0}) and its text will be deleted.` };
    }
  } else if (block.type !== 'divider' && block.content.trim()) {
    question = { title: 'Delete block?', message: 'This block and its text will be deleted.' };
  }
  if (question && !(await confirmDialog(question))) return;
  removeBlock(note, block.id);
  if (block.type === 'file' && !store.fileInUse(block.fileId)) void releaseFile(block.fileId);
}

let clipboardTimer: ReturnType<typeof setTimeout> | null = null;

async function copyText(text: string, name: string, secret: boolean, message?: string): Promise<void> {
  if (!text) { toast('There is nothing to copy yet.'); return; }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast('Copy failed: the browser blocked clipboard access.', 'error');
    return;
  }
  if (!secret) { toast(message ?? `${name} copied.`); return; }
  if (clipboardTimer) clearTimeout(clipboardTimer);
  clipboardTimer = setTimeout(clearClipboardNow, CLIPBOARD_CLEAR_MS);
  toast(message ?? `${name} copied. The clipboard clears in 30 seconds.`);
}

/** Clears a secret we put on the clipboard, if the timer for it is still pending. */
export function clearClipboardNow(): void {
  if (!clipboardTimer) return;
  clearTimeout(clipboardTimer);
  clipboardTimer = null;
  navigator.clipboard.writeText('').catch(() => { /* page not focused; nothing more we can do */ });
}

// ---- Structural edits ----

const indexOf = (note: Note, blockId: string) => note.blocks.findIndex(b => b.id === blockId);

function replaceBlock(note: Note, blockId: string, ...replacement: Block[]): void {
  const i = indexOf(note, blockId);
  if (i >= 0) note.blocks.splice(i, 1, ...replacement);
}

function setTextType(block: TextBlock, type: TextBlockType): void {
  block.type = type;
  if (type === 'todo') block.checked ??= false;
  else delete block.checked;
}

export function addBlockAtEnd(note: Note): void {
  const b = textBlock();
  note.blocks.push(b);
  store.touchNote(note);
  renderEditor();
  focusBlock(b.id);
}

function moveBlock(note: Note, blockId: string, dir: -1 | 1): void {
  const idx = indexOf(note, blockId);
  const target = idx + dir;
  if (idx < 0 || target < 0 || target >= note.blocks.length) return;
  const [b] = note.blocks.splice(idx, 1);
  note.blocks.splice(target, 0, b!);
  store.touchNote(note);
  renderEditor();
}

function removeBlock(note: Note, blockId: string): void {
  if (note.blocks.length <= 1) note.blocks = [textBlock()];
  else note.blocks.splice(indexOf(note, blockId), 1);
  store.touchNote(note);
  renderEditor();
}

function checkMarkdownShortcuts(note: Note, block: TextBlock, v: string): boolean {
  if (block.type !== 'p') return false;
  for (const m of MARKDOWN_SHORTCUTS) {
    if (v.startsWith(m.prefix)) {
      setTextType(block, m.type);
      block.content = v.slice(m.prefix.length);
      store.touchNote(note);
      renderEditor();
      focusBlock(block.id);
      return true;
    }
  }
  if (v === '---') {
    const next = textBlock();
    replaceBlock(note, block.id, { id: block.id, type: 'divider' }, next);
    store.touchNote(note);
    renderEditor();
    focusBlock(next.id);
    return true;
  }
  return false;
}

function handleBlockKeydown(e: KeyboardEvent, note: Note, block: TextBlock, ta: HTMLTextAreaElement): void {
  if (slash.open && slash.blockId === block.id) {
    const items = filteredSlashItems();
    if (e.key === 'ArrowDown') { e.preventDefault(); slash.selectedIdx = (slash.selectedIdx + 1) % Math.max(items.length, 1); renderSlashMenu(note, ta); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); slash.selectedIdx = (slash.selectedIdx - 1 + items.length) % Math.max(items.length, 1); renderSlashMenu(note, ta); return; }
    if (e.key === 'Enter') {
      const item = items[slash.selectedIdx] ?? items[0];
      if (item) { e.preventDefault(); applySlashCommand(note, block, item.type); return; }
    }
    if (e.key === 'Escape') { closeSlashMenu(); return; }
  }

  const idx = indexOf(note, block.id);
  if (e.key === 'Enter' && !e.shiftKey && (block.type !== 'code' || e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    const next = textBlock(block.type === 'todo' && block.content.trim() !== '' ? 'todo' : 'p');
    note.blocks.splice(idx + 1, 0, next);
    store.touchNote(note);
    renderEditor();
    focusBlock(next.id);
    return;
  }
  if (e.key === 'Backspace' && ta.value === '' && note.blocks.length > 1) {
    e.preventDefault();
    if (block.type !== 'p') {
      setTextType(block, 'p');
      store.touchNote(note);
      renderEditor();
      focusBlock(block.id);
    } else {
      const prev = note.blocks[idx - 1];
      note.blocks.splice(idx, 1);
      store.touchNote(note);
      renderEditor();
      if (prev) focusBlock(prev.id, true);
    }
    return;
  }
  if (e.key === 'ArrowUp' && ta.selectionStart === 0 && idx > 0) {
    e.preventDefault();
    focusBlock(note.blocks[idx - 1]!.id, true);
  } else if (e.key === 'ArrowDown' && ta.selectionEnd === ta.value.length && idx < note.blocks.length - 1) {
    e.preventDefault();
    focusBlock(note.blocks[idx + 1]!.id);
  }
}

const SELECTABLE = new Set(['text', 'password', 'url', 'tel', 'search']);

export function focusBlock(blockId: string, atEnd = false): void {
  requestAnimationFrame(() => {
    const row = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
    const targets = row?.querySelectorAll<HTMLElement>('.block-input, .fg-input, .secret-mask, .page-link, .table-cell, .image-caption, .file-note');
    const target = targets && (atEnd ? targets[targets.length - 1] : targets[0]);
    if (!target) return;
    target.focus();
    if (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && SELECTABLE.has(target.type))) {
      const pos = atEnd ? target.value.length : 0;
      target.setSelectionRange(pos, pos);
    }
  });
}

function focusField(fieldId: string, part: 'label' | 'value'): void {
  requestAnimationFrame(() => {
    const row = document.querySelector(`[data-field-id="${CSS.escape(fieldId)}"]`);
    row?.querySelector<HTMLElement>(part === 'label' ? '.fg-label' : '.fg-input, .secret-mask')?.focus();
  });
}

// ---- Slash menu ----

function checkSlashMenu(note: Note, block: TextBlock, ta: HTMLTextAreaElement): void {
  if (ta.value.startsWith('/')) {
    Object.assign(slash, { open: true, blockId: block.id, filter: ta.value.slice(1).toLowerCase(), selectedIdx: 0 });
    renderSlashMenu(note, ta);
  } else if (slash.open && slash.blockId === block.id) {
    closeSlashMenu();
  }
}

function filteredSlashItems(): SlashCommand[] {
  return SLASH_COMMANDS.filter(c => c.label.toLowerCase().includes(slash.filter) || c.type.includes(slash.filter));
}

function renderSlashMenu(note: Note, ta: HTMLTextAreaElement): void {
  const menu = $('slash-menu');
  const items = filteredSlashItems();
  if (!items.length) { closeSlashMenu(); return; }
  const rect = ta.getBoundingClientRect();
  // Keep the 240 px menu inside the viewport on narrow screens.
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 248))}px`;
  menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 340))}px`;
  const block = note.blocks.find(b => b.id === slash.blockId);
  menu.replaceChildren(...items.map((item, i) => {
    const row = el('div', { className: `slash-item${i === slash.selectedIdx ? ' selected' : ''}` },
      el('span', { className: 'slash-icon', text: item.icon }),
      el('div', {}, el('strong', { text: item.label }), el('div', { className: 'slash-hint', text: item.hint })),
    );
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === slash.selectedIdx));
    row.onmousedown = ev => {
      ev.preventDefault();
      if (block && isTextBlock(block)) applySlashCommand(note, block, item.type);
    };
    return row;
  }));
  menu.classList.remove('hidden');
  menu.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
}

function applySlashCommand(note: Note, block: TextBlock, type: SlashType): void {
  closeSlashMenu();
  if (type === 'divider') {
    const next = textBlock();
    replaceBlock(note, block.id, { id: block.id, type: 'divider' }, next);
    store.touchNote(note);
    renderEditor();
    focusBlock(next.id);
    return;
  }
  if (type === 'page') {
    // Pick a template for the new sub-page; once it exists, this block becomes a link to it.
    block.content = '';
    store.touchNote(note);
    renderEditor();
    const parentId = note.id;
    const blockId = block.id;
    openTemplatePicker(parentId, {
      onCreate: child => {
        const parent = store.getNote(parentId);
        if (!parent || parent.deleted) return;
        const link: PageBlock = { id: uid(), type: 'page', pageId: child.id };
        if (parent.blocks.some(b => b.id === blockId)) replaceBlock(parent, blockId, link);
        else parent.blocks.push(link);
        store.touchNote(parent);
      },
    });
    return;
  }
  if (type === 'image') {
    // Pick files; the pictures replace the empty paragraph the command was typed in.
    block.content = '';
    store.touchNote(note);
    renderEditor();
    const noteId = note.id;
    const blockId = block.id;
    void choosePictureFiles().then(async files => {
      if (!files.length) { focusBlock(blockId); return; }
      const added = await insertPictures(noteId, files, blockId);
      const current = store.getNote(noteId);
      const placeholder = current?.blocks.find(b => b.id === blockId);
      if (current && added.length && placeholder?.type === 'p' && !placeholder.content) {
        current.blocks.splice(indexOf(current, blockId), 1);
        store.touchNote(current);
        if (ui.activeNoteId === noteId) { renderEditor(); focusBlock(added[added.length - 1]!.id); }
      }
    });
    return;
  }
  if (type === 'file') {
    // Pick files; they replace the empty paragraph the command was typed in.
    block.content = '';
    store.touchNote(note);
    renderEditor();
    const noteId = note.id;
    const blockId = block.id;
    void chooseFiles().then(async files => {
      if (!files.length) { focusBlock(blockId); return; }
      const added = await insertFiles(noteId, files, blockId);
      const current = store.getNote(noteId);
      const placeholder = current?.blocks.find(b => b.id === blockId);
      if (current && added.length && placeholder?.type === 'p' && !placeholder.content) {
        current.blocks.splice(indexOf(current, blockId), 1);
        store.touchNote(current);
        if (ui.activeNoteId === noteId) { renderEditor(); focusBlock(added[added.length - 1]!.id); }
      }
    });
    return;
  }
  if (type === 'table') {
    const table = tableBlock();
    replaceBlock(note, block.id, table);
    // Keep somewhere to type after the table.
    if (note.blocks[note.blocks.length - 1]?.id === table.id) note.blocks.push(textBlock());
    store.touchNote(note);
    renderEditor();
    focusCell(table.id, { r: 0, c: 0 });
    return;
  }
  if (type === 'fields' || type === 'secret' || type === 'totp') {
    const f = type === 'secret' ? field('Secret', 'password') : type === 'totp' ? field('2FA code', 'totp') : field('', 'text');
    if (type === 'totp') ui.editing.add(f.id);
    replaceBlock(note, block.id, fieldsBlock([f]));
    store.touchNote(note);
    renderEditor();
    focusField(f.id, type === 'fields' ? 'label' : 'value');
    return;
  }
  setTextType(block, type);
  block.content = '';
  store.touchNote(note);
  renderEditor();
  focusBlock(block.id);
}

// ---- Right-click menu on blocks (desktop) ----

export function wireEditorContextMenu(): void {
  addContextMenu($('blocks-container'), blockContextMenu);
}

const TURN_INTO: { type: TextBlockType; label: string; icon: string }[] = [
  { type: 'p', label: 'Text', icon: '¶' }, { type: 'h1', label: 'Heading 1', icon: 'H1' }, { type: 'h2', label: 'Heading 2', icon: 'H2' },
  { type: 'todo', label: 'To-do', icon: '☑' }, { type: 'callout', label: 'Callout', icon: '💡' }, { type: 'quote', label: 'Quote', icon: '❝' },
  { type: 'code', label: 'Code', icon: '<>' },
];

/** A copy of a block with fresh ids (fields too), so the two can be edited separately. */
function cloneBlock(block: Block): Block {
  const copy = structuredClone(block);
  copy.id = uid();
  if (copy.type === 'fields') copy.fields = copy.fields.map(f => ({ ...f, id: uid() }));
  return copy;
}

function blockContextMenu(e: MouseEvent): ContextMenu | null {
  const note = currentNote();
  const row = (e.target as Element).closest<HTMLElement>('.block-row');
  const block = note && row ? note.blocks.find(b => b.id === row.dataset.blockId) : undefined;
  if (!note || !block) return null;
  const idx = indexOf(note, block.id);
  const { clientX: x, clientY: y } = e;
  const items: DropdownOption[] = [
    ...(isTextBlock(block) ? [{ value: 'turn', label: 'Turn into…', svg: 'turnInto' as const }] : []),
    { value: 'insert', label: 'Insert below…', svg: 'plus' },
    { value: 'duplicate', label: 'Duplicate', svg: 'copy' },
    SEPARATOR,
    { value: 'up', label: 'Move up', svg: 'arrowUp', disabled: idx <= 0 },
    { value: 'down', label: 'Move down', svg: 'arrowDown', disabled: idx >= note.blocks.length - 1 },
    SEPARATOR,
    { value: 'delete', label: 'Delete block', svg: 'trash', danger: true },
  ];
  return {
    label: 'Block',
    items,
    onSelect: action => {
      if (action === 'up' || action === 'down') moveBlock(note, block.id, action === 'up' ? -1 : 1);
      else if (action === 'delete') void confirmRemoveBlock(note, block);
      else if (action === 'duplicate') {
        const copy = cloneBlock(block);
        note.blocks.splice(indexOf(note, block.id) + 1, 0, copy);
        store.touchNote(note);
        renderEditor();
        focusBlock(copy.id);
      } else if (action === 'turn' && isTextBlock(block)) {
        openContextMenu(x, y, 'Turn into', TURN_INTO.map(t => ({ value: t.type, label: t.label, icon: t.icon, hint: t.type === block.type ? '✓' : '' })), type => {
          setTextType(block, type as TextBlockType);
          store.touchNote(note);
          renderEditor();
          focusBlock(block.id, true);
        });
      } else if (action === 'insert') {
        openContextMenu(x, y, 'Insert below', SLASH_COMMANDS.map(c => ({ value: c.type, label: c.label, icon: c.icon })), type => {
          // An empty paragraph below, then the same conversion the "/" menu does.
          const fresh = textBlock();
          note.blocks.splice(indexOf(note, block.id) + 1, 0, fresh);
          applySlashCommand(note, fresh, type as SlashType);
        });
      }
    },
  };
}

export function closeSlashMenu(): void {
  slash.open = false;
  $('slash-menu').classList.add('hidden');
}
