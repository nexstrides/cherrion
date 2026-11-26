// Main workspace: sidebar tree (with drag and drop), tabs, top bar actions, the slide-in sidebar on
// narrow screens, and the settings modal.
import * as session from '../desktop/session';
import { parseLegacyNotes } from '../legacy';
import { DESKTOP } from '../platform';
import { CATEGORY_IDS, now, searchableText, uid, type CategoryId, type Note } from '../model';
import { AUTO_LOCK_CHOICES, saveSettings, settings } from '../settings';
import * as store from '../store';
import * as sync from '../sync';
import { CATEGORIES } from '../templates';
import { buildTree, compareSiblings, countDescendants, keyboardMove, planMove, type MoveChange } from '../tree';
import { normalizeUserName, passwordProblem, WrongSecretError } from '../vault';
import { closeDialog, confirmDialog, wireDialog } from './dialog';
import { $, $input, autoResize, download, el, nextPaint, setWorking, toast } from './dom';
import { addContextMenu, type ContextMenu } from './contextMenu';
import { attachMenu, closeDropdowns, mountDropdown, SEPARATOR, type Dropdown, type DropdownOption } from './dropdown';
import { addBlockAtEnd, closeSlashMenu, currentNote, focusBlock, renderBreadcrumbs, renderEditor, wireEditorContextMenu, wireEditorPictures } from './editor';
import { closeLightbox } from './images';
import { openDocs, wireDocs } from './docs';
import { closeTemplatePicker, openTemplatePicker, wireTemplatePicker } from './picker';
import { render, selectNote, shell, ui } from './state';
import { openFloatingSticky, renderStickyBoard } from './stickies';
import { closeTransfer, openExport, openImport, wireTransfer } from './transfer';
import { stopTotpDisplays } from './totpWidget';
import { wireTreeDrag } from './treedrag';

const narrow = window.matchMedia('(max-width: 860px)');

// ---- Slide-in sidebar (narrow screens) ----

function setNav(open: boolean): void {
  $('app').classList.toggle('nav-open', open);
  $('btn-menu').setAttribute('aria-expanded', String(open));
  if (open) requestAnimationFrame(() => $('tree-container').querySelector<HTMLElement>('.tree-row.active, .tree-row')?.focus());
}
const closeNavIfNarrow = () => { if (narrow.matches) setNav(false); };

// ---- Tree ----

