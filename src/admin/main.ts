// The owner's admin dashboard (/admin/): recovery requests, the users list and 30 days of connection
// history. First visit (no CHERRION_ADMIN yet): a setup page that makes the admin keys in this browser.
//
// The admin password never leaves the browser (only a one-way auth key does), the owner's private key
// is only unwrapped here, and users' vault keys are only unsealed here, for users who opted in.
import '../styles.css';
import './admin.css';
import { initCrypto, wipe, type BoxKeyPair, type KdfParams, type Sealed } from '../crypto';
import { settings } from '../settings';
import { parseTotp, totpCode } from '../totp';
import { confirmDialog, wireDialog } from '../ui/dialog';
import { $, el, ICONS, nextPaint, setWorking, svgIcon, toast, type IconName } from '../ui/dom';
import { passwordProblem, type VaultHeader } from '../vault';
import { describeDevice, describePlace } from './device';
import { adminKeysFromPassword, createAdminSetup, openAdminKey, ownerKeyCode, recoveryFromEscrow } from './keys';

// ---- Server ----

class AdminError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

let token: string | null = null;

async function call(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch('/api/admin', {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AdminError('Cannot reach the server. Check your connection.', 0);
  }
  let data: Record<string, unknown> = {};
  try { data = (await res.json()) as Record<string, unknown>; } catch { /* not JSON */ }
  if (!res.ok) {
    const message = typeof data.error === 'string' ? data.error : `Server error (${res.status}).`;
    if (res.status === 401 && token && body.action !== 'login') endSession('Your admin session ended. Log in again.');
    throw new AdminError(message, res.status);
  }
  return data;
}

// ---- Data ----

type EventKind = 'signup' | 'login' | 'login_failed' | 'recover' | 'reset' | 'reset_failed' | 'recovery_request'
  | 'escrow_on' | 'escrow_off' | 'admin_login' | 'admin_login_failed' | 'admin_recovery_key' | 'admin_reset_code';
interface Place { ip: string; userAgent: string; country: string; region: string; city: string }
interface EventRow extends Place { id: string; at: number; kind: EventKind; accountId: string | null; username: string | null }
interface UserRow {
  id: string; username: string; createdAt: number; notes: number; workspaces: number;
  lastSeenAt: number | null; lastIp: string | null; lastUserAgent: string | null;
  lastCountry: string | null; lastRegion: string | null; lastCity: string | null; escrowKey: string | null;
}
interface RequestRow extends Place {
  id: string; at: number; username: string; accountId: string | null; contact: string; message: string; status: 'open' | 'done' | 'dismissed';
}
interface Overview { users: UserRow[]; requests: RequestRow[]; events: EventRow[]; adminKey: string; historyDays: number }

const EVENTS: Record<EventKind, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' }> = {
  signup: { label: 'Created account', tone: 'ok' },
  login: { label: 'Logged in', tone: 'ok' },
  login_failed: { label: 'Failed login', tone: 'warn' },
  recover: { label: 'Reset password (recovery key)', tone: 'info' },
  reset: { label: 'Started again (reset code)', tone: 'warn' },
  reset_failed: { label: 'Wrong reset code', tone: 'bad' },
  recovery_request: { label: 'Asked for help', tone: 'info' },
  escrow_on: { label: 'Turned on owner recovery', tone: 'info' },
  escrow_off: { label: 'Turned off owner recovery', tone: 'info' },
  admin_login: { label: 'Admin logged in', tone: 'info' },
  admin_login_failed: { label: 'Failed admin login', tone: 'bad' },
  admin_recovery_key: { label: 'Admin made a recovery key', tone: 'warn' },
  admin_reset_code: { label: 'Admin made a reset code', tone: 'warn' },
};

let owner: BoxKeyPair | null = null;
let ownerKey = '';
let expiresAt = 0;
let data: Overview | null = null;
let tab: 'requests' | 'users' | 'activity' = 'requests';
let filter = '';

// ---- Helpers ----

