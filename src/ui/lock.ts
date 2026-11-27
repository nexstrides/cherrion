// Login screen and session lifecycle for the online (Vercel + Postgres) version:
// log in / create account / reset with recovery key, log out, auto-lock.
import { api, ApiError, setReauthenticator, setSession } from '../api';
import { DEFAULT_KDF_COST, wipe } from '../crypto';
import { deleteLocalVault, readLocalVault, type LocalVault } from '../db';
import type { Envelope } from '../envelope';
import { clearLegacyLocalNotes, readLegacyLocalNotes, stampForMigration } from '../legacy';
import { now, textBlock, uid, type Note } from '../model';
import { DESKTOP } from '../platform';
import { saveSettings, settings } from '../settings';
import * as store from '../store';
import * as sync from '../sync';
import {
  authKeyFromKek, createVault, deriveKek, passwordProblem, readProfile, recoveryAuthKey, rewrapPasswordWithAuth,
  rotateRecoveryKey, setProfile, unlockWithKek, unlockWithRecoveryKey, WrongSecretError, type VaultHeader,
} from '../vault';
import { clearAppDom, rememberUserName, renderAll } from './app';
import { confirmDialog } from './dialog';
import { $, $input, download, nextPaint, setWorking, toast } from './dom';
import { clearClipboardNow } from './editor';
import { idleFor, markActivity, selectNote, shell, ui } from './state';
import { closeAllPopouts } from './stickies';

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,39}$/;

/** Shows one start-screen panel (`panel-<name>`) and focuses its first empty input. */
export function showPanel(panel: string): void {
  for (const p of document.querySelectorAll('#lock-screen .lock-panel')) p.classList.toggle('hidden', p.id !== `panel-${panel}`);
  for (const e of document.querySelectorAll('#lock-screen .form-error')) e.classList.add('hidden');
  requestAnimationFrame(() => {
    const inputs = [...$(`panel-${panel}`).querySelectorAll<HTMLInputElement>('input:not([type=checkbox]):not([type=radio]):not([type=file])')];
    (inputs.find(i => !i.value) ?? inputs[0] ?? $(`panel-${panel}`).querySelector<HTMLElement>('button'))?.focus();
  });
}

export function setError(form: HTMLElement, message: string): void {
  const e = form.querySelector('.form-error');
  if (!e) return;
  e.textContent = message;
  e.classList.remove('hidden');
}

/** Disables the form and shows "Working…" while Argon2id and the server run, then shows any error. */
export async function busy(form: HTMLFormElement, work: () => Promise<void>): Promise<void> {
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

export function checkNewPassword(form: HTMLFormElement, password: string, confirm: string): boolean {
  const problem = passwordProblem(password);
  if (problem) { setError(form, problem); return false; }
  if (password !== confirm) { setError(form, 'The passwords do not match.'); return false; }
  return true;
}

export function username(form: HTMLFormElement, inputId: string): string | null {
  const u = $input(inputId).value.trim().toLowerCase();
  if (USERNAME.test(u)) return u;
  setError(form, 'Usernames are 3–40 characters: letters, digits, dot, dash or underscore.');
  return null;
}

// ---- Screens ----

/** Whether the server's database survives restarts (false for the local in-memory dev store). */
let persistentServer = true;

export async function showLockScreen(): Promise<void> {
  $('app').classList.add('hidden');
  $('lock-screen').classList.remove('hidden');
  persistentServer = await api.persistent();
  $('dev-db-warning').classList.toggle('hidden', persistentServer);
  $('login-title').textContent = settings.userName ? `Welcome back, ${settings.userName}` : 'Log in';
  $input('login-username').value = settings.accountName;
  showPanel('login');
}

export function showFatal(err: unknown): void {
  console.error(err);
  $('fatal-message').textContent = err instanceof Error ? err.message : String(err);
  $('app').classList.add('hidden');
  $('lock-screen').classList.remove('hidden');
  showPanel('fatal');
}

let localVault: LocalVault | null = null;

async function showSignup(): Promise<void> {
  localVault = await readLocalVault();
  const pages = localVault?.notes.filter(n => !n.deleted).length ?? 0;
  $('source-local').classList.toggle('hidden', !localVault);
  $('source-local-text').textContent = `The vault saved in this browser (${pages} page${pages === 1 ? '' : 's'})`;
  const legacy = readLegacyLocalNotes().filter(n => !n.deleted).length;
  $('signup-legacy-note').textContent = legacy
    ? `${legacy} older unencrypted note(s) in this browser will be encrypted into your account, and the unencrypted copy removed.`
    : '';
  $('signup-legacy-note').classList.toggle('hidden', !legacy);
  if (localVault) ($('signup-source').querySelector('input[value=local]') as HTMLInputElement).checked = true;
  updateSignupSource();
  showPanel('signup');
}

const signupSource = (): 'new' | 'local' | 'file' =>
  (($('signup-source').querySelector('input:checked') as HTMLInputElement | null)?.value ?? 'new') as 'new' | 'local' | 'file';

function updateSignupSource(): void {
  const source = signupSource();
  $('signup-file-wrap').classList.toggle('hidden', source !== 'file');
  $('signup-confirm-wrap').classList.toggle('hidden', source !== 'new');
  $('signup-password-label').textContent = source === 'new' ? 'Password' : 'Password of that vault';
  $('signup-source-hint').textContent = source === 'new'
    ? ''
    : 'Your account uses this vault’s password. A new recovery key is created, and the old one stops working.';
}

// ---- Session ----

/** Loads the account's notes and opens the app. */
async function startSession(account: string, token: string, header: VaultHeader, vaultKey: Uint8Array, initial?: Envelope[]): Promise<void> {
  setSession(token);
  settings.accountName = account;
  saveSettings();
  const notes = initial ?? (await sync.loadAll()).notes;
  store.unlock(header, vaultKey, notes);
  sync.startSync();
}

export function enterApp(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>('#lock-screen input')) {
    if (input.type === 'checkbox' || input.type === 'radio') input.checked = input.defaultChecked;
    else input.value = '';
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
  void sync.syncNow();
}

// ---- Renewing an expired session (sessions last 12 hours) ----

/** The account and its one-way login key, kept while logged in so an expired session can be renewed
 *  without asking (the vault key, a far stronger secret, is in memory anyway). Wiped on log out. */
let loginAccount: string | null = null;
let loginKey: Uint8Array | null = null;

function keepLogin(account: string, key: Uint8Array): void {
  forgetLogin();
  loginAccount = account;
  loginKey = key.slice();
}

function forgetLogin(): void {
  wipe(loginKey);
  loginKey = null;
  loginAccount = null;
}

/** Called by the API client when a request finds the session expired. */
async function renewSession(): Promise<boolean> {
  if (!store.isUnlocked() || !loginAccount) return false;
  if (loginKey) {
    try {
      const session = await api.login(loginAccount, loginKey);
      setSession(session.token);
      store.adoptHeader(session.header);
      return true;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) return false; // offline: try again later
      wipe(loginKey); // the password was changed elsewhere
      loginKey = null;
    }
  }
  return askToLogInAgain();
}