function renderTree(): void {
  const container = $('tree-container');
  const active = store.activeNotes();
  const q = ui.search.trim().toLowerCase();

  if (q || ui.category !== 'all') {
    const matches = active
      .filter(n => (ui.category === 'all' || n.category === ui.category) && (!q || searchableText(n).includes(q)))
      .sort(compareSiblings);
    container.replaceChildren(...(matches.length
      ? matches.map(n => treeRow(n, 0, false))
      : [el('div', { className: 'tree-empty', text: 'No matches found.' })]));
    return;
  }

  const { children } = buildTree(active);
  const rows: HTMLElement[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const n of children.get(parentId) ?? []) {
      const kids = children.get(n.id) ?? [];
      rows.push(treeRow(n, depth, kids.length > 0));
      if (kids.length && !n.collapsed) walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  container.replaceChildren(...(rows.length ? rows : [el('div', { className: 'tree-empty', text: 'No notes yet. Press ＋ to create one.' })]));
}

function treeRow(note: Note, depth: number, hasChildren: boolean): HTMLElement {
  const category = CATEGORIES[note.category];
  const row = el('div', { className: `tree-row${note.id === ui.activeNoteId ? ' active' : ''}`, tabIndex: 0 });
  row.dataset.noteId = note.id;
  row.style.paddingLeft = `${8 + depth * 14}px`;
  row.setAttribute('role', 'treeitem');
  row.title = 'Drag to move. Alt+arrow keys also move it.';
  if (hasChildren) row.setAttribute('aria-expanded', String(!note.collapsed));

  const toggle = el('span', { className: 'tree-toggle', text: hasChildren ? (note.collapsed ? '▶' : '▼') : '' });
  toggle.onclick = e => {
    e.stopPropagation();
    if (!hasChildren) return;
    note.collapsed = !note.collapsed;
    store.touchNote(note);
    renderTree();
  };
  row.append(
    toggle,
    el('span', { className: 'tree-icon', text: category.icon, title: category.label }),
    el('span', { className: 'tree-label', text: note.title || 'Untitled' }),
  );
  if (note.isSticky) row.append(el('span', { className: 'tree-badge', text: '📌', title: 'Pinned sticky' }));

  const addLabel = `Add sub-note to “${note.title || 'Untitled'}”`;
  const add = el('button', {
    className: 'tree-add', type: 'button', text: '+', title: addLabel,
    onclick: e => { e.stopPropagation(); openTemplatePicker(note.id); },
  });
  add.setAttribute('aria-label', addLabel);
  row.append(add);

  /** Shows or hides the sub-pages (kept on the note, so it syncs), keeping focus on this row. */
  const setExpanded = (expanded: boolean) => {
    if (!hasChildren || note.collapsed === !expanded) return;
    note.collapsed = !expanded;
    store.touchNote(note);
    renderTree();
    focusTreeRow(note.id);
  };
  // A click (or Enter / Space) opens the page and shows or hides its sub-pages. Keyboard focus stays
  // on the row (it is rebuilt by renderAll), so Delete, F2 and the arrow keys act on this page.
  const open = () => {
    if (hasChildren) { note.collapsed = !note.collapsed; store.touchNote(note); }
    treeAction(note.id, 'open');
  };
  row.onclick = open;
  row.onkeydown = e => {
    if (e.target !== row) return; // keys on the + button belong to the button
    if (e.altKey && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const changes = keyboardMove(store.activeNotes(), note.id, e.key);
      if (changes?.length) applyMove(note.id, changes, true);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    else if (e.key === 'Delete') { e.preventDefault(); void deleteNote(note.id); }
    else if (e.key === 'F2') { e.preventDefault(); treeAction(note.id, 'rename'); }
    else if (e.key === 'ArrowRight') {
      // Expand; if already open, go to the first sub-page (the row right below).
      e.preventDefault();
      if (hasChildren && note.collapsed) setExpanded(true);
      else if (hasChildren) focusSiblingRow(row, 1);
    } else if (e.key === 'ArrowLeft') {
      // Collapse; if already closed (or no sub-pages), go to the parent page.
      e.preventDefault();
      if (hasChildren && !note.collapsed) setExpanded(false);
      else if (note.parentId) focusTreeRow(note.parentId);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusSiblingRow(row, e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const rows = [...$('tree-container').querySelectorAll<HTMLElement>('.tree-row')];
      (e.key === 'Home' ? rows[0] : rows[rows.length - 1])?.focus();
    }
  };
  return row;
}

const focusTreeRow = (id: string) =>
  $('tree-container').querySelector<HTMLElement>(`[data-note-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: false });

/** Moves keyboard focus to the visible row above (-1) or below (1). */
function focusSiblingRow(row: HTMLElement, dir: -1 | 1): void {
  const rows = [...$('tree-container').querySelectorAll<HTMLElement>('.tree-row')];
  rows[rows.indexOf(row) + dir]?.focus();
}

/** A copy of one page (not its sub-pages) next to it, with fresh ids so both can be edited separately. */
function duplicateNote(id: string): void {
  const source = store.getNote(id);
  if (!source || source.deleted) return;
  const copy = structuredClone(source);
  copy.id = uid();
  copy.title = `${source.title || 'Untitled'} (copy)`;
  copy.updatedAt = now();
  copy.blocks = copy.blocks.map(b => (b.type === 'fields'
    ? { ...b, id: uid(), fields: b.fields.map(f => ({ ...f, id: uid() })) }
    : { ...b, id: uid() }));
  store.addNote(copy);
  selectNote(copy.id);
  ui.activeTab = 'tree';
  renderAll();
  focusTreeRow(copy.id);
}

/** Sidebar actions, shared by clicks, keys and the right-click menu. */
function treeAction(id: string, action: string): void {
  const note = store.getNote(id);
  if (!note || note.deleted) return;
  if (action === 'open') {
    selectNote(id); ui.activeTab = 'tree'; closeNavIfNarrow(); renderAll();
    if (!narrow.matches) focusTreeRow(id);
  } else if (action === 'sub') openTemplatePicker(id);
  else if (action === 'sibling') openTemplatePicker(note.parentId);
  else if (action === 'rename') {
    selectNote(id); ui.activeTab = 'tree'; closeNavIfNarrow(); renderAll();
    const title = $input('note-title');
    title.focus();
    title.select();
  } else if (action === 'duplicate') duplicateNote(id);
  else if (action === 'pin') { note.isSticky = !note.isSticky; store.touchNote(note); renderAll(); focusTreeRow(id); }
  else if (action === 'toggle') { note.collapsed = !note.collapsed; store.touchNote(note); renderTree(); focusTreeRow(id); }
  else if (action === 'up' || action === 'down') {
    const changes = keyboardMove(store.activeNotes(), id, action === 'up' ? 'ArrowUp' : 'ArrowDown');
    if (changes?.length) applyMove(id, changes, true);
  } else if (action === 'delete') void deleteNote(id);
  else if (action === 'export') openExport(id);
  else if (action === 'import') openImport(id);
}

function treeContextMenu(e: MouseEvent): ContextMenu {
  const row = (e.target as Element).closest<HTMLElement>('.tree-row');
  const note = store.getNote(row?.dataset.noteId ?? null);
  if (!row || !note || note.deleted) {
    return {
      label: 'Notes',
      items: [{ value: 'new', label: 'New page…', svg: 'plus' }, { value: 'import', label: 'Import page…', svg: 'upload' }],
      onSelect: v => (v === 'import' ? openImport(null) : openTemplatePicker(null)),
    };
  }
  row.focus({ preventScroll: true });
  const siblings = store.activeNotes().filter(n => n.parentId === note.parentId);
  const hasChildren = store.activeNotes().some(n => n.parentId === note.id);
  const items: DropdownOption[] = [
    { value: 'open', label: 'Open', svg: 'file', hint: 'Enter' },
    SEPARATOR,
    { value: 'sub', label: 'New sub-page…', svg: 'subPage' },
    { value: 'sibling', label: 'New page here…', svg: 'plus' },
    { value: 'rename', label: 'Rename', svg: 'edit', hint: 'F2' },
    { value: 'duplicate', label: 'Duplicate', svg: 'copy' },
    { value: 'pin', label: note.isSticky ? 'Unpin from stickies' : 'Pin to stickies', svg: note.isSticky ? 'unpin' : 'pin' },
    ...(hasChildren ? [{ value: 'toggle', label: note.collapsed ? 'Expand' : 'Collapse', svg: 'folder' as const }] : []),
    SEPARATOR,
    { value: 'up', label: 'Move up', svg: 'arrowUp', hint: 'Alt+↑', disabled: siblings.length < 2 },
    { value: 'down', label: 'Move down', svg: 'arrowDown', hint: 'Alt+↓', disabled: siblings.length < 2 },
    SEPARATOR,
    { value: 'export', label: 'Export…', svg: 'download' },
    { value: 'import', label: 'Import here…', svg: 'upload' },
    SEPARATOR,
    { value: 'delete', label: 'Delete…', svg: 'trash', hint: 'Del', danger: true },
  ];
  return { label: `Page “${note.title || 'Untitled'}”`, items, onSelect: action => treeAction(note.id, action) };
}

/** Applies a planned move, expands the new parent so the note stays visible, and re-renders. */
function applyMove(noteId: string, changes: MoveChange[], refocus: boolean): void {
  for (const c of changes) {
    const n = store.getNote(c.id);
    if (!n) continue;
    n.parentId = c.parentId;
    n.order = c.order;
    store.touchNote(n);
  }
  const parentId = changes.find(c => c.id === noteId)?.parentId;
  const parent = store.getNote(parentId ?? null);
  if (parent?.collapsed) { parent.collapsed = false; store.touchNote(parent); }
  renderTree();
  renderBreadcrumbs(currentNote());
  if (refocus) $('tree-container').querySelector<HTMLElement>(`[data-note-id="${CSS.escape(noteId)}"]`)?.focus();
}

function renderTabs(): void {
  const isTree = ui.activeTab === 'tree';
  $('tab-tree').classList.toggle('active', isTree);
  $('tab-stickies').classList.toggle('active', !isTree);
  $('editor-view').classList.toggle('hidden', !isTree);
  $('sticky-board-view').classList.toggle('hidden', isTree);
}

export function renderAll(): void {
  document.body.classList.toggle('dark', settings.dark);
  renderUserChip();
  renderTabs();
  renderTree();
  renderEditor();
  renderStickyBoard();
}

function renderUserChip(): void {
  const name = store.getProfile()?.userName ?? '';
  const chip = $('btn-user');
  chip.classList.toggle('empty', !name);
  $('user-avatar').textContent = name ? ([...name][0] ?? '?').toUpperCase() : '?';
  $('user-name').textContent = name || 'Add your name';
  chip.setAttribute('aria-label', `${name || 'No name set'}, ${$('sync-status').textContent}. Open account menu`);
}

/** Keeps the device-local copy of the user name (lock-screen greeting) in step with the vault. */
export function rememberUserName(): void {
  const name = store.getProfile()?.userName;
  if (name && name !== settings.userName) { settings.userName = name; saveSettings(); }
}

/** Removes every piece of decrypted content from the page (used when locking). */
export function clearAppDom(): void {
  closeSlashMenu();
  closeTemplatePicker();
  closeDropdowns();
  closeDialog();
  closeTransfer();
  closeLightbox();
  setNav(false);
  $('settings-modal').classList.add('hidden');
  for (const id of ['tree-container', 'blocks-container', 'sticky-grid', 'note-meta', 'breadcrumbs']) $(id).replaceChildren();
  $('user-name').textContent = '';
  $('user-avatar').textContent = '';
  $input('input-user-name').value = '';
  $input('note-title').value = '';
  $input('note-title').placeholder = 'Untitled note'; // the category placeholder would hint at the last note
  $input('search-input').value = '';
  $('new-recovery-output').classList.add('hidden');
  $('new-recovery-key').textContent = '';
  $('sync-recovery-output').classList.add('hidden');
  $('sync-recovery-key').textContent = '';
  for (const id of ['sync-password', 'input-current-password', 'input-new-password', 'input-confirm-password']) $input(id).value = '';
  ui.search = '';
  ui.revealed.clear();
  ui.editing.clear();
  stopTotpDisplays();
}

// ---- Sync status ----

/** Desktop: everything is saved in the file; the status says whether it is synced too. */
function desktopStatus(s: sync.SyncState, unsynced: number): { text: string; kind: string; title: string } {
  const file = session.filePath() ?? 'the vault file';
  const problem = session.fileProblem();
  if (problem) return { text: 'File error', kind: 'err', title: problem };
  if (!session.linkedAccount()) return { text: 'Saved to file', kind: 'ok', title: `Saved in ${file}. Link an online account in Settings to sync.` };
  const remote = session.remoteState();
  const saved = `Saved in ${file}.`;
  if (remote.kind === 'denied') return { text: 'Sync paused', kind: 'err', title: remote.message };
  if (!navigator.onLine || remote.kind === 'offline' || s.kind === 'offline') {
    const why = (remote.kind === 'offline' && remote.message) || (s.kind === 'offline' && s.message) || '';
    return {
      text: unsynced ? `Offline · ${unsynced} to sync` : 'Offline · saved',
      kind: 'offline',
      title: `${saved} Changes sync when the server can be reached.${why ? ` ${why}` : ''}`,
    };
  }
  if (remote.kind === 'connecting' || s.kind === 'syncing') return { text: 'Syncing…', kind: 'syncing', title: saved };
  if (s.kind === 'error') return { text: 'Sync error', kind: 'err', title: s.message };
  if (s.kind === 'synced') {
    return { text: s.unreadable ? `Synced · ${s.unreadable} unreadable` : 'Synced', kind: 'ok', title: `${saved} Last synced ${new Date(s.at).toLocaleTimeString()}.` };
  }
  return { text: unsynced ? `${unsynced} to sync` : 'Saved to file', kind: 'ok', title: saved };
}

/** Status under the user name: Online · saved / Saving… / Offline · N unsaved / Sync error. */
function renderSyncState(s: sync.SyncState = sync.getSyncState()): void {
  const status = $('sync-status');
  const unsaved = store.isUnlocked() ? store.unsavedCount() : 0;
  if (DESKTOP) {
    const d = desktopStatus(s, unsaved);
    status.textContent = d.text;
    status.className = `sync-status ${d.kind}`;
    status.title = d.title;
    renderUserChip();
    const account = session.linkedAccount();
    $('btn-user').title = `${$('user-name').textContent}${account ? ` (${account.username})` : ''} · ${d.title}`;
    return;
  }
  let text = 'Online';
  let kind = 'ok';
  let title = 'Signed in. Changes are saved to your account automatically.';
  if (!navigator.onLine || s.kind === 'offline') {
    text = unsaved ? `Offline · ${unsaved} unsaved` : 'Offline';
    kind = 'offline';
    title = 'No connection. Keep this tab open: changes are saved when you are back online.';
  } else if (s.kind === 'syncing') {
    text = 'Saving…'; kind = 'syncing'; title = 'Saving to your account';
  } else if (s.kind === 'synced') {
    text = s.unreadable ? `Online · ${s.unreadable} unreadable` : 'Online · saved';
    title = `Last saved ${new Date(s.at).toLocaleTimeString()}`;
  } else if (s.kind === 'error') {
    text = 'Save error'; kind = 'err'; title = s.message;
  }
  status.textContent = text;
  status.className = `sync-status ${kind}`;
  status.title = title;
  renderUserChip();
  $('btn-user').title = `${$('user-name').textContent} (${settings.accountName}) · ${title}`;
}

async function syncFromMenu(): Promise<void> {
  if (shell.syncNow) { await shell.syncNow(); return; }
  if (!navigator.onLine) { toast('You are offline. Keep this tab open; changes are saved when you reconnect.'); return; }
  await sync.syncNow();
  const s = sync.getSyncState();
  if (s.kind === 'error') toast(s.message, 'error', 7000);
  else if (s.kind === 'synced') toast('Up to date.');
}

function wireUserMenu(): void {
  attachMenu($('btn-user') as HTMLButtonElement, {
    ariaLabel: 'Account menu',
    items: () => [
      ...(!DESKTOP || session.linkedAccount() ? [{ value: 'sync', label: 'Sync now', icon: '↻' }] : []),
      { value: 'settings', label: 'Settings', icon: '⚙' },
      { value: 'docs', label: 'Documentation', icon: '📖' },
      { value: 'theme', label: settings.dark ? 'Light mode' : 'Dark mode', icon: '🌓' },
      { value: 'lock', label: DESKTOP ? 'Lock' : 'Log out', icon: '🔒' },
    ],
    onSelect: action => {
      if (action === 'sync') void syncFromMenu();
      else if (action === 'settings') openSettings();
      else if (action === 'docs') openDocs();
      else if (action === 'theme') { settings.dark = !settings.dark; saveSettings(); renderAll(); }
      else if (action === 'lock') shell.lock();
    },
  });
  window.addEventListener('online', () => { renderSyncState(); if (store.isUnlocked()) void sync.syncNow(); });
  window.addEventListener('offline', () => renderSyncState());
}

// ---- Settings ----

let autoLockDropdown: Dropdown | null = null;
const settingsOpenHooks: (() => void)[] = [];
/** Runs each time Settings opens (the desktop build fills in its file and sync sections). */
export const onSettingsOpen = (fn: () => void): void => { settingsOpenHooks.push(fn); };

function openSettings(): void {
  settingsOpenHooks.forEach(fn => fn());
  $input('input-user-name').value = store.getProfile()?.userName ?? settings.userName;
  $('settings-account').textContent = settings.accountName;
  autoLockDropdown?.setValue(String(settings.autoLockMinutes));
  for (const id of ['input-current-password', 'input-new-password', 'input-confirm-password']) $input(id).value = '';
  $('security-error').classList.add('hidden');
  $('new-recovery-output').classList.add('hidden');
  closeNavIfNarrow();
  $('settings-modal').classList.remove('hidden');
  $input('input-user-name').focus();
}

function closeSettings(): void {
  closeDropdowns();
  $('settings-modal').classList.add('hidden');
  $('new-recovery-key').textContent = '';
  $('new-recovery-output').classList.add('hidden');
}

async function importFile(file: File): Promise<void> {
  let data: unknown;
  try { data = JSON.parse(await file.text()); } catch { toast('That file is not valid JSON.', 'error'); return; }

  if (store.isBackup(data)) {
    if (data.header.vaultId !== store.getHeader()?.vaultId) {
      toast('This backup belongs to a different vault, so it cannot be decrypted here.', 'error', 7000);
      return;
    }
    const { changed, failed } = store.applyEnvelopes(data.notes, true);
    toast(`Merged ${changed} note(s) from the encrypted backup into ${DESKTOP ? 'this file' : 'your account'}.${failed ? ` ${failed} could not be decrypted.` : ''}`);
    return;
  }
  if (typeof data === 'object' && data !== null && 'notes' in data) {
    const count = await store.importPlainNotes(parseLegacyNotes((data as { notes: unknown }).notes));
    toast(`Imported and encrypted ${count} note(s) from an unencrypted backup. Delete the original file, since anyone can read it.`, 'info', 9000);
    return;
  }
  toast('That is not a Cherrion backup file.', 'error');
}

function securityError(message: string): void {
  const e = $('security-error');
  e.textContent = message;
  e.classList.remove('hidden');
}

async function runSecurityAction(button: HTMLButtonElement, work: () => Promise<void>): Promise<void> {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('#form-security button')];
  buttons.forEach(b => (b.disabled = true));
  const restore = setWorking(button);
  $('security-error').classList.add('hidden');
  try {
    await nextPaint();
    await work();
  } catch (err) {
    securityError(err instanceof WrongSecretError ? 'Your current password is wrong.' : err instanceof Error ? err.message : String(err));
  } finally {
    buttons.forEach(b => (b.disabled = false));
    restore();
  }
}

function wireSettings(): void {
  autoLockDropdown = mountDropdown('select-auto-lock', {
    ariaLabel: 'Auto-lock',
    options: AUTO_LOCK_CHOICES.map(m => ({ value: String(m), label: m === 0 ? 'Never' : m === 1 ? 'After 1 minute' : `After ${m} minutes` })),
    value: String(settings.autoLockMinutes),
    onChange: () => { /* saved with the Save button */ },
  });

  $('btn-close-settings').onclick = closeSettings;

  const saveProfile = $('btn-save-profile') as HTMLButtonElement;
  saveProfile.onclick = async () => {
    const name = normalizeUserName($input('input-user-name').value);
    if (!name) { toast('Enter a user name.', 'error'); return; }
    if (name === store.getProfile()?.userName) { toast('Name unchanged.'); return; }
    saveProfile.disabled = true;
    try {
      store.setUserName(name);
      rememberUserName();
      $input('input-user-name').value = name;
      toast('Name saved to your account.');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      saveProfile.disabled = false;
    }
  };
  $('settings-modal').addEventListener('mousedown', e => { if (e.target === e.currentTarget) closeSettings(); });
  $('settings-modal').addEventListener('keydown', e => { if (e.key === 'Escape') closeSettings(); });

  $('btn-save-settings').onclick = () => {
    if (autoLockDropdown) settings.autoLockMinutes = Number(autoLockDropdown.value);
    saveSettings();
    toast('Preferences saved.');
  };

  $('btn-export-json').onclick = async () => {
    const backup = await store.makeBackup();
    download(`cherrion-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup, null, 2));
    toast('Encrypted backup downloaded. Only this vault (your password or recovery key) can open it.');
  };

  const importInput = $input('input-import-json');
  importInput.onchange = async () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (file) await importFile(file);
  };

  $('form-security').addEventListener('submit', e => {
    e.preventDefault();
    const current = $input('input-current-password').value;
    const next = $input('input-new-password').value;
    if (!current) { securityError('Enter your current password.'); return; }
    const problem = passwordProblem(next);
    if (problem) { securityError(problem); return; }
    if (next !== $input('input-confirm-password').value) { securityError('The new passwords do not match.'); return; }
    void runSecurityAction($('btn-change-password') as HTMLButtonElement, async () => {
      await store.changePassword(current, next);
      for (const id of ['input-current-password', 'input-new-password', 'input-confirm-password']) $input(id).value = '';
      toast('Vault password changed. Use the new one next time you unlock.');
    });
  });

  $('btn-new-recovery').onclick = () => {
    const current = $input('input-current-password').value;
    if (!current) { securityError('Enter your current password to create a new recovery key.'); return; }
    void runSecurityAction($('btn-new-recovery') as HTMLButtonElement, async () => {
      const key = await store.newRecoveryKey(current);
      $input('input-current-password').value = '';
      $('new-recovery-key').textContent = key;
      $('new-recovery-output').classList.remove('hidden');
    });
  };

  $('btn-copy-new-recovery').onclick = () => {
    navigator.clipboard.writeText($('new-recovery-key').textContent ?? '')
      .then(() => toast('Recovery key copied.'), () => toast('Copy failed: the browser blocked clipboard access.', 'error'));
  };
}