const root = () => $('admin-root');
const fmtDate = (ms: number) => new Date(ms).toLocaleString();
function ago(ms: number | null): string {
  if (!ms) return 'Never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 30 * 86_400) return `${Math.round(s / 86_400)} days ago`;
  return new Date(ms).toLocaleDateString();
}
const placeOf = (p: { city?: string | null; region?: string | null; country?: string | null }) => describePlace(p);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function iconButton(className: string, icon: IconName, label: string, onclick: () => void, title?: string): HTMLButtonElement {
  return el('button', { type: 'button', className, title: title ?? label, onclick }, svgIcon(ICONS[icon]), label);
}

function errorLine(): HTMLElement {
  const line = el('p', { className: 'form-error hidden' });
  line.setAttribute('role', 'alert');
  return line;
}
function showError(line: HTMLElement, err: unknown): void {
  line.textContent = message(err);
  line.classList.remove('hidden');
}

async function working(button: HTMLButtonElement, line: HTMLElement | null, work: () => Promise<void>, text = 'Working…'): Promise<void> {
  line?.classList.add('hidden');
  const restore = setWorking(button, text);
  button.disabled = true;
  try {
    await nextPaint();
    await work();
  } catch (err) {
    if (line) showError(line, err); else toast(message(err), 'error', 7000);
  } finally {
    button.disabled = false;
    restore();
  }
}

function copy(text: string, what: string): void {
  navigator.clipboard.writeText(text).then(() => toast(`${what} copied.`), () => toast('Copy failed: select the text and copy it.', 'error'));
}

function field(label: string, input: HTMLInputElement | HTMLTextAreaElement): HTMLLabelElement {
  return el('label', { className: 'field-label' }, label, input);
}

function card(...children: Node[]): HTMLElement {
  return el('div', { className: 'lock-screen admin-gate' }, el('div', { className: 'lock-card' }, el('div', { className: 'lock-brand', text: '🍒 Cherrion admin' }), ...children));
}

// ---- Modal ----

function openModal(title: string, ...content: Node[]): void {
  $('admin-modal-title').textContent = title;
  $('admin-modal-body').replaceChildren(...content);
  $('admin-modal').classList.remove('hidden');
}
function closeModal(): void {
  $('admin-modal').classList.add('hidden');
  $('admin-modal-body').replaceChildren(); // recovery keys and codes must not stay in the page
  $('admin-modal-title').textContent = '';
}

// ---- Setup (CHERRION_ADMIN not set yet) ----

function showSetup(): void {
  const password = el('input', { type: 'password', autocomplete: 'new-password' });
  const confirm = el('input', { type: 'password', autocomplete: 'new-password' });
  const line = errorLine();
  const make = iconButton('primary-btn wide', 'key', 'Create admin keys', () => {});
  make.type = 'submit';
  const form = el('form', { noValidate: true },
    el('h2', { text: 'Set up the admin dashboard' }),
    el('p', { className: 'muted', text: 'This server has no admin yet. Choose an admin password: it protects this dashboard and the owner key that opted-in users can be recovered with. It never leaves this browser.' }),
    field('Admin password', password), field('Confirm admin password', confirm), line, make,
  );
  form.onsubmit = e => {
    e.preventDefault();
    const problem = passwordProblem(password.value);
    if (problem) { showError(line, new Error(problem)); return; }
    if (password.value !== confirm.value) { showError(line, new Error('The passwords do not match.')); return; }
    void working(make, line, async () => {
      const setup = await createAdminSetup(password.value);
      password.value = confirm.value = '';
      showSetupTotp(setup);
    }, 'Creating keys…');
  };
  root().replaceChildren(card(form));
  password.focus();
}