let relogin: ((ok: boolean) => void) | null = null;

/** Asks for the password without logging out, so nothing in memory (unsaved edits included) is lost. */
function askToLogInAgain(): Promise<boolean> {
  const unsaved = store.unsavedCount();
  $('relogin-account').textContent = loginAccount ?? '';
  $input('relogin-username').value = loginAccount ?? '';
  $input('relogin-password').value = '';
  $('relogin-unsaved').textContent = unsaved
    ? `${unsaved} change${unsaved === 1 ? '' : 's'} not saved yet will be saved once you log in. Logging out discards ${unsaved === 1 ? 'it' : 'them'}.`
    : 'Everything is saved.';
  $('relogin-modal').querySelector('.form-error')?.classList.add('hidden');
  $('relogin-modal').classList.remove('hidden');
  requestAnimationFrame(() => $input('relogin-password').focus());
  return new Promise(resolve => { relogin = resolve; });
}

function finishRelogin(ok: boolean): void {
  $('relogin-modal').classList.add('hidden');
  $input('relogin-password').value = '';
  const resolve = relogin;
  relogin = null;
  resolve?.(ok);
}

function wireReloginDialog(): void {
  $('relogin-logout').onclick = () => finishRelogin(false);
  onSubmit('relogin-form', form => {
    const account = loginAccount;
    const password = $input('relogin-password').value;
    if (!account) { finishRelogin(false); return; }
    if (!password) { setError(form, 'Enter your password.'); return; }
    void busy(form, async () => {
      const kdf = await api.prelogin(account);
      const kek = deriveKek(password, kdf);
      const key = authKeyFromKek(kek);
      try {
        const session = await api.login(account, key);
        // The account's header carries the new password slot; it must belong to this vault.
        if (!store.adoptAccountHeader(session.header)) throw new Error('This account now holds a different vault. Log out and log in again.');
        setSession(session.token);
        keepLogin(account, key);
      } finally {
        wipe(kek);
        wipe(key);
      }
      finishRelogin(true);
      toast('Logged in again. Your changes are being saved.');
    });
  });
}

let locking = false;

