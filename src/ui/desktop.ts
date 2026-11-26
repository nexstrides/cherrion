// Desktop app screens: open / create / download a vault file, reset its password, lock it, and the
// "Online sync" part of Settings. The web version's login screen lives in lock.ts.
import { DEFAULT_KDF_COST, wipe } from '../crypto';
import { py, type AppInfo, type CloseAction } from '../desktop/bridge';
import * as session from '../desktop/session';
import { settings } from '../settings';
import * as store from '../store';
import * as sync from '../sync';
import {
  authKeyFromKek, createVault, deriveKek, normalizeUserName, rewrapPasswordWithAuth, unlockWithKek, unlockWithRecoveryKey,
  WrongSecretError,
} from '../vault';
import { clearAppDom, onSettingsOpen } from './app';
import { confirmDialog } from './dialog';
import { mountDropdown, type Dropdown } from './dropdown';
import { $, $input, el, toast } from './dom';
import { clearClipboardNow } from './editor';
import { busy, checkNewPassword, enterApp, onSubmit, setError, showPanel, username, welcomeNotes, wireRecoveryPanel } from './lock';
import { idleFor, markActivity, shell } from './state';
import { closeAllPopouts } from './stickies';

let info: AppInfo = { version: '', recent: [], defaultSyncUrl: '', launchFile: null };
/** The vault file chosen on the start screen (kept after locking, like CherryTree's last document). */
let selected: string | null = null;
/** A file double-clicked in File Explorer is selected once, when the app starts. */
let launchFileUsed = false;

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;
const dirName = (p: string): string => p.slice(0, Math.max(0, p.length - baseName(p).length - 1));

// ---- Start screen ----

export async function showDesktopStart(): Promise<void> {
  $('app').classList.add('hidden');
  $('lock-screen').classList.remove('hidden');
  $('dev-db-warning').classList.add('hidden');
  info = await py('app_info');
  if (info.launchFile && !launchFileUsed) {
    launchFileUsed = true;
    selected = info.launchFile;
  }
  selected ??= info.recent[0] ?? null;
  renderRecent();
  showPanel('open');
}

function renderRecent(): void {
  const paths = [...new Set([...(selected ? [selected] : []), ...info.recent])];
  const list = $('recent-files');
  if (!paths.length) {
    list.replaceChildren(el('p', { className: 'recent-empty', text: 'No vault files yet. Create one, or get your online account.' }));
    return;
  }
  list.replaceChildren(...paths.map(p => {
    const item = el('button', { type: 'button', className: 'recent-file', title: p },
      el('span', { className: 'rf-name', text: baseName(p) }),
      el('span', { className: 'rf-dir', text: dirName(p) }));
    item.setAttribute('role', 'radio');
    item.setAttribute('aria-checked', String(p === selected));
    item.onclick = () => { selected = p; renderRecent(); $input('open-password').focus(); };
    return item;
  }));
}

const onlineMode = (): 'login' | 'signup' =>
  ($('online-mode').querySelector<HTMLInputElement>('input:checked')?.value === 'signup' ? 'signup' : 'login');

/** "Sync with an online account": log in to an existing account, or create one. */
function updateOnlineMode(): void {
  const signup = onlineMode() === 'signup';
  $('online-name-wrap').classList.toggle('hidden', !signup);
  $('online-confirm-wrap').classList.toggle('hidden', !signup);
  $input('download-password').autocomplete = signup ? 'new-password' : 'current-password';
  $('online-intro').textContent = signup
    ? 'Creates your online account and a vault file on this PC that stays in sync with it. Use the same username and password on the website or another PC. Your notes are encrypted on this PC before they are uploaded.'
    : 'Downloads your encrypted notes into a new vault file on this PC and keeps it in sync. The file opens with your account password, also when you are offline.';
  if (signup && !$input('online-name').value) $input('online-name').value = settings.userName;
}

