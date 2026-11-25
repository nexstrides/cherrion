// Lock screen and session lifecycle: create / unlock / recover / join, manual lock, auto-lock.
import { DEFAULT_KDF_COST } from '../crypto';
import * as db from '../db';
import { clearLegacyLocalNotes, readLegacyLocalNotes, stampForMigration } from '../legacy';
import { now, textBlock, uid, type Note } from '../model';
import { saveSettings, settings } from '../settings';
import * as store from '../store';
import * as sync from '../sync';
import {
  createVault, normalizeUserName, passwordProblem, rewrapPassword, unlockWithPassword, unlockWithRecoveryKey,
  type VaultHeader,
} from '../vault';
import { clearAppDom, rememberUserName, renderAll } from './app';
import { $, $input, download, nextPaint, toast } from './dom';
import { clearClipboardNow } from './editor';
import { idleFor, markActivity, selectNote, shell, ui } from './state';
import { closeAllPopouts } from './stickies';

type Panel = 'setup' | 'recovery' | 'unlock' | 'recover' | 'join' | 'fatal';
const PANELS: Panel[] = ['setup', 'recovery', 'unlock', 'recover', 'join', 'fatal'];

function showPanel(panel: Panel): void {
  for (const p of PANELS) $(`panel-${p}`).classList.toggle('hidden', p !== panel);
  for (const e of document.querySelectorAll('#lock-screen .form-error')) e.classList.add('hidden');
  requestAnimationFrame(() => $(`panel-${panel}`).querySelector<HTMLElement>('input:not([type=checkbox]), button')?.focus());
}

function setError(form: HTMLElement, message: string): void {
  const e = form.querySelector('.form-error');
  if (!e) return;
  e.textContent = message;
  e.classList.remove('hidden');
}

/** Disables the form and shows "Working…" while Argon2id runs, then surfaces any error in the form. */
async function busy(form: HTMLFormElement, work: () => Promise<void>): Promise<void> {
  const buttons = [...form.querySelectorAll('button')];
  const submit = form.querySelector<HTMLButtonElement>('button[type=submit]');
  const label = submit?.textContent ?? '';
  buttons.forEach(b => (b.disabled = true));
  if (submit) submit.textContent = 'Working…';
  form.querySelector('.form-error')?.classList.add('hidden');
  try {
    await nextPaint();
    await work();
  } catch (err) {
    setError(form, err instanceof Error ? err.message : String(err));
  } finally {
    buttons.forEach(b => (b.disabled = false));
    if (submit) submit.textContent = label;
  }
}

function checkNewPassword(form: HTMLFormElement, password: string, confirm: string): boolean {
  const problem = passwordProblem(password);
  if (problem) { setError(form, problem); return false; }
  if (password !== confirm) { setError(form, 'The passwords do not match.'); return false; }
  return true;
}

export async function showLockScreen(): Promise<void> {
  $('app').classList.add('hidden');
  $('lock-screen').classList.remove('hidden');
  if (await db.getHeader()) {
    $('unlock-title').textContent = settings.userName ? `Welcome back, ${settings.userName}` : 'Unlock your vault';
    $input('unlock-username').value = settings.userName;
    showPanel('unlock');
    return;
  }
  const legacy = readLegacyLocalNotes().filter(n => !n.deleted).length;
  const note = $('setup-legacy-note');
  note.textContent = legacy
    ? `${legacy} existing note(s) in this browser will be encrypted into the new vault, and the unencrypted copy will be removed.`
    : '';
  note.classList.toggle('hidden', !legacy);
  showPanel('setup');
}

export function showFatal(err: unknown): void {
  console.error(err);
  $('fatal-message').textContent = err instanceof Error ? err.message : String(err);
  $('app').classList.add('hidden');
  $('lock-screen').classList.remove('hidden');
  showPanel('fatal');
}

function enterApp(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>('#lock-screen input')) {
    if (input.type === 'checkbox') input.checked = false; else input.value = '';
  }
  $('recovery-key-text').textContent = '';
  $('lock-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
  rememberUserName();
  const current = store.getNote(ui.activeNoteId);
  selectNote(current && !current.deleted ? current.id : store.activeNotes()[0]?.id ?? null);
  markActivity();
  renderAll();
  const unreadable = store.undecryptableCount();
  if (unreadable) toast(`${unreadable} saved note(s) could not be decrypted and are hidden.`, 'error', 8000);
  if (settings.syncUrl) void sync.syncNow();
}

export async function lockApp(broadcast: boolean): Promise<void> {
  if (!store.isUnlocked()) return;
  if (broadcast) store.broadcastLock();
  closeAllPopouts();
  clearClipboardNow();
  await store.lock();
  sync.resetSyncState();
  clearAppDom();
  await showLockScreen();
}

function welcomeNotes(): Note[] {
  return [{
    id: uid(), parentId: null, title: 'Welcome to Cherrion', category: 'note', collapsed: false,
    isSticky: true, stickyColor: 'yellow', updatedAt: now(), deleted: false,
    blocks: [
      textBlock('h2', 'Encrypted notes, templates and sticky notes'),
      textBlock('callout', 'Everything in this vault is encrypted with your vault password before it is saved or synced. Press ＋ to start a page from a template: Email account, Website login, Secure note or Meeting.'),
      textBlock('todo', 'Create an Email account page from the ＋ template picker'),
      textBlock('todo', 'Type "/" in an empty block for headings, to-dos, field groups and secret fields'),
      textBlock('todo', 'Keep your recovery key somewhere safe (⚙ Settings can make a new one)'),
    ],
  }];
}