/** Logs out: saves what it can, wipes the key and decrypted notes, ends the server session. */
export async function lockApp(opts: { broadcast?: boolean; reason?: string; skipSave?: boolean } = {}): Promise<void> {
  if (!store.isUnlocked() || locking) return;
  locking = true;
  try {
    if (opts.broadcast) store.broadcastLock();
    closeAllPopouts();
    clearClipboardNow();
    if (!opts.skipSave) {
      await store.flush();
      if (store.unsavedCount()) await sync.syncNow();
    }
    const lost = store.unsavedCount();
    await store.lock();
    forgetLogin();
    if (relogin) finishRelogin(false);
    sync.stopSync();
    await api.logout();
    setSession(null);
    clearAppDom();
    await showLockScreen();
    if (opts.reason) toast(opts.reason, 'info', 6000);
    if (lost) toast(`${lost} change(s) could not be saved because the server was unreachable.`, 'error', 9000);
  } finally {
    locking = false;
  }
}


/** Asks first when there are changes the server has not received yet. */
async function confirmLogout(): Promise<void> {
  await store.flush();
  if (store.unsavedCount()) await sync.syncNow();
  const unsaved = store.unsavedCount();
  if (unsaved && !(await confirmDialog({
    title: 'Log out with unsaved changes?',
    message: `${unsaved} change(s) have not reached the server yet (you seem to be offline). Logging out now discards them.`,
    confirmLabel: 'Log out anyway',
  }))) return;
  await lockApp({ broadcast: true });
}

export function welcomeNotes(): Note[] {
  const where = DESKTOP
    ? 'Everything in this vault file is encrypted with your password. You can copy the file anywhere, or link it to an online account in ⚙ Settings to sync.'
    : 'Everything in your account is encrypted in this browser with your password before it is saved online.';
  return [{
    id: uid(), parentId: null, title: 'Welcome to Cherrion', category: 'note', collapsed: false,
    isSticky: true, stickyColor: 'yellow', updatedAt: now(), deleted: false,
    blocks: [
      textBlock('h2', 'Encrypted notes, templates and sticky notes'),
      textBlock('callout', `${where} Press ＋ to start a page from a template: Email account, Website login, Secure note or Meeting.`),
      textBlock('todo', 'Create an Email account page from the ＋ template picker'),
      textBlock('todo', 'Type "/" in an empty block for headings, to-dos, field groups, secret fields and 2FA codes'),
      textBlock('todo', 'Keep your recovery key somewhere safe (⚙ Settings can make a new one)'),
    ],
  }];
}

/** Encrypts notes left by the pre-encryption version into the account, then deletes the plaintext copy. */
async function migrateLegacyPlaintext(): Promise<void> {
  const legacy = readLegacyLocalNotes();
  if (!legacy.length) return;
  await store.importPlainNotes(stampForMigration(legacy));
  clearLegacyLocalNotes();
}

export function onSubmit(id: string, handler: (form: HTMLFormElement) => void): void {
  const form = $(id) as HTMLFormElement;
  form.addEventListener('submit', e => { e.preventDefault(); handler(form); });
}

async function readBackupFile(): Promise<LocalVault> {
  const file = $input('signup-file').files?.[0];
  if (!file) throw new Error('Choose the backup file first.');
  let data: unknown;
  try { data = JSON.parse(await file.text()); } catch { throw new Error('That file is not a Cherrion backup.'); }
  if (!store.isBackup(data)) throw new Error('That is not an encrypted Cherrion backup file.');
  return { header: data.header, notes: data.notes };
}

const friendly = (err: unknown): never => {
  if (err instanceof WrongSecretError) throw new Error(err.message === 'Wrong password.' ? 'Wrong password for that vault.' : err.message);
  throw err;
};

/** The "save your recovery key" panel; `label` names the account or file in the saved text. */
export function wireRecoveryPanel(label: () => string): void {
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
      `Cherrion recovery key\n${label()}\nCreated ${new Date().toLocaleString()}\n\n${key}\n\nAnyone with this key can reset your password. Keep it offline.\n`,
      'text/plain');
  };
}