/** Opens the chosen file and checks the password locally (no network needed). */
async function unlockSelected(password: string): Promise<void> {
  if (!selected) throw new Error('Choose a vault file first.');
  const file = await session.openFile(selected);
  let vaultKey: Uint8Array;
  let loginKey: Uint8Array | null = null;
  const kek = deriveKek(password, file.header.kdf);
  try {
    try {
      vaultKey = unlockWithKek(file.header, kek);
    } catch (err) {
      await py('vault_close');
      throw err instanceof WrongSecretError ? new Error('Wrong password for this file.') : err;
    }
    if (file.sync) loginKey = authKeyFromKek(kek);
  } finally {
    wipe(kek);
  }
  selected = file.path;
  store.unlock(file.header, vaultKey, file.notes, file.unsent);
  session.attach(file.path, file.sync, loginKey);
}

function wireStartScreen(): void {
  for (const back of document.querySelectorAll<HTMLButtonElement>('#lock-screen [data-panel]')) {
    back.onclick = () => showPanel(back.dataset.panel ?? 'open');
  }
  $('btn-browse-vault').onclick = async () => {
    const picked = await py('pick_open');
    if (!picked) return;
    selected = picked;
    renderRecent();
    $input('open-password').focus();
  };
  $('link-create-file').onclick = () => {
    $input('create-name').value = settings.userName;
    showPanel('create');
  };
  $('link-download-account').onclick = () => {
    if (!$input('download-url').value) $input('download-url').value = info.defaultSyncUrl;
    updateOnlineMode();
    showPanel('download');
  };
  $('online-mode').addEventListener('change', () => {
    updateOnlineMode();
    $('panel-download').querySelector('.form-error')?.classList.add('hidden');
  });
  $('link-file-recover').onclick = () => {
    const form = $('panel-open') as HTMLFormElement;
    if (!selected) { setError(form, 'Choose the vault file first.'); return; }
    $('file-recover-name').textContent = `File: ${baseName(selected)}`;
    showPanel('file-recover');
  };

  onSubmit('panel-open', form => {
    const password = $input('open-password').value;
    if (!selected) { setError(form, 'Choose a vault file first: pick a recent one or browse.'); return; }
    if (!password) { setError(form, 'Enter the file’s password.'); return; }
    void busy(form, async () => {
      await unlockSelected(password);
      enterApp();
    });
  });

  onSubmit('panel-create', form => {
    const name = normalizeUserName($input('create-name').value);
    const password = $input('create-password').value;
    if (!name) { setError(form, 'Enter your name.'); return; }
    if (!checkNewPassword(form, password, $input('create-confirm').value)) return;
    void busy(form, async () => {
      const target = await py('pick_save', `${name} notes`);
      if (!target) return;
      const v = createVault(password, DEFAULT_KDF_COST, { userName: name });
      wipe(v.authKey);
      wipe(v.recoveryAuthKey);
      const path = await session.createFile(target, v.header, [], null);
      selected = path;
      store.unlock(v.header, v.vaultKey, []);
      session.attach(path, null, null);
      welcomeNotes().forEach(store.addNote);
      await store.flush();
      $('recovery-key-text').textContent = v.recoveryKey;
      showPanel('recovery');
    });
  });

  onSubmit('panel-download', form => {
    const signup = onlineMode() === 'signup';
    const account = username(form, 'download-username');
    const password = $input('download-password').value;
    if (!account) return;
    let url: string;
    try { url = session.normalizeServerUrl($input('download-url').value); } catch (err) { setError(form, (err as Error).message); return; }
    const name = normalizeUserName($input('online-name').value) || account;
    if (signup) {
      if (!checkNewPassword(form, password, $input('online-confirm').value)) return;
    } else if (!password) {
      setError(form, 'Enter your account password.');
      return;
    }
    void busy(form, async () => {
      const target = await py('pick_save', signup ? `${name} notes` : account);
      if (!target) return;
      if (signup) {
        const recoveryKey = await session.createOnlineAccount(url, account, password, name, target, welcomeNotes());
        selected = session.filePath();
        $('recovery-key-text').textContent = recoveryKey;
        showPanel('recovery');
        return;
      }
      await session.downloadAccount(url, account, password, target);
      selected = session.filePath();
      enterApp();
      toast('Your account is now in this file and keeps syncing. It opens with your account password, also offline.', 'info', 7000);
    });
  });

  onSubmit('panel-file-recover', form => {
    const recoveryText = $input('file-recover-key').value;
    const password = $input('file-recover-password').value;
    if (!recoveryText.trim()) { setError(form, 'Enter your recovery key.'); return; }
    if (!checkNewPassword(form, password, $input('file-recover-confirm').value)) return;
    void busy(form, async () => {
      if (!selected) throw new Error('Choose the vault file first.');
      const file = await session.openFile(selected);
      let vaultKey: Uint8Array;
      try {
        vaultKey = unlockWithRecoveryKey(file.header, recoveryText);
      } catch (err) {
        await py('vault_close');
        throw err;
      }
      const next = rewrapPasswordWithAuth(file.header, vaultKey, password);
      let loginKey: Uint8Array | null = null;
      let onlineNote = '';
      if (file.sync) {
        try {
          await session.recoverOnline(file.sync, recoveryText, next.header, next.authKey);
          loginKey = next.authKey;
        } catch (err) {
          onlineNote = ` The online account still has the old password (${(err as Error).message}). Reset it on the website with your recovery key, then log in again in Settings → Online sync.`;
        }
      }
      if (!loginKey) wipe(next.authKey);
      store.unlock(next.header, vaultKey, file.notes, file.unsent);
      session.attach(file.path, file.sync, loginKey);
      session.saveHeader(next.header);
      enterApp();
      toast(`Password reset. Your recovery key still works.${onlineNote}`, onlineNote ? 'error' : 'info', onlineNote ? 12000 : 6000);
    });
  });

  wireRecoveryPanel(() => `Vault file: ${selected ? baseName(selected) : ''}`);
}