function showSetupTotp(setup: Awaited<ReturnType<typeof createAdminSetup>>): void {
  const code = el('input', { type: 'text', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 7, placeholder: '123456' });
  const line = errorLine();
  const check = iconButton('primary-btn wide', 'check', 'Check code', () => {});
  check.type = 'submit';
  const secret = setup.totpSecret.match(/.{1,4}/g)!.join(' ');
  const form = el('form', { noValidate: true },
    el('h2', { text: 'Add the 2FA code to your authenticator' }),
    el('p', { className: 'muted', text: 'In Google Authenticator, Microsoft Authenticator, 1Password or similar, add an account by entering this setup key (time-based):' }),
    el('code', { className: 'recovery-key', text: secret }),
    el('div', { className: 'row' },
      iconButton('action-btn', 'copy', 'Copy key', () => copy(setup.totpSecret, 'Setup key')),
      iconButton('action-btn', 'link', 'Copy otpauth link', () => copy(setup.otpauthUri, 'Link'))),
    field('Then enter the 6-digit code it shows', code), line, check,
  );
  form.onsubmit = e => {
    e.preventDefault();
    void working(check, line, async () => {
      const params = parseTotp(setup.totpSecret)!;
      const typed = code.value.replace(/\s/g, '');
      const now = Date.now();
      const valid = await Promise.all([-30_000, 0, 30_000].map(d => totpCode(params, now + d)));
      if (!valid.includes(typed)) throw new Error('That code does not match. Check the key was entered exactly, and that the device clock is right.');
      showSetupDone(setup.envValue, setup.config.publicKey);
    });
  };
  root().replaceChildren(card(form));
  code.focus();
}

function showSetupDone(envValue: string, publicKey: string): void {
  const value = el('textarea', { className: 'admin-env', readOnly: true, rows: 5, value: envValue, spellcheck: false });
  value.onfocus = () => value.select();
  root().replaceChildren(card(
    el('h2', { text: 'Last step: save it on the server' }),
    el('ol', { className: 'admin-steps' },
      el('li', {}, 'In Vercel, open the project → ', el('strong', { text: 'Settings → Environment Variables' }), '.'),
      el('li', {}, 'Add ', el('code', { text: 'CHERRION_ADMIN' }), ' with the value below (Production; Preview too if you use it).'),
      el('li', {}, el('strong', { text: 'Redeploy' }), ', then open this page again and log in with the admin password and a 2FA code.'),
    ),
    value,
    el('div', { className: 'row' }, iconButton('primary-btn', 'copy', 'Copy value', () => copy(envValue, 'Value'))),
    el('p', { className: 'muted small' }, 'For local development, put ', el('code', { text: 'CHERRION_ADMIN=<value>' }), ' in ', el('code', { text: '.env.local' }), ' and restart the dev server.'),
    el('p', { className: 'notice small', text: `Owner key: ${ownerKeyCode(publicKey)}. Users who turn on owner recovery see this code in Settings.` }),
    el('p', { className: 'notice warn small', text: 'The value holds the 2FA secret and the owner key (encrypted with your admin password): treat it like a password. If you lose the admin password, set up again: users who opted in move to the new owner key the next time they log in.' }),
  ));
}

// ---- Login ----

function showLogin(kdf: KdfParams, notice?: string): void {
  const password = el('input', { type: 'password', autocomplete: 'current-password' });
  const code = el('input', { type: 'text', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 7, placeholder: '123456' });
  const line = errorLine();
  const login = iconButton('primary-btn wide', 'lock', 'Log in', () => {});
  login.type = 'submit';
  const form = el('form', { noValidate: true },
    el('h2', { text: 'Owner login' }),
    ...(notice ? [el('p', { className: 'notice', text: notice })] : []),
    field('Admin password', password), field('2FA code', code), line, login,
  );
  form.onsubmit = e => {
    e.preventDefault();
    if (!password.value || !/^\d{6}$/.test(code.value.replace(/\s/g, ''))) { showError(line, new Error('Enter the admin password and the 6-digit code.')); return; }
    void working(login, line, async () => {
      const { authKey, wrapKey } = adminKeysFromPassword(password.value, kdf);
      try {
        const res = await call({ action: 'login', authKey, code: code.value.replace(/\s/g, '') });
        token = String(res.token);
        expiresAt = Number(res.expiresAt);
        ownerKey = String(res.publicKey);
        owner = openAdminKey(wrapKey, ownerKey, res.privateKey as Sealed);
      } finally {
        wipe(wrapKey);
      }
      password.value = code.value = '';
      await load();
    }, 'Checking…');
  };
  root().replaceChildren(card(form));
  password.focus();
}

