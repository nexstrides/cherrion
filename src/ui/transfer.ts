// "Export page…" and "Import page…": one modal with two forms (see src/transfer.ts for the formats).
import * as store from '../store';
import {
  collectPages, exportPageFile, markdownToPages, pagesFromFile, pagesToMarkdown, PAGE_FILE_EXT, prepareImport,
  readPageFile, type PageFile,
} from '../transfer';
import { passwordProblem } from '../vault';
import { $, $input, download, nextPaint, setWorking, toast } from './dom';
import { render, selectNote, ui } from './state';

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

let exportRoot: string | null = null;
let importParent: string | null = null;
/** The chosen import file: a page file (maybe locked), or Markdown/plain text. */
let chosen: { name: string; page: PageFile | null; text: string } | null = null;

const titleOf = (id: string) => store.getNote(id)?.title || 'Untitled';
const fileName = (title: string) => (title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'page');
const checkedValue = (name: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value;

function showForm(which: 'export' | 'import', title: string): void {
  $('transfer-title').textContent = title;
  $('form-export').classList.toggle('hidden', which !== 'export');
  $('form-import').classList.toggle('hidden', which !== 'import');
  for (const e of $('transfer-modal').querySelectorAll('.form-error')) e.classList.add('hidden');
  $('transfer-modal').classList.remove('hidden');
}

function setError(form: HTMLElement, message: string): void {
  const e = form.querySelector('.form-error');
  if (!e) return;
  e.textContent = message;
  e.classList.remove('hidden');
}

/** Disables the form and shows "Working…" while Argon2id runs, then shows any error. */
async function busy(form: HTMLFormElement, work: () => Promise<void>): Promise<void> {
  const buttons = [...form.querySelectorAll('button')];
  const submit = form.querySelector<HTMLButtonElement>('button[type=submit]');
  buttons.forEach(b => (b.disabled = true));
  const restore = submit ? setWorking(submit) : () => {};
  form.querySelector('.form-error')?.classList.add('hidden');
  try {
    await nextPaint();
    await work();
  } catch (err) {
    setError(form, err instanceof Error ? err.message : String(err));
  } finally {
    buttons.forEach(b => (b.disabled = false));
    restore();
  }
}

// ---- Export ----

function updateExportForm(): void {
  const page = checkedValue('export-format') !== 'md';
  const encrypt = $input('export-encrypt').checked;
  $('export-page-options').classList.toggle('hidden', !page);
  $('export-md-options').classList.toggle('hidden', page);
  $('export-password-wrap').classList.toggle('hidden', !page || !encrypt);
  $('export-plain-warning').classList.toggle('hidden', !page || encrypt);
}

export function openExport(noteId: string): void {
  const note = store.getNote(noteId);
  if (!note || note.deleted) return;
  exportRoot = noteId;
  const subs = collectPages(store.allNotes(), noteId).length - 1;
  $('export-what').textContent = `Page: “${note.title || 'Untitled'}”`;
  $('export-subpages-wrap').classList.toggle('hidden', subs === 0);
  $('export-subpages-text').textContent = `Include its ${subs} sub-page${subs === 1 ? '' : 's'}`;
  $input('export-subpages').checked = true;
  $input('export-password').value = '';
  $input('export-confirm').value = '';
  updateExportForm();
  showForm('export', 'Export page');
  requestAnimationFrame(() => (checkedValue('export-format') === 'page' && $input('export-encrypt').checked
    ? $input('export-password') : $('form-export').querySelector<HTMLButtonElement>('button[type=submit]'))?.focus());
}

function submitExport(form: HTMLFormElement): void {
  const root = exportRoot && store.getNote(exportRoot);
  if (!root || root.deleted) { setError(form, 'That page no longer exists.'); return; }
  const pages = collectPages(store.allNotes(), root.id, $input('export-subpages').checked);
  const base = fileName(root.title || 'Untitled');
  const count = `${pages.length} page${pages.length === 1 ? '' : 's'}`;
  /** Closes the dialog once the file is saved; a cancelled save dialog leaves it open. */
  const save = async (name: string, text: string, type: string, kind: string) => {
    const saved = await download(name, text, type, { quiet: true });
    if (!saved) return;
    closeTransfer();
    toast(`Exported ${count} (${kind})${typeof saved === 'string' ? ` to ${saved}` : ''}.`, 'info', 6000);
  };
  if (checkedValue('export-format') === 'md') {
    void busy(form, () => save(`${base}.md`, pagesToMarkdown(pages, { includeSecrets: $input('export-secrets').checked, titleOf }), 'text/markdown', 'Markdown'));
    return;
  }
  const encrypt = $input('export-encrypt').checked;
  const password = $input('export-password').value;
  if (encrypt) {
    const problem = passwordProblem(password);
    if (problem) { setError(form, problem); return; }
    if (password !== $input('export-confirm').value) { setError(form, 'The passwords do not match.'); return; }
  }
  void busy(form, () => save(`${base}${PAGE_FILE_EXT}`, exportPageFile(pages, root.id, encrypt ? password : undefined), 'application/json',
    encrypt ? 'password-protected' : 'no password'));
}

// ---- Import ----

export function openImport(parentId: string | null): void {
  const parent = parentId ? store.getNote(parentId) : undefined;
  importParent = parent && !parent.deleted ? parent.id : null;
  chosen = null;
  $input('import-file').value = '';
  $input('import-password').value = '';
  $('import-password-wrap').classList.add('hidden');
  $('import-file-info').classList.add('hidden');
  $('import-under-wrap').classList.toggle('hidden', !importParent);
  $('import-under-text').textContent = parent ? `Under “${parent.title || 'Untitled'}”` : '';
  const where = document.querySelector<HTMLInputElement>(`input[name="import-where"][value="${importParent ? 'under' : 'top'}"]`);
  if (where) where.checked = true;
  showForm('import', 'Import page');
  requestAnimationFrame(() => $input('import-file').focus());
}

async function chooseImportFile(): Promise<void> {
  const form = $('form-import') as HTMLFormElement;
  const file = $input('import-file').files?.[0];
  chosen = null;
  $('import-password-wrap').classList.add('hidden');
  $('import-file-info').classList.add('hidden');
  form.querySelector('.form-error')?.classList.add('hidden');
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) { setError(form, 'That file is too large to import (over 20 MB).'); return; }
  const text = await file.text();
  const name = file.name.replace(/\.(cherrion-page|json|md|markdown|txt)$/i, '');
  let page: PageFile | null = null;
  if (/\.(cherrion-page|json)$/i.test(file.name) || text.trimStart().startsWith('{')) {
    try { page = readPageFile(text); } catch (err) { setError(form, (err as Error).message); return; }
  }
  chosen = { name, page, text };
  const info = $('import-file-info');
  info.textContent = page
    ? (page.encrypted ? 'Cherrion page file, protected with a password.' : 'Cherrion page file, not password-protected.')
    : 'Markdown / text: headings, lists, to-dos, quotes, code, tables and “**Label:** value” fields become blocks.';
  info.classList.remove('hidden');
  if (page?.encrypted) {
    $('import-password-wrap').classList.remove('hidden');
    $input('import-password').focus();
  }
}