// ---- Locking ----

let locking = false;

/** Writes everything to the file, wipes the key and decrypted notes, and closes the file. */
export async function lockVault(reason?: string): Promise<void> {
  if (!store.isUnlocked() || locking) return;
  locking = true;
  try {
    closeAllPopouts();
    clearClipboardNow();
    await store.flush();
    await session.flushWrites();
    await store.lock();
    sync.stopSync();
    await session.detach();
    clearAppDom();
    await showDesktopStart();
    if (reason) toast(reason);
  } finally {
    locking = false;
  }
}

// ---- Settings → Online sync ----

function renderSyncSettings(): void {
  const linked = session.linkedAccount();
  const remote = session.remoteState();
  const denied = remote.kind === 'denied';
  $('settings-file-path').textContent = session.filePath() ?? '';
  $('sync-linked').classList.toggle('hidden', !linked);
  $('sync-linked-user').textContent = linked?.username ?? '';
  $('sync-linked-url').textContent = linked?.url ?? '';
  $('sync-denied').classList.toggle('hidden', !denied);
  $('sync-denied').textContent = denied ? remote.message : '';
  $('form-sync').classList.toggle('hidden', !!linked && !denied);
  for (const id of ['sync-intro', 'sync-url-wrap', 'sync-user-wrap', 'btn-sync-create']) $(id).classList.toggle('hidden', !!linked);
  $('sync-password-hint').textContent = linked
    ? 'Your online account’s current password. This file will use it from now on.'
    : 'To link: your online account’s password. To create an account: this file’s password, which the account will use.';
  $('btn-sync-link').querySelector('.btn-text')!.textContent = linked ? 'Log in again' : 'Link to my account';
  if (!$input('sync-url').value) $input('sync-url').value = info.defaultSyncUrl;
}