/** Encrypts notes left by the pre-encryption version, then deletes the plaintext copy. */
async function migrateLocalLegacy(): Promise<void> {
  const legacy = readLegacyLocalNotes();
  if (!legacy.length) return;
  await store.importPlainNotes(stampForMigration(legacy));
  await store.flush();
  clearLegacyLocalNotes();
}

async function friendlyFetch<T>(url: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof TypeError) throw new Error(`Could not reach the sync server at ${url}. Is it running (npm run sync-server)?`);
    throw err;
  }
}

function validUrl(text: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(text).protocol); } catch { return false; }
}

function onSubmit(id: string, handler: (form: HTMLFormElement) => void): void {
  const form = $(id) as HTMLFormElement;
  form.addEventListener('submit', e => { e.preventDefault(); handler(form); });
}

export function wireLockScreen(): void {
  $('link-join').onclick = () => showPanel('join');
  $('link-setup').onclick = () => showPanel('setup');
  $('link-recover').onclick = () => showPanel('recover');
  $('link-unlock').onclick = () => showPanel('unlock');

  onSubmit('panel-setup', form => {
    const userName = normalizeUserName($input('setup-username').value);
    const password = $input('setup-password').value;
    if (!userName) { setError(form, 'Enter a user name.'); return; }
    if (!checkNewPassword(form, password, $input('setup-confirm').value)) return;
    void busy(form, async () => {
      const { header, vaultKey, recoveryKey } = createVault(password, DEFAULT_KDF_COST, { userName });
      settings.userName = userName;
      saveSettings();
      await store.saveHeader(header);
      await store.unlock(header, vaultKey);
      await migrateLocalLegacy();
      if (!store.activeNotes().length) welcomeNotes().forEach(store.addNote);
      await store.flush();
      $('recovery-key-text').textContent = recoveryKey;
      showPanel('recovery');
    });
  });

  const saved = $input('recovery-saved');
  const proceed = $('btn-recovery-continue') as HTMLButtonElement;
  saved.onchange = () => { proceed.disabled = !saved.checked; };
  proceed.onclick = () => { proceed.disabled = true; enterApp(); };
  $('btn-copy-recovery').onclick = () => {
    navigator.clipboard.writeText($('recovery-key-text').textContent ?? '')
      .then(() => toast('Recovery key copied. Paste it somewhere safe, then clear your clipboard.'),
        () => toast('Copy failed: the browser blocked clipboard access.', 'error'));
  };
  $('btn-download-recovery').onclick = () => {
    const key = $('recovery-key-text').textContent ?? '';
    download('cherrion-recovery-key.txt',
      `Cherrion recovery key\nCreated ${new Date().toLocaleString()}\n\n${key}\n\nAnyone with this key can reset your vault password. Keep it offline.\n`,
      'text/plain');
  };

  onSubmit('panel-unlock', form => {
    const password = $input('unlock-password').value;
    void busy(form, async () => {
      const header = await db.getHeader();
      if (!header) { await showLockScreen(); return; }
      const key = unlockWithPassword(header, password);
      await store.unlock(header, key);
      enterApp();
    });
  });

  onSubmit('panel-recover', form => {
    const recoveryKey = $input('recover-key').value;
    const password = $input('recover-password').value;
    if (!checkNewPassword(form, password, $input('recover-confirm').value)) return;
    void busy(form, async () => {
      const header = await db.getHeader();
      if (!header) { await showLockScreen(); return; }
      const key = unlockWithRecoveryKey(header, recoveryKey);
      const next: VaultHeader = rewrapPassword(header, key, password);
      await store.saveHeader(next);
      await store.unlock(next, key);
      enterApp();
      toast('Password reset. Your recovery key still works; ⚙ Settings can make a new one.', 'info', 7000);
    });
  });

  onSubmit('panel-join', form => {
    const url = $input('join-url').value.trim();
    const room = $input('join-room').value.trim();
    const password = $input('join-password').value;
    if (!validUrl(url)) { setError(form, 'The sync server URL must start with http:// or https://'); return; }
    if (!room) { setError(form, 'Enter the sync room key used on your other device.'); return; }
    void busy(form, async () => {
      const { header, records } = await friendlyFetch(url, () => sync.fetchVaultFromRoom(url, room));
      const key = unlockWithPassword(header, password);
      settings.syncUrl = url;
      settings.syncKey = room;
      saveSettings();
      await store.saveHeader(header);
      await store.unlock(header, key);
      await migrateLocalLegacy();
      await sync.absorbRoom(records);
      enterApp();
    });
  });

  $('btn-lock').onclick = () => void lockApp(true);
  shell.lock = () => void lockApp(true);
  store.onLockRequest(() => void lockApp(false));

  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
    window.addEventListener(type, markActivity, { capture: true, passive: true });
  }
  setInterval(() => {
    const minutes = settings.autoLockMinutes;
    if (store.isUnlocked() && minutes > 0 && idleFor() > minutes * 60_000) {
      void lockApp(false).then(() => toast('Locked after inactivity.'));
    }
  }, 15_000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') store.flush().catch(err => console.error(err));
  });
}