async function deleteCurrentNote(): Promise<void> {
  const note = currentNote();
  if (note) await deleteNote(note.id);
}

/** Asks in the delete dialog, then deletes the page and its sub-pages (the toolbar, Delete key and menu). */
async function deleteNote(id: string): Promise<void> {
  const note = store.getNote(id);
  if (!note || note.deleted) return;
  const subs = countDescendants(store.activeNotes(), note.id);
  const where = DESKTOP && !session.linkedAccount() ? 'from this file' : 'on all synced devices';
  const ok = await confirmDialog({
    title: 'Delete page?',
    message: `“${note.title || 'Untitled'}”${subs ? ` and its ${subs} sub-page${subs === 1 ? '' : 's'}` : ''} will be deleted ${where}. This cannot be undone.`,
  });
  if (!ok) return;
  const fromTree = $('tree-container').contains(document.activeElement);
  const removed = store.deleteNoteTree(note.id);
  if (ui.activeNoteId && removed.includes(ui.activeNoteId)) selectNote(store.activeNotes()[0]?.id ?? null);
  renderAll();
  // Keep working from the keyboard: focus moves to the page that is now selected.
  if (ui.activeNoteId && !narrow.matches) focusTreeRow(ui.activeNoteId);
  else if (fromTree) $('tree-container').focus();
}