export function wireLockScreen(): void {
  $('link-signup').onclick = () => void showSignup();
  $('link-login').onclick = () => showPanel('login');
  $('link-recover').onclick = () => {
    $input('recover-username').value = $input('login-username').value;
    showPanel('recover');
  };
  $('link-login-from-recover').onclick = () => showPanel('login');
  $('signup-source').addEventListener('change', updateSignupSource);

  onSubmit('panel-login', form => {
    const account = username(form, 'login-username');
    const password = $input('login-password').value;
    if (!account) return;
    if (!password) { setError(form, 'Enter your password.'); return; }
    void busy(form, async () => {
      const kdf = await api.prelogin(account);
      const kek = deriveKek(password, kdf);
      try {
        const authKey = authKeyFromKek(kek);
        let session: { token: string; header: VaultHeader };
        try {
          session = await api.login(account, authKey);
          keepLogin(account, authKey);
        } finally {
          wipe(authKey);
        }
        const vaultKey = unlockWithKek(session.header, kek);
        await startSession(account, session.token, session.header, vaultKey);
      } finally {
        wipe(kek);
      }
      enterApp();
    });
  });

  onSubmit('panel-signup', form => {
    const account = username(form, 'signup-username');
    const password = $input('signup-password').value;
    const source = signupSource();
    if (!account) return;
    if (source === 'new' && !checkNewPassword(form, password, $input('signup-confirm').value)) return;
    if (source !== 'new' && !password) { setError(form, 'Enter the password of that vault.'); return; }
    void busy(form, async () => {
      let header: VaultHeader;
      let vaultKey: Uint8Array;
      let recoveryKey: string;
      let authKey: Uint8Array;
      let recoveryAuth: Uint8Array;
      let notes: Envelope[] = [];

      if (source === 'new') {
        const v = createVault(password, DEFAULT_KDF_COST, { userName: account });
        ({ header, vaultKey, recoveryKey, authKey } = v);
        recoveryAuth = v.recoveryAuthKey;
      } else {
        const from = source === 'local' ? localVault : await readBackupFile();
        if (!from) throw new Error('No vault was found in this browser.');
        const kek = deriveKek(password, from.header.kdf);
        try {
          try { vaultKey = unlockWithKek(from.header, kek); } catch (err) { friendly(err); throw err; }
          authKey = authKeyFromKek(kek);
        } finally {
          wipe(kek);
        }
        // We never had the old recovery key, so the account gets a fresh one.
        const rotated = rotateRecoveryKey(from.header, vaultKey);
        header = readProfile(rotated.header, vaultKey) ? rotated.header : setProfile(rotated.header, vaultKey, { userName: account });
        recoveryKey = rotated.recoveryKey;
        recoveryAuth = rotated.recoveryAuthKey;
        notes = from.notes;
      }

      let session: { token: string; header: VaultHeader };
      try {
        session = await api.signup({ username: account, header, authKey, recoveryAuthKey: recoveryAuth, notes });
        keepLogin(account, authKey);
      } finally {
        wipe(authKey); wipe(recoveryAuth);
      }
      settings.userName = readProfile(header, vaultKey)?.userName ?? account;
      await startSession(account, session.token, header, vaultKey, notes);
      await migrateLegacyPlaintext();
      if (!store.activeNotes().length) welcomeNotes().forEach(n => store.addNote(n));
      await store.flush();
      await sync.syncNow();
      // Only remove the browser copy once it is safely in a real database.
      if (source === 'local' && persistentServer) await deleteLocalVault();
      $('recovery-key-text').textContent = recoveryKey;
      showPanel('recovery');
    });
  });

  wireRecoveryPanel(() => `Account: ${settings.accountName}`);

  onSubmit('panel-recover', form => {
    const account = username(form, 'recover-username');
    const recoveryText = $input('recover-key').value;
    const password = $input('recover-password').value;
    if (!account) return;
    if (!checkNewPassword(form, password, $input('recover-confirm').value)) return;
    void busy(form, async () => {
      const rAuth = recoveryAuthKey(recoveryText);
      try {
        const header = await api.recoverStart(account, rAuth);
        const vaultKey = unlockWithRecoveryKey(header, recoveryText);
        const next = rewrapPasswordWithAuth(header, vaultKey, password);
        try {
          const session = await api.recoverFinish(account, rAuth, next.header, next.authKey);
          keepLogin(account, next.authKey);
          await startSession(account, session.token, next.header, vaultKey);
        } finally {
          wipe(next.authKey);
        }
      } finally {
        wipe(rAuth);
      }
      enterApp();
      toast('Password reset. Your recovery key still works; ⚙ Settings can make a new one.', 'info', 7000);
    });
  });

  $('btn-lock').onclick = () => void confirmLogout();
  shell.lock = () => void confirmLogout();
  store.onLockRequest(() => void lockApp());
  // Only reached when the session could not be renewed and the person chose to log out.
  sync.onSessionExpired(message => void lockApp({ skipSave: true, reason: message }));
  setReauthenticator(renewSession);
  store.onAuthKeyChange(key => { if (loginAccount) keepLogin(loginAccount, key); });
  wireReloginDialog();

  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
    window.addEventListener(type, markActivity, { capture: true, passive: true });
  }
  setInterval(() => {
    const minutes = settings.autoLockMinutes;
    if (!store.isUnlocked() || minutes <= 0 || idleFor() <= minutes * 60_000) return;
    // Never discard edits the server has not received: wait until they are saved.
    if (store.unsavedCount()) { void sync.syncNow(); return; }
    void lockApp().then(() => toast('Logged out after inactivity.'));
  }, 15_000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && store.isUnlocked()) {
      void store.flush().then(() => sync.syncNow()).catch(err => console.error(err));
    }
  });
  window.addEventListener('beforeunload', e => {
    if (store.isUnlocked() && store.unsavedCount()) { e.preventDefault(); void sync.syncNow(); }
  });
}