function submitImport(form: HTMLFormElement): void {
  const picked = chosen;
  if (!picked) { setError(form, 'Choose a file to import.'); return; }
  if (picked.page?.encrypted && !$input('import-password').value) { setError(form, 'Enter the file’s password.'); return; }
  const parentId = checkedValue('import-where') === 'under' ? importParent : null;
  void busy(form, async () => {
    const payload = picked.page ? pagesFromFile(picked.page, $input('import-password').value) : markdownToPages(picked.text, picked.name);
    const notes = prepareImport(payload, parentId);
    for (const n of notes) store.addNote(n);
    if (parentId) {
      const parent = store.getNote(parentId);
      if (parent?.collapsed) { parent.collapsed = false; store.touchNote(parent); }
    }
    await store.flush();
    closeTransfer();
    selectNote(notes[0]!.id);
    ui.activeTab = 'tree';
    render.all();
    toast(`Imported ${notes.length} page${notes.length === 1 ? '' : 's'}.`);
  });
}

// ---- Wiring ----

/** Closes the dialog and clears passwords and file contents (also used when locking). */
export function closeTransfer(): void {
  $('transfer-modal').classList.add('hidden');
  for (const id of ['export-password', 'export-confirm', 'import-password', 'import-file']) $input(id).value = '';
  $('export-what').textContent = '';
  $('import-under-text').textContent = '';
  chosen = null;
  exportRoot = null;
}

export function wireTransfer(): void {
  const modal = $('transfer-modal');
  $('btn-close-transfer').onclick = closeTransfer;
  for (const b of modal.querySelectorAll<HTMLButtonElement>('[data-close-transfer]')) b.onclick = closeTransfer;
  modal.addEventListener('mousedown', e => { if (e.target === modal) closeTransfer(); });
  modal.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); closeTransfer(); } });
  $('export-format').addEventListener('change', updateExportForm);
  $input('export-encrypt').addEventListener('change', updateExportForm);
  $input('import-file').addEventListener('change', () => void chooseImportFile());
  const exportForm = $('form-export') as HTMLFormElement;
  const importForm = $('form-import') as HTMLFormElement;
  exportForm.addEventListener('submit', e => { e.preventDefault(); submitExport(exportForm); });
  importForm.addEventListener('submit', e => { e.preventDefault(); submitImport(importForm); });
}