// ---- Wiring ----

export function wireApp(): void {
  render.all = renderAll;
  render.tree = renderTree;
  render.editor = renderEditor;
  render.stickies = renderStickyBoard;
  shell.closeNav = closeNavIfNarrow;

  wireDialog();
  wireTemplatePicker();
  wireSettings();

  mountDropdown('category-filter', {
    className: 'dd-block',
    ariaLabel: 'Filter by category',
    options: [{ value: 'all', label: 'All categories', svg: 'layers' }, ...CATEGORY_IDS.map(id => ({ value: id, label: CATEGORIES[id].label, icon: CATEGORIES[id].icon }))],
    value: 'all',
    onChange: v => { ui.category = v as CategoryId | 'all'; renderTree(); },
  });

  addContextMenu($('tree-container'), treeContextMenu);
  wireEditorContextMenu();
  wireEditorPictures();
  wireTreeDrag($('tree-container'), (dragId, target) => {
    const changes = planMove(store.activeNotes(), dragId, target.id, target.pos);
    if (changes?.length) applyMove(dragId, changes, false);
  });

  $('btn-menu').onclick = () => setNav(!$('app').classList.contains('nav-open'));
  $('nav-backdrop').onclick = () => setNav(false);
  $('sidebar').addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('app').classList.contains('nav-open')) { setNav(false); $('btn-menu').focus(); }
  });
  narrow.addEventListener('change', () => { if (!narrow.matches) setNav(false); });

  $('btn-new-root').onclick = () => openTemplatePicker(null);
  $('btn-empty-create').onclick = () => openTemplatePicker(null);
  $('btn-add-child').onclick = () => { if (currentNote()) openTemplatePicker(ui.activeNoteId); };
  $('btn-delete-note').onclick = () => void deleteCurrentNote();
  wireTransfer();
  wireDocs();
  attachMenu($('btn-page-more') as HTMLButtonElement, {
    ariaLabel: 'More page actions',
    items: () => [
      { value: 'export', label: 'Export page…', svg: 'download' },
      { value: 'import', label: 'Import page here…', svg: 'upload' },
    ],
    onSelect: action => {
      const note = currentNote();
      if (action === 'export' && note) openExport(note.id);
      else if (action === 'import') openImport(note?.id ?? null);
    },
  });
  $('btn-theme').onclick = () => { settings.dark = !settings.dark; saveSettings(); renderAll(); };
  $('tab-tree').onclick = () => { ui.activeTab = 'tree'; renderAll(); };
  $('tab-stickies').onclick = () => { ui.activeTab = 'stickies'; closeNavIfNarrow(); renderAll(); };
  $input('search-input').addEventListener('input', e => { ui.search = (e.target as HTMLInputElement).value; renderTree(); });

  const title = $('note-title') as HTMLTextAreaElement;
  title.addEventListener('input', () => {
    const note = currentNote();
    if (!note) return;
    if (/\n/.test(title.value)) title.value = title.value.replace(/\s*\n\s*/g, ' '); // titles are one line, even when pasted
    autoResize(title);
    note.title = title.value;
    store.touchNote(note);
    renderBreadcrumbs(note);
    renderTree();
  });
  title.addEventListener('keydown', e => {
    // Enter moves into the page body instead of adding a line break.
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const first = currentNote()?.blocks[0];
    if (first) focusBlock(first.id);
  });
  window.addEventListener('resize', () => autoResize(title));
  $('btn-add-block').onclick = () => { const note = currentNote(); if (note) addBlockAtEnd(note); };
  $('btn-pin-sticky').onclick = () => {
    const note = currentNote();
    if (!note) return;
    note.isSticky = !note.isSticky;
    store.touchNote(note);
    renderAll();
  };
  $('btn-popout').onclick = () => { if (ui.activeNoteId) void openFloatingSticky(ui.activeNoteId); };

  wireUserMenu();
  sync.onSyncState(renderSyncState);
  if (DESKTOP) session.onDesktopChange(() => renderSyncState());
  store.onPersisted(() => { sync.scheduleSync(); renderSyncState(); });
  store.onChange(({ reason, ids }) => {
    if (!store.isUnlocked()) return;
    if (reason === 'header') { renderUserChip(); rememberUserName(); return; }
    renderTree();
    renderStickyBoard();
    // Only rebuild the editor when its own note changed, so typing elsewhere keeps the cursor.
    if (!currentNote()) { selectNote(store.activeNotes()[0]?.id ?? null); renderEditor(); }
    else if (ui.activeNoteId && ids.includes(ui.activeNoteId)) renderEditor();
    else renderBreadcrumbs(currentNote());
  });

  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && store.isUnlocked()) {
      e.preventDefault();
      if (narrow.matches) setNav(true);
      $input('search-input').focus();
    }
  });
}