function endSession(notice?: string): void {
  token = null;
  if (owner) wipe(owner.privateKey);
  owner = null;
  data = null;
  closeModal();
  void boot(notice);
}

// ---- Dashboard ----

async function load(): Promise<void> {
  data = (await call({ action: 'overview' })) as unknown as Overview;
  render();
}

function render(): void {
  if (!data) return;
  const open = data.requests.filter(r => r.status === 'open').length;
  const tabs = el('nav', { className: 'admin-tabs' },
    ...([['requests', `Requests${open ? ` (${open} open)` : ''}`], ['users', `Users (${data.users.length})`], ['activity', `Activity (${data.historyDays} days)`]] as const)
      .map(([id, label]) => el('button', { type: 'button', className: `tab-btn${tab === id ? ' active' : ''}`, text: label, onclick: () => { tab = id; render(); } })),
  );
  const search = el('input', { type: 'search', className: 'admin-search', placeholder: 'Filter by user, IP, place or device…', value: filter });
  search.oninput = () => { filter = search.value; renderBody(body); };
  const body = el('section', { className: 'admin-body' });
  const minutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60_000));
  root().replaceChildren(
    el('header', { className: 'admin-top' },
      el('span', { className: 'brand', text: '🍒 Cherrion admin' }),
      el('span', { className: 'muted small admin-key', text: `Owner key ${ownerKeyCode(ownerKey)}`, title: 'Users who turn on owner recovery see this code in Settings.' }),
      el('span', { className: 'admin-grow' }),
      el('span', { id: 'admin-countdown', className: 'muted small', text: `Session ends in ${minutes} min` }),
      iconButton('action-btn', 'refresh', 'Refresh', () => void load().catch(err => toast(message(err), 'error'))),
      iconButton('action-btn', 'lock', 'Log out', () => { void call({ action: 'logout' }).catch(() => {}); endSession(); })),
    el('div', { className: 'admin-main' }, tabs, search, body),
  );
  renderBody(body);
}

const matches = (...values: (string | null | undefined)[]) => {
  const q = filter.trim().toLowerCase();
  return !q || values.some(v => v?.toLowerCase().includes(q));
};

function renderBody(body: HTMLElement): void {
  if (!data) return;
  if (tab === 'requests') body.replaceChildren(...requestsView(data));
  else if (tab === 'users') body.replaceChildren(usersView(data));
  else body.replaceChildren(eventsTable(data.events.filter(e => matches(e.username, e.ip, placeOf(e), describeDevice(e.userAgent), EVENTS[e.kind]?.label)), true));
}

const userById = (id: string | null) => (id ? data?.users.find(u => u.id === id) ?? null : null);
const escrowState = (u: UserRow): 'current' | 'old' | 'off' => (!u.escrowKey ? 'off' : u.escrowKey === ownerKey ? 'current' : 'old');

function where(p: Place): string {
  return `${describeDevice(p.userAgent)} · ${placeOf(p)} · ${p.ip}`;
}