async function syncAction(kind: 'link' | 'create'): Promise<void> {
  const form = $('form-sync') as HTMLFormElement;
  const linked = session.linkedAccount();
  const account = linked?.username ?? username(form, 'sync-username');
  const password = $input('sync-password').value;
  if (!account) return;
  let url: string;
  try { url = session.normalizeServerUrl(linked?.url ?? $input('sync-url').value); } catch (err) { setError(form, (err as Error).message); return; }
  if (!password) { setError(form, kind === 'create' ? 'Enter this file’s password.' : 'Enter your account password.'); return; }
  if (kind === 'create' && !(await confirmDialog({
    title: `Create the online account “${account}”?`,
    message: 'Your notes are uploaded encrypted, and this file keeps syncing with the account. A new recovery key is created, and this file’s old recovery key stops working.',
    confirmLabel: 'Create account',
    danger: false,
  }))) return;
  await busy(form, async () => {
    if (kind === 'link') {
      await session.signIn(url, account, password);
      toast(linked ? 'Logged in again. Syncing resumed.' : 'Linked. This file now syncs with your online account.');
    } else {
      const key = await session.createAccount(url, account, password);
      $('sync-recovery-key').textContent = key;
      $('sync-recovery-output').classList.remove('hidden');
      toast('Online account created. Save its recovery key.');
    }
    $input('sync-password').value = '';
  });
  renderSyncSettings();
}

async function renderFileAssociation(): Promise<void> {
  const box = $input('input-file-assoc');
  const hint = $('file-assoc-hint');
  try {
    const state = await py('file_association');
    box.checked = state.enabled;
    box.disabled = !state.available;
    hint.textContent = state.available ? '' : 'Available in Cherrion.exe (not when running from source).';
    hint.classList.toggle('hidden', state.available);
  } catch (err) {
    box.disabled = true;
    hint.textContent = (err as Error).message;
    hint.classList.remove('hidden');
  }
}

function wireFileAssociation(): void {
  onSettingsOpen(() => void renderFileAssociation());
  const box = $input('input-file-assoc');
  box.onchange = async () => {
    const want = box.checked;
    box.disabled = true;
    try {
      const state = await py('set_file_association', want);
      box.checked = state.enabled;
      toast(state.enabled
        ? 'Double-clicking a .cherrion file now opens it in Cherrion.'
        : '.cherrion files no longer open with Cherrion on double-click.');
    } catch (err) {
      box.checked = !want;
      toast((err as Error).message, 'error', 7000);
    } finally {
      box.disabled = false;
    }
  };
}

function wireSyncSettings(): void {
  onSettingsOpen(() => {
    $input('sync-password').value = '';
    $('sync-recovery-output').classList.add('hidden');
    $('sync-recovery-key').textContent = '';
    renderSyncSettings();
  });
  session.onDesktopChange(renderSyncSettings);
  $('form-sync').addEventListener('submit', e => { e.preventDefault(); void syncAction('link'); });
  $('btn-sync-create').onclick = () => void syncAction('create');
  $('btn-sync-now').onclick = () => void syncNowFromUi();
  $('btn-sync-unlink').onclick = async () => {
    if (!(await confirmDialog({
      title: 'Stop syncing this file?',
      message: 'The notes stay in this file and in your online account, but changes made here will no longer sync. You can link the file again later.',
      confirmLabel: 'Stop syncing',
    }))) return;
    await session.unlink();
    toast('This file no longer syncs. It stays on this PC.');
  };
  $('btn-copy-sync-recovery').onclick = () => {
    navigator.clipboard.writeText($('sync-recovery-key').textContent ?? '')
      .then(() => toast('Recovery key copied.'), () => toast('Copy failed: clipboard access was blocked.', 'error'));
  };
}

export async function syncNowFromUi(): Promise<void> {
  if (!session.linkedAccount()) { toast('This file is not linked to an online account. Link it in ⚙ Settings.'); return; }
  if (session.remoteState().kind === 'denied') { toast('Log in again in ⚙ Settings → Online sync.', 'error'); return; }
  await session.connect();
  await sync.syncNow();
  const s = sync.getSyncState();
  const remote = session.remoteState();
  if (remote.kind === 'offline' || s.kind === 'offline') {
    const why = (remote.kind === 'offline' && remote.message) || (s.kind === 'offline' && s.message) || '';
    toast(`Offline. Your changes are saved in the file and sync when the server can be reached.${why ? ` ${why}` : ''}`, 'info', why ? 10000 : 4500);
  }
  else if (s.kind === 'error') toast(s.message, 'error', 7000);
  else if (s.kind === 'synced') toast('Up to date.');
}

// ---- Closing the window: exit, or keep running in the tray ----

let closeDropdown: Dropdown | null = null;

function closeCloseDialog(): void {
  $('close-modal').classList.add('hidden');
}

/** Called by Python when the window's close button is pressed and no choice is remembered. */
function askClose(): void {
  $input('close-remember').checked = false;
  $('close-modal').classList.remove('hidden');
  requestAnimationFrame(() => $('close-tray').focus());
}

function chooseClose(choice: 'tray' | 'exit' | 'cancel'): void {
  const remember = choice !== 'cancel' && $input('close-remember').checked;
  closeCloseDialog();
  void py('close_choice', choice, remember).then(() => {
    if (remember) toast(choice === 'tray' ? 'Closing the window now hides Cherrion in the tray. Change this in ⚙ Settings.' : 'Closing the window now exits Cherrion. Change this in ⚙ Settings.', 'info', 6000);
  });
}

/** Another start of the app, or a double-clicked .cherrion file, while this one runs. */
function openFileFromSystem(path: string): void {
  if (store.isUnlocked()) {
    if (session.filePath()?.toLowerCase() !== path.toLowerCase()) {
      toast(`To open ${baseName(path)}, lock this file first (🔒), then choose it.`, 'info', 7000);
    }
    return;
  }
  selected = path;
  renderRecent();
  showPanel('open');
}

async function renderCloseAction(): Promise<void> {
  try {
    const available = await py('tray_available');
    $('close-action-wrap').classList.toggle('hidden', !available);
    if (available) closeDropdown?.setValue(await py('close_action'));
  } catch { $('close-action-wrap').classList.add('hidden'); }
}

function wireCloseBehaviour(): void {
  $('close-tray').onclick = () => chooseClose('tray');
  $('close-exit').onclick = () => chooseClose('exit');
  $('close-cancel').onclick = () => chooseClose('cancel');
  $('close-modal').addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); chooseClose('cancel'); } });
  closeDropdown = mountDropdown('select-close-action', {
    ariaLabel: 'When I close the window',
    options: [
      { value: 'ask', label: 'Ask every time', icon: '❔' },
      { value: 'tray', label: 'Hide to the tray', svg: 'tray' },
      { value: 'exit', label: 'Exit Cherrion', svg: 'power' },
    ],
    value: 'ask',
    onChange: v => { void py('set_close_action', v as CloseAction).then(() => toast('Saved.')); },
  });
  onSettingsOpen(() => void renderCloseAction());
  const w = window as unknown as Record<string, unknown>;
  w.__cherrionAskClose = askClose;
  w.__cherrionLock = () => void lockVault('Locked from the tray icon.');
  w.__cherrionOpenFile = openFileFromSystem;
}

// ---- Wiring ----

export function wireDesktop(): void {
  wireCloseBehaviour();
  session.wireDesktopSession();
  wireStartScreen();
  wireSyncSettings();
  wireFileAssociation();
  $('btn-lock').title = 'Lock';
  $('btn-lock').setAttribute('aria-label', 'Lock');
  $('btn-lock').onclick = () => void lockVault();
  shell.lock = () => void lockVault();
  shell.syncNow = syncNowFromUi;

  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
    window.addEventListener(type, markActivity, { capture: true, passive: true });
  }
  // Everything is already in the file, so auto-lock never has to wait for the server.
  setInterval(() => {
    const minutes = settings.autoLockMinutes;
    if (!store.isUnlocked() || minutes <= 0 || idleFor() <= minutes * 60_000) return;
    void lockVault('Locked after inactivity.');
  }, 15_000);
}