function requestsView(d: Overview): Node[] {
  const list = d.requests.filter(r => matches(r.username, r.contact, r.message, r.ip, placeOf(r)));
  if (!list.length) return [el('p', { className: 'muted admin-empty', text: d.requests.length ? 'No requests match the filter.' : 'No recovery requests yet. People ask from the login page: “Use your recovery key” → “Ask the owner for help”.' })];
  // Open requests first, newest first within each group.
  list.sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.at - a.at);
  return list.map(r => {
    const user = userById(r.accountId);
    const actions = el('div', { className: 'modal-actions' });
    if (r.status === 'open') {
      if (user && escrowState(user) === 'current') actions.append(iconButton('primary-btn', 'key', 'New recovery key', () => void newRecoveryKey(user, r.id), 'Their notes are kept'));
      if (user) actions.append(iconButton('action-btn', 'refresh', 'Reset code', () => void newResetCode(user, r.id), 'They start again with an empty account'));
      actions.append(iconButton('action-btn', 'check', 'Mark done', () => void resolve(r.id, 'done')), iconButton('action-btn', 'trash', 'Dismiss', () => void resolve(r.id, 'dismissed')));
    } else {
      actions.append(iconButton('action-btn', 'refresh', 'Reopen', () => void resolve(r.id, 'open')));
    }
    const escrowNote = !user ? 'No account has this username.'
      : escrowState(user) === 'current' ? 'Owner recovery is on: a new recovery key keeps their notes.'
        : escrowState(user) === 'old' ? 'Owner recovery is on, but for an older owner key (it updates when they next log in). Until then, only a reset code works.'
          : 'Owner recovery is off: only a reset code is possible (their notes cannot be restored).';
    return el('article', { className: `admin-card status-${r.status}` },
      el('div', { className: 'admin-card-head' },
        el('strong', { text: r.username }),
        el('span', { className: `chip chip-${r.status === 'open' ? 'warn' : r.status === 'done' ? 'ok' : 'info'}`, text: r.status }),
        el('span', { className: 'admin-grow' }),
        el('span', { className: 'muted small', text: fmtDate(r.at), title: ago(r.at) })),
      el('p', {}, el('span', { className: 'muted', text: 'Contact: ' }), el('span', { className: 'admin-select', text: r.contact })),
      ...(r.message ? [el('p', { className: 'admin-message', text: r.message })] : []),
      el('p', { className: 'muted small', text: `Sent from ${where(r)}` }),
      el('p', { className: `small ${user && escrowState(user) === 'current' ? 'ok-text' : 'muted'}`, text: escrowNote }),
      ...(user ? [el('p', { className: 'small' }, el('button', { type: 'button', className: 'link-btn admin-link', text: `Last seen ${ago(user.lastSeenAt).toLowerCase()}${user.lastIp ? ` from ${placeOf({ city: user.lastCity, region: user.lastRegion, country: user.lastCountry })}` : ''}: see ${user.username}’s history`, onclick: () => void openUser(user) }))] : []),
      actions,
    );
  });
}

function usersView(d: Overview): HTMLElement {
  const rows = d.users.filter(u => matches(u.username, u.lastIp, placeOf({ city: u.lastCity, region: u.lastRegion, country: u.lastCountry }), describeDevice(u.lastUserAgent)));
  if (!rows.length) return el('p', { className: 'muted admin-empty', text: d.users.length ? 'No users match the filter.' : 'No accounts yet.' });
  const table = el('table', { className: 'admin-table' },
    el('thead', {}, el('tr', {}, ...['User', 'Joined', 'Last seen', 'Where', 'Device', 'Pages', 'Workspaces', 'Owner recovery'].map(h => el('th', { text: h })))),
    el('tbody', {}, ...rows.map(u => {
      const state = escrowState(u);
      const tr = el('tr', { className: 'admin-row', tabIndex: 0 },
        el('td', {}, el('strong', { text: u.username })),
        el('td', { text: new Date(u.createdAt).toLocaleDateString(), title: fmtDate(u.createdAt) }),
        el('td', { text: ago(u.lastSeenAt), title: u.lastSeenAt ? fmtDate(u.lastSeenAt) : '' }),
        el('td', { text: u.lastIp ? `${placeOf({ city: u.lastCity, region: u.lastRegion, country: u.lastCountry })} · ${u.lastIp}` : '—' }),
        el('td', { text: u.lastUserAgent ? describeDevice(u.lastUserAgent) : '—', title: u.lastUserAgent ?? '' }),
        el('td', { className: 'num', text: String(u.notes) }),
        el('td', { className: 'num', text: String(u.workspaces) }),
        el('td', {}, el('span', { className: `chip chip-${state === 'current' ? 'ok' : state === 'old' ? 'warn' : 'info'}`, text: state === 'current' ? 'On' : state === 'old' ? 'Old key' : 'Off' })),
      );
      tr.onclick = () => void openUser(u);
      tr.onkeydown = e => { if (e.key === 'Enter') void openUser(u); };
      return tr;
    })),
  );
  return el('div', { className: 'admin-scroll' }, table);
}

function eventsTable(events: EventRow[], withUser: boolean): HTMLElement {
  if (!events.length) return el('p', { className: 'muted admin-empty', text: 'No activity in this period.' });
  return el('div', { className: 'admin-scroll' }, el('table', { className: 'admin-table' },
    el('thead', {}, el('tr', {}, ...['When', 'Event', ...(withUser ? ['User'] : []), 'Device', 'Where', 'IP'].map(h => el('th', { text: h })))),
    el('tbody', {}, ...events.map(e => {
      const info = EVENTS[e.kind] ?? { label: e.kind, tone: 'info' as const };
      return el('tr', {},
        el('td', { text: fmtDate(e.at), title: ago(e.at) }),
        el('td', {}, el('span', { className: `chip chip-${info.tone}`, text: info.label })),
        ...(withUser ? [el('td', { text: e.username ?? (e.kind.startsWith('admin') ? 'admin' : '—') })] : []),
        el('td', { text: describeDevice(e.userAgent), title: e.userAgent }),
        el('td', { text: placeOf(e) }),
        el('td', { className: 'admin-select', text: e.ip }),
      );
    })),
  ));
}

async function openUser(u: UserRow): Promise<void> {
  const state = escrowState(u);
  const history = el('div', {}, el('p', { className: 'muted', text: 'Loading history…' }));
  const actions = el('div', { className: 'modal-actions' });
  if (state === 'current') actions.append(iconButton('primary-btn', 'key', 'New recovery key', () => void newRecoveryKey(u)));
  actions.append(iconButton('action-btn', 'refresh', 'Reset code', () => void newResetCode(u)));
  openModal(u.username,
    el('dl', { className: 'admin-facts' },
      ...([
        ['Joined', fmtDate(u.createdAt)],
        ['Last seen', u.lastSeenAt ? `${ago(u.lastSeenAt)} (${fmtDate(u.lastSeenAt)})` : 'Never'],
        ['Where', u.lastIp ? `${placeOf({ city: u.lastCity, region: u.lastRegion, country: u.lastCountry })} · ${u.lastIp}` : '—'],
        ['Device', u.lastUserAgent ? describeDevice(u.lastUserAgent) : '—'],
        ['Pages', String(u.notes)],
        ['Workspaces', String(u.workspaces)],
        ['Owner recovery', state === 'current' ? 'On: a new recovery key keeps their notes' : state === 'old' ? 'On, for an older owner key (updates when they next log in)' : 'Off: only a reset code is possible'],
      ] as const).flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])),
    actions,
    el('h4', { className: 'section-title', text: `Connection history (${data?.historyDays ?? 30} days)` }),
    history,
  );
  try {
    const res = await call({ action: 'events', accountId: u.id });
    history.replaceChildren(eventsTable(res.events as EventRow[], false));
  } catch (err) {
    history.replaceChildren(el('p', { className: 'form-error', text: message(err) }));
  }
}

// ---- Actions ----

async function resolve(requestId: string, status: 'open' | 'done' | 'dismissed'): Promise<void> {
  try { await call({ action: 'resolve', requestId, status }); await load(); } catch (err) { toast(message(err), 'error'); }
}

async function newRecoveryKey(u: UserRow, requestId?: string): Promise<void> {
  const ok = await confirmDialog({
    title: `New recovery key for ${u.username}?`,
    message: `Only after checking it is really ${u.username} (for example, call them on a number you already know). Whoever gets this key can set a new password and read the account. Their old recovery key stops working; their notes are kept.`,
    confirmLabel: 'Create recovery key',
    danger: false,
  });
  if (!ok || !owner) return;
  try {
    const e = await call({ action: 'escrow', accountId: u.id });
    const escrow = e.escrow as { sealed: string } | null;
    if (!escrow) throw new Error(`${u.username} has not turned on owner recovery. Use a reset code instead.`);
    const fresh = recoveryFromEscrow(e.header as VaultHeader, escrow.sealed, owner);
    await call({ action: 'setRecovery', accountId: u.id, header: fresh.header, recoveryAuthKey: fresh.recoveryAuthKey, ...(requestId ? { requestId } : {}) });
    showSecret(`New recovery key for ${u.username}`, fresh.recoveryKey,
      `Hello ${u.username}, here is your new Cherrion recovery key:\n\n${fresh.recoveryKey}\n\nOn the login page choose “Forgot your password? Use your recovery key”, enter your username, this key and a new password. Your notes are all there. Afterwards, keep the key somewhere safe (Settings can make a new one).`);
    await load();
  } catch (err) {
    toast(message(err), 'error', 9000);
  }
}

async function newResetCode(u: UserRow, requestId?: string): Promise<void> {
  const ok = await confirmDialog({
    title: `Reset code for ${u.username}?`,
    message: `Only after checking it is really ${u.username}. With this code, ${u.username} can delete everything in the account and start again with an empty vault (same username). Their notes cannot be restored. The code works once, for 7 days.`,
    confirmLabel: 'Create reset code',
  });
  if (!ok) return;
  try {
    const res = await call({ action: 'resetCode', accountId: u.id, ...(requestId ? { requestId } : {}) });
    const code = String(res.code);
    const until = new Date(Number(res.expiresAt)).toLocaleDateString();
    showSecret(`Reset code for ${u.username}`, code,
      `Hello ${u.username}, here is your Cherrion reset code (it works once, until ${until}):\n\n${code}\n\nOn the login page choose “Forgot your password? Use your recovery key”, then “I have a reset code from the owner”. Your old notes cannot be restored: you start with an empty account and get a new recovery key. Shared workspaces have to invite you again.`);
    await load();
  } catch (err) {
    toast(message(err), 'error', 9000);
  }
}

function showSecret(title: string, secret: string, text: string): void {
  const note = el('textarea', { className: 'admin-env admin-note', readOnly: true, rows: 7, value: text });
  openModal(title,
    el('code', { className: 'recovery-key', text: secret }),
    el('div', { className: 'row' },
      iconButton('action-btn', 'copy', 'Copy', () => copy(secret, 'Code')),
      iconButton('action-btn', 'copy', 'Copy message', () => copy(text, 'Message'))),
    el('h4', { className: 'section-title', text: 'Message to send' }),
    note,
    el('p', { className: 'notice warn small', text: 'Send it privately (not in a group chat or by public email), and only to the person you checked. It is shown only now.' }),
    el('div', { className: 'modal-actions end' }, el('button', { type: 'button', className: 'primary-btn', text: 'Done', onclick: closeModal })),
  );
}

// ---- Start ----

async function boot(notice?: string): Promise<void> {
  try {
    const config = await call({ action: 'config' });
    if (config.configured === true) showLogin(config.kdf as KdfParams, notice);
    else showSetup();
  } catch (err) {
    root().replaceChildren(card(el('p', { className: 'form-error', text: `The admin dashboard could not start: ${message(err)}` })));
  }
}

document.body.classList.toggle('dark', settings.dark);
wireDialog();
$('admin-modal-close').onclick = closeModal;
$('admin-modal').addEventListener('mousedown', e => { if (e.target === e.currentTarget) closeModal(); });
$('admin-modal').addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
// Sessions last an hour; the header shows the time left, and the page logs out when it ends.
setInterval(() => {
  if (!token) return;
  if (Date.now() >= expiresAt) { endSession('Your admin session ended after an hour. Log in again.'); return; }
  const countdown = document.getElementById('admin-countdown');
  if (countdown) countdown.textContent = `Session ends in ${Math.max(0, Math.round((expiresAt - Date.now()) / 60_000))} min`;
}, 60_000);
await initCrypto();
await boot();
