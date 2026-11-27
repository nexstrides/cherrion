// Shared workspaces UI: the space switcher above the search box (Personal / workspaces / invitations),
// and one dialog for creating, joining, invitations, workspace settings and moving pages.
import { ApiError } from '../api';
import * as session from '../desktop/session';
import { DESKTOP } from '../platform';
import * as store from '../store';
import * as ws from '../workspaces';
import { countDescendants } from '../tree';
import { confirmDialog } from './dialog';
import { $, el, ICONS, setWorking, svgIcon, toast, type IconName } from './dom';
import { attachMenu, closeDropdowns, createDropdown, SEPARATOR, type DropdownOption } from './dropdown';
import { render, selectNote, shell, ui } from './state';

const message = (err: unknown): string => {
  if (err instanceof ApiError && err.status === 0) return 'Cannot reach the server. Check your connection and try again.';
  return err instanceof Error ? err.message : String(err);
};
const spaceName = (id: string): string => (id === store.PERSONAL ? 'Personal' : ws.getWorkspace(id)?.name ?? 'Workspace');
const ROLE_HINTS: Record<ws.Role, string> = {
  owner: 'Can change pages, invite and remove people, and delete the workspace',
  editor: 'Can add, change and delete pages',
  viewer: 'Can read pages but not change them',
};

/** Workspaces need an online account: never for an unlinked desktop file. */
const available = (): boolean => store.isUnlocked() && (!DESKTOP || !!session.linkedAccount());

/** True when the active space (or the note's space) can be changed. */
export const canEdit = (noteId?: string): boolean => !store.isReadOnly(noteId ? store.spaceOf(noteId) : store.getActiveSpace());

// ---- Switching spaces ----

/** The page last open in each space, so switching back returns to it. */
const lastNote = new Map<string, string>();
/** The space the UI shows (the store falls back to Personal by itself when a workspace goes away). */
let shown = store.PERSONAL;
/** Set while this person leaves or deletes a workspace themselves (no "no longer have access" note). */
let leaving = false;

export function switchSpace(id: string): void {
  if (ui.activeNoteId) lastNote.set(shown, ui.activeNoteId);
  store.setActiveSpace(id);
  shown = store.getActiveSpace();
  const remembered = store.getNote(lastNote.get(store.getActiveSpace()) ?? null);
  const pick = remembered && !remembered.deleted && store.spaceOf(remembered.id) === store.getActiveSpace()
    ? remembered.id : store.activeNotes()[0]?.id ?? null;
  selectNote(pick);
  ui.activeTab = 'tree';
  renderSwitcher();
  render.all();
}

export function renderSwitcher(): void {
  const host = $('space-switcher');
  if (!available()) { host.classList.add('hidden'); host.replaceChildren(); return; }
  host.classList.remove('hidden');
  const active = store.getActiveSpace();
  const workspace = ws.getWorkspace(active);
  const invites = ws.listInvitations().length;
  const button = el('button', { type: 'button', className: 'space-btn' },
    el('span', { className: 'space-icon' }, svgIcon(ICONS[active === store.PERSONAL ? 'user' : 'users'])),
    el('span', { className: 'space-meta' },
      el('span', { className: 'space-name', text: spaceName(active) }),
      el('span', { className: 'space-role', text: workspace ? `${ws.ROLE_LABELS[workspace.role]} · ${workspace.members.length} member${workspace.members.length === 1 ? '' : 's'}` : 'Only you' }),
    ),
    ...(invites ? [el('span', { className: 'space-badge', text: String(invites), title: `${invites} invitation${invites === 1 ? '' : 's'}` })] : []),
  );
  const caret = svgIcon(ICONS.chevron);
  caret.classList.add('dd-caret');
  button.append(caret);
  button.setAttribute('aria-label', `Space: ${spaceName(active)}${invites ? `, ${invites} invitation(s)` : ''}. Switch space`);
  attachMenu(button, { ariaLabel: 'Spaces', items: switcherItems, onSelect: onSwitcherSelect });
  host.replaceChildren(button);
}

function switcherItems(): DropdownOption[] {
  const active = store.getActiveSpace();
  const mark = (id: string) => (id === active ? '✓' : undefined);
  const items: DropdownOption[] = [
    { value: 'space:', label: 'Personal', svg: 'user', hint: mark(store.PERSONAL) ?? 'Only you' },
    ...ws.listWorkspaces().map(w => ({ value: `space:${w.id}`, label: w.name, svg: 'users' as IconName, hint: mark(w.id) ?? ws.ROLE_LABELS[w.role] })),
  ];
  const invites = ws.listInvitations();
  if (invites.length) {
    items.push(SEPARATOR, ...invites.map(i => ({ value: `invite:${i.id}`, label: `Invitation: ${i.name}`, svg: 'mail' as IconName, hint: i.from })));
  }
  items.push(SEPARATOR);
  if (active !== store.PERSONAL) items.push({ value: 'settings', label: 'Workspace settings…', svg: 'settings' });
  items.push(
    { value: 'new', label: 'New workspace…', svg: 'plus' },
    { value: 'join', label: 'Join with a link…', svg: 'link' },
  );
  return items;
}

function onSwitcherSelect(value: string): void {
  if (value.startsWith('space:')) { switchSpace(value.slice(6)); shell.closeNav(); }
  else if (value.startsWith('invite:')) {
    const invite = ws.listInvitations().find(i => i.id === value.slice(7));
    if (invite) showInvitation(invite);
  } else if (value === 'settings') showSettings(store.getActiveSpace());
  else if (value === 'new') showCreate();
  else if (value === 'join') showJoin();
}

// ---- The dialog ----

let view: { kind: string; id?: string } | null = null;
let returnFocus: HTMLElement | null = null;

function openModal(title: string, kind: string, id: string | undefined, ...content: Node[]): void {
  if (!view) returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  closeDropdowns();
  shell.closeNav();
  view = { kind, ...(id ? { id } : {}) };
  $('workspace-title').textContent = title;
  $('workspace-body').replaceChildren(...content);
  $('workspace-modal').classList.remove('hidden');
  requestAnimationFrame(() => $('workspace-body').querySelector<HTMLElement>('input:not([readonly]), button.primary-btn')?.focus());
}

/** Closes the dialog and removes its contents (names and invite links). Also used when locking. */
export function closeWorkspaceDialog(): void {
  if (!view) return;
  view = null;
  closeDropdowns();
  $('workspace-modal').classList.add('hidden');
  $('workspace-body').replaceChildren();
  $('workspace-title').textContent = '';
  if (returnFocus?.isConnected) returnFocus.focus();
  returnFocus = null;
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

/** Runs a dialog action with a busy button and an error line. */
async function act(button: HTMLButtonElement, line: HTMLElement, work: () => Promise<void>, busyText = 'Working…'): Promise<void> {
  line.classList.add('hidden');
  const restore = setWorking(button, busyText);
  button.disabled = true;
  try {
    await work();
  } catch (err) {
    showError(line, err);
  } finally {
    button.disabled = false;
    restore();
  }
}

function iconButton(className: string, icon: IconName, text: string, onclick: () => void, title?: string): HTMLButtonElement {
  return el('button', { type: 'button', className, title: title ?? text, onclick }, svgIcon(ICONS[icon]), text);
}

function notReady(): string | null {
  if (ws.isReady()) return null;
  return navigator.onLine
    ? 'Your account is still being set up for workspaces. Try again in a few seconds.'
    : 'You are offline. Workspaces need a connection.';
}

// ---- Create ----

function showCreate(): void {
  const name = el('input', { type: 'text', maxLength: 80, placeholder: 'e.g. Family, Team, Project X', autocomplete: 'off' });
  const line = errorLine();
  const create = iconButton('primary-btn', 'plus', 'Create workspace', () => {});
  const form = el('form', { noValidate: true },
    el('p', { className: 'muted small', text: 'A workspace is a separate set of pages you share with other Cherrion accounts. It has its own key: pages are encrypted for its members only, and the server cannot read them or the workspace name.' }),
    el('label', { className: 'field-label' }, 'Name', name),
    line,
    el('div', { className: 'modal-actions end' }, el('button', { type: 'button', className: 'action-btn', text: 'Cancel', onclick: closeWorkspaceDialog }), create),
  );
  create.type = 'submit';
  form.onsubmit = e => {
    e.preventDefault();
    const value = name.value.trim();
    if (!value) { showError(line, new Error('Enter a name.')); return; }
    const problem = notReady();
    if (problem) { showError(line, new Error(problem)); return; }
    void act(create, line, async () => {
      const id = await ws.createWorkspace(value);
      switchSpace(id);
      toast(`Workspace “${value}” created. Invite people below.`);
      showSettings(id);
    }, 'Creating…');
  };
  openModal('New workspace', 'create', undefined, form);
}

// ---- Join with a link ----

/** A link from the address bar (#join=…), kept in memory until the app is open and ready. */
let pendingLink: string | null = null;

/** Takes an invite link out of the address bar (web), so it is not left in the history. */
export function captureJoinLink(): void {
  const hash = location.hash;
  if (!hash.includes('join=')) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (!ws.parseInviteLink(hash)) return;
  pendingLink = `${location.origin}/${hash}`;
  if (store.isUnlocked()) handlePendingLink();
  else toast('Log in (or create an account) to join the shared workspace.', 'info', 8000);
}


function handlePendingLink(): void {
  if (!pendingLink || !store.isUnlocked() || !ws.isReady()) return;
  const link = pendingLink;
  pendingLink = null;
  showJoin(link);
}

function showJoin(prefill?: string): void {
  const input = el('input', { type: 'text', placeholder: 'Paste the invite link', autocomplete: 'off', spellcheck: false });
  if (prefill) input.value = prefill;
  const line = errorLine();
  const next = iconButton('primary-btn', 'link', 'Continue', () => {});
  next.type = 'submit';
  const form = el('form', { noValidate: true },
    el('p', { className: 'muted small', text: 'An invite link lets you join a workspace once. Ask the owner for one if you do not have it.' }),
    el('label', { className: 'field-label' }, 'Invite link', input),
    line,
    el('div', { className: 'modal-actions end' }, el('button', { type: 'button', className: 'action-btn', text: 'Cancel', onclick: closeWorkspaceDialog }), next),
  );
  form.onsubmit = e => {
    e.preventDefault();
    const link = ws.parseInviteLink(input.value);
    if (!link) { showError(line, new Error('That is not a Cherrion invite link.')); return; }
    const problem = notReady();
    if (problem) { showError(line, new Error(problem)); return; }
    void act(next, line, async () => showJoinPreview(link, await ws.previewInviteLink(link)), 'Checking…');
  };
  openModal('Join a workspace', 'join', undefined, form);
  if (prefill) form.requestSubmit();
}

function showJoinPreview(link: ws.InviteLink, preview: ws.LinkPreview): void {
  const line = errorLine();
  if (preview.alreadyMember) {
    openModal('Join a workspace', 'join', undefined,
      el('p', { text: `You are already a member of “${preview.name}”.` }),
      el('div', { className: 'modal-actions end' },
        el('button', { type: 'button', className: 'action-btn', text: 'Close', onclick: closeWorkspaceDialog }),
        iconButton('primary-btn', 'users', 'Open it', () => { closeWorkspaceDialog(); switchSpace(preview.workspaceId); }),
      ));
    return;
  }
  const join = iconButton('primary-btn', 'check', 'Join', () => {
    void act(join, line, async () => {
      const id = await ws.joinWithLink(link);
      await ws.syncWorkspaces();
      closeWorkspaceDialog();
      switchSpace(id);
      toast(`You joined “${preview.name}”.`);
    }, 'Joining…');
  });
  openModal('Join a workspace', 'join', undefined,
    el('p', {}, el('strong', { text: preview.from || 'Someone' }), ` invited you to the workspace `, el('strong', { text: `“${preview.name}”` }), ` as ${ws.ROLE_LABELS[preview.role].toLowerCase()}.`),
    el('p', { className: 'muted small', text: `${ROLE_HINTS[preview.role]}. Everyone in the workspace can read its pages. Your personal pages stay private.` }),
    line,
    el('div', { className: 'modal-actions end' }, el('button', { type: 'button', className: 'action-btn', text: 'Not now', onclick: closeWorkspaceDialog }), join),
  );
}

// ---- Invitations by username ----

function showInvitation(invite: ws.Invitation): void {
  const line = errorLine();
  const accept = iconButton('primary-btn', 'check', 'Join', () => {
    void act(accept, line, async () => {
      const id = await ws.acceptInvitation(invite.id);
      await ws.syncWorkspaces();
      closeWorkspaceDialog();
      switchSpace(id);
      toast(`You joined “${invite.name}”.`);
    }, 'Joining…');
  });
  const decline = el('button', {
    type: 'button', className: 'action-btn', text: 'Decline',
    onclick: () => void act(decline, line, async () => { await ws.declineInvitation(invite.id); closeWorkspaceDialog(); toast('Invitation declined.'); }),
  });
  openModal('Invitation', 'invite', invite.id,
    el('p', {}, el('strong', { text: invite.from || 'Someone' }), ' invited you to the workspace ', el('strong', { text: `“${invite.name}”` }), ` as ${ws.ROLE_LABELS[invite.role].toLowerCase()}.`),
    el('p', { className: 'muted small', text: `${ROLE_HINTS[invite.role]}. Everyone in the workspace can read its pages. Your personal pages stay private.` }),
    line,
    el('div', { className: 'modal-actions end' }, decline, accept),
  );
}

// ---- Workspace settings ----

function roleDropdown(value: ws.Role, owner: boolean, onChange: (role: ws.Role) => void, label = 'Role') {
  const roles: ws.Role[] = owner ? ['owner', 'editor', 'viewer'] : ['editor', 'viewer'];
  return createDropdown({
    className: 'role-dropdown',
    ariaLabel: label,
    options: roles.map(r => ({ value: r, label: ws.ROLE_LABELS[r] })),
    value,
    onChange: v => onChange(v as ws.Role),
  });
}

/** The invite link origin: this website, or (desktop) the linked account's server. */
function linkOrigin(): string {
  if (!DESKTOP) return location.origin;
  return (session.linkedAccount()?.url ?? '').replace(/\/+$/, '');
}

export function showSettings(id: string): void {
  const w = ws.getWorkspace(id);
  if (!w) { closeWorkspaceDialog(); return; }
  const owner = w.role === 'owner';
  const mine = ws.myPublicKey();
  const line = errorLine();
  const parts: Node[] = [];
  const redo = () => { if (view?.kind === 'settings' && view.id === id) showSettings(id); };

  // Name
  if (owner) {
    const name = el('input', { type: 'text', value: w.name, maxLength: 80, autocomplete: 'off' });
    const save = iconButton('primary-btn', 'check', 'Save name', () => {
      const value = name.value.trim();
      if (!value) { showError(line, new Error('Enter a name.')); return; }
      if (value === w.name) { toast('Name unchanged.'); return; }
      void act(save, line, async () => { await ws.renameWorkspace(id, value); renderSwitcher(); toast('Workspace renamed.'); redo(); });
    });
    parts.push(el('h4', { className: 'section-title first', text: 'Name' }), el('div', { className: 'ws-row' }, name, save));
  }

  // Members
  parts.push(el('h4', { className: `section-title${owner ? '' : ' first'}`, text: `Members (${w.members.length})` }));
  const list = el('ul', { className: 'ws-list' });
  const owners = w.members.filter(m => m.role === 'owner').length;
  for (const m of [...w.members].sort((a, b) => a.username.localeCompare(b.username))) {
    const me = !!mine && m.publicKey === mine;
    const code = mine && m.publicKey && !me ? ws.safetyCode(mine, m.publicKey) : null;
    const who = el('span', { className: 'ws-who' },
      el('span', { className: 'user-avatar', text: ([...m.username][0] ?? '?').toUpperCase() }),
      el('span', { className: 'ws-name' }, el('span', { text: m.username }), ...(me ? [el('span', { className: 'muted', text: ' (you)' })] : [])),
    );
    if (code) who.title = `Safety code ${code}. ${m.username} sees the same code for you if nobody swapped the keys: compare it with them in person or on a call.`;
    const row = el('li', { className: 'ws-item' }, who);
    if (owner && !(me && owners === 1)) {
      const dd = roleDropdown(m.role, true, role => {
        void (async () => {
          try { await ws.setRole(id, m.accountId, role); toast(`${m.username} is now ${ws.ROLE_LABELS[role].toLowerCase()}.`); } catch (err) { showError(line, err); }
          redo();
        })();
      }, `Role of ${m.username}`);
      row.append(dd.el);
    } else {
      row.append(el('span', { className: 'ws-role', text: ws.ROLE_LABELS[m.role], title: ROLE_HINTS[m.role] }));
    }
    if (owner && !me) {
      const remove = el('button', { type: 'button', className: 'ws-x', title: `Remove ${m.username}`, text: '✕' });
      remove.setAttribute('aria-label', `Remove ${m.username}`);
      remove.onclick = async () => {
        const ok = await confirmDialog({
          title: `Remove ${m.username}?`,
          message: `${m.username} loses access to “${w.name}”. The workspace gets a new key, so nothing written from now on can be read with the old one. Copies they already made cannot be taken back.`,
          confirmLabel: 'Remove',
        });
        if (!ok) return;
        try { await ws.removeMember(id, m.accountId); toast(`${m.username} was removed.`); } catch (err) { showError(line, err); }
        redo();
      };
      row.append(remove);
    }
    list.append(row);
  }
  parts.push(list);
  if (w.members.some(m => m.publicKey && m.publicKey !== mine)) {
    parts.push(el('p', { className: 'muted small', text: 'Hover a name to see its safety code. Comparing codes with that person confirms nobody, not even the server, swapped their key.' }));
  }

  // Secret fields and viewers
  const viewers = w.members.filter(m => m.role === 'viewer').length;
  if (owner) {
    parts.push(el('h4', { className: 'section-title', text: 'Secret fields' }));
    const box = el('input', { type: 'checkbox', checked: w.viewerSecrets });
    box.onchange = async () => {
      const allow = box.checked;
      box.checked = !allow; // until confirmed and done
      const ok = await confirmDialog(allow
        ? {
          title: 'Let viewers see secret fields?',
          message: `${viewers ? `The ${viewers} viewer${viewers === 1 ? '' : 's'} of “${w.name}”` : 'Viewers'} will be able to read and copy passwords, secret notes and 2FA codes. Every page is saved again, and the workspace gets a new key.`,
          confirmLabel: 'Let viewers see them',
          danger: false,
        }
        : {
          title: 'Hide secret fields from viewers?',
          message: 'Passwords, secret notes and 2FA codes are sealed with a key that only owners and editors get, so viewers cannot read them, not even with the workspace key. Every page is saved again and the workspace gets a new key. Anything viewers already saw cannot be taken back.',
          confirmLabel: 'Hide from viewers',
          danger: false,
        });
      if (!ok) return;
      box.disabled = true;
      try {
        const pages = await ws.setViewerSecrets(id, allow);
        toast(allow ? `Viewers can now see secret fields (${pages} page${pages === 1 ? '' : 's'} saved again).` : `Secret fields are now hidden from viewers (${pages} page${pages === 1 ? '' : 's'} sealed again).`);
      } catch (err) {
        showError(line, err);
      }
      redo();
    };
    parts.push(
      el('label', { className: 'check' }, box, 'Viewers can see secret fields (passwords, secret notes, 2FA codes)'),
      el('p', {
        className: 'muted small',
        text: w.viewerSecrets
          ? 'Viewers can read and copy them. Turn this off to seal them with a key only owners and editors get.'
          : 'Hidden from viewers: they are sealed with a key only owners and editors get. Viewers see “Hidden” instead.',
      }),
    );
  } else {
    parts.push(el('p', {
      className: 'muted small',
      text: w.viewerSecrets ? 'Viewers in this workspace can see secret fields.' : 'Secret fields (passwords, secret notes, 2FA codes) are hidden from viewers in this workspace.',
    }));
  }

  // Invite
  if (owner) {
    parts.push(el('h4', { className: 'section-title', text: 'Invite' }));
    const username = el('input', { type: 'text', placeholder: 'Cherrion username', autocomplete: 'off', spellcheck: false });
    let inviteRole: ws.Role = 'editor';
    const inviteDd = roleDropdown('editor', false, r => { inviteRole = r; }, 'Role for the invited person');
    const invite = iconButton('primary-btn', 'userPlus', 'Invite', () => {});
    const byName = el('form', { className: 'ws-row', noValidate: true }, username, inviteDd.el, invite);
    invite.type = 'submit';
    byName.onsubmit = e => {
      e.preventDefault();
      const value = username.value.trim();
      if (!value) { showError(line, new Error('Enter their username.')); return; }
      void act(invite, line, async () => {
        await ws.inviteByUsername(id, value, inviteRole);
        toast(`Invitation sent to ${value}. They see it in their space menu.`);
        redo();
      }, 'Inviting…');
    };
    parts.push(byName, el('p', { className: 'muted small', text: 'They see the invitation under the space menu after logging in, and choose to join.' }));

    let linkRole: ws.Role = 'editor';
    const linkDd = roleDropdown('editor', false, r => { linkRole = r; }, 'Role for people joining with the link');
    const out = el('div', { className: 'ws-link hidden' });
    const makeLink = iconButton('action-btn', 'link', 'Create invite link', () => {
      void act(makeLink, line, async () => {
        const link = await ws.createInviteLink(id, linkRole, linkOrigin());
        const field = el('input', { type: 'text', readOnly: true, value: link, spellcheck: false });
        field.setAttribute('aria-label', 'Invite link');
        field.onfocus = () => field.select();
        const copy = iconButton('primary-btn', 'copy', 'Copy', () => {
          navigator.clipboard.writeText(link).then(() => toast('Invite link copied.'), () => toast('Copy failed: select the link and copy it.', 'error'));
        });
        out.replaceChildren(
          el('div', { className: 'ws-row' }, field, copy),
          el('p', { className: 'notice warn small', text: 'Anyone with this link can join once, within 7 days. Send it privately (not in a public channel). It is shown only now.' }),
        );
        out.classList.remove('hidden');
        // The pending list (below) gains the link; rebuild it without losing the link shown here.
        pendingHost.replaceChildren(...pendingInvites(id, line, redo));
      }, 'Creating…');
    });
    parts.push(el('div', { className: 'ws-row' }, el('span', { className: 'muted small ws-grow', text: 'Or share a single-use link, role:' }), linkDd.el, makeLink), out);

    const pendingHost = el('div', {}, ...pendingInvites(id, line, redo));
    parts.push(pendingHost);
  }

  // Leave / delete
  parts.push(el('h4', { className: 'section-title', text: owner ? 'Leave or delete' : 'Leave' }));
  const actions = el('div', { className: 'modal-actions' });
  const leave = iconButton('action-btn', 'exit', 'Leave workspace', async () => {
    const ok = await confirmDialog({
      title: `Leave “${w.name}”?`,
      message: 'Its pages disappear from your account. To come back, someone has to invite you again.',
      confirmLabel: 'Leave',
    });
    if (!ok) return;
    await act(leave, line, async () => {
      leaving = true;
      try { await ws.leaveWorkspace(id); } finally { leaving = false; }
      closeWorkspaceDialog(); switchSpace(store.PERSONAL); toast(`You left “${w.name}”.`);
    });
  });
  actions.append(leave);
  if (owner) {
    const del = iconButton('action-btn danger', 'trash', 'Delete workspace', async () => {
      const ok = await confirmDialog({
        title: `Delete “${w.name}”?`,
        message: `The workspace and all its pages are deleted for all ${w.members.length} member${w.members.length === 1 ? '' : 's'}. This cannot be undone. Move pages you want to keep to Personal first.`,
        confirmLabel: 'Delete workspace',
      });
      if (!ok) return;
      await act(del, line, async () => {
        leaving = true;
        try { await ws.deleteWorkspace(id); } finally { leaving = false; }
        closeWorkspaceDialog(); switchSpace(store.PERSONAL); toast(`“${w.name}” was deleted.`);
      });
    });
    actions.append(del);
  }
  parts.push(actions, line);

  openModal(w.name, 'settings', id, ...parts);
}

function pendingInvites(id: string, line: HTMLElement, redo: () => void): Node[] {
  const w = ws.getWorkspace(id);
  if (!w?.invites.length) return [];
  const list = el('ul', { className: 'ws-list' });
  for (const i of w.invites) {
    const what = i.link ? 'Invite link' : i.username ?? 'Unknown account';
    const revoke = el('button', { type: 'button', className: 'ws-x', text: '✕', title: `Cancel the invitation (${what})` });
    revoke.setAttribute('aria-label', `Cancel the invitation for ${what}`);
    revoke.onclick = async () => {
      try { await ws.revokeInvite(i.id); toast('Invitation cancelled.'); } catch (err) { showError(line, err); }
      redo();
    };
    list.append(el('li', { className: 'ws-item' },
      el('span', { className: 'ws-who' }, el('span', { className: 'ws-pending-icon' }, svgIcon(ICONS[i.link ? 'link' : 'mail'])), el('span', { className: 'ws-name', text: what })),
      el('span', { className: 'ws-role', text: `${ws.ROLE_LABELS[i.role]} · until ${new Date(i.expiresAt).toLocaleDateString()}` }),
      revoke,
    ));
  }
  return [el('p', { className: 'muted small ws-pending-title', text: 'Waiting to be accepted' }), list];
}

// ---- Moving pages between spaces ----

/** Destinations a page can move to: Personal and the workspaces where this account can write. */
export function moveTargets(noteId: string): string[] {
  if (!available()) return [];
  const from = store.spaceOf(noteId);
  if (store.isReadOnly(from)) return [];
  return [store.PERSONAL, ...ws.listWorkspaces().filter(w => w.role !== 'viewer').map(w => w.id)].filter(s => s !== from);
}

export function showMove(noteId: string): void {
  const note = store.getNote(noteId);
  if (!note || note.deleted) return;
  const targets = moveTargets(noteId);
  if (!targets.length) { toast('Create or join a workspace first: the space menu is above the search box.'); return; }
  const title = note.title || 'Untitled';
  const subs = countDescendants(store.activeNotes(), noteId);
  let target = targets[0]!;
  const dd = createDropdown({
    className: 'dd-block',
    ariaLabel: 'Move to',
    options: targets.map(t => ({ value: t, label: spaceName(t), svg: (t === store.PERSONAL ? 'user' : 'users') as IconName })),
    value: target,
    onChange: v => { target = v; explain(); },
  });
  const hint = el('p', { className: 'muted small' });
  const explain = () => {
    hint.textContent = target === store.PERSONAL
      ? 'Only you will see them. Other members lose access to these pages.'
      : `Every member of “${spaceName(target)}” will be able to read them${ws.getWorkspace(target)?.members.some(m => m.role !== 'viewer') ? ', and editors can change them' : ''}.`;
  };
  explain();
  const line = errorLine();
  const move = iconButton('primary-btn', 'move', 'Move', () => {
    try {
      const newId = store.moveToSpace(noteId, target);
      lastNote.set(target, newId);
      const current = store.getNote(ui.activeNoteId);
      if (!current || current.deleted) selectNote(store.activeNotes()[0]?.id ?? null);
      closeWorkspaceDialog();
      render.all();
      toast(`Moved “${title}”${subs ? ` and ${subs} sub-page${subs === 1 ? '' : 's'}` : ''} to ${spaceName(target)}.`);
    } catch (err) {
      showError(line, err);
    }
  });
  openModal('Move page', 'move', noteId,
    el('p', {}, el('strong', { text: `“${title}”` }), subs ? ` and its ${subs} sub-page${subs === 1 ? '' : 's'}` : '', ' will move to:'),
    el('label', { className: 'field-label' }, 'Space', dd.el),
    hint,
    line,
    el('div', { className: 'modal-actions end' }, el('button', { type: 'button', className: 'action-btn', text: 'Cancel', onclick: closeWorkspaceDialog }), move),
  );
}

// ---- Wiring ----

export function wireWorkspaces(): void {
  $('btn-close-workspace').onclick = closeWorkspaceDialog;
  const modal = $('workspace-modal');
  modal.addEventListener('mousedown', e => { if (e.target === modal) closeWorkspaceDialog(); });
  modal.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('dropdown-menu')?.matches(':not(.hidden)')) { e.preventDefault(); closeWorkspaceDialog(); }
  });
  ws.onWorkspacesChange(() => {
    if (!store.isUnlocked()) return;
    // The workspace on screen went away (removed, deleted, or left on another device).
    if (shown !== store.PERSONAL && !ws.getWorkspace(shown)) {
      switchSpace(store.PERSONAL);
      if (!leaving && available()) toast('You no longer have access to that workspace.', 'info', 6000);
    }
    if (view?.kind === 'settings' && view.id && !ws.getWorkspace(view.id)) closeWorkspaceDialog();
    renderSwitcher();
    // A role change (Editor ↔ Viewer) flips the open page between editable and read-only. Rebuild it
    // only then: rebuilding on every change would throw the cursor out of what is being typed.
    const note = store.getNote(ui.activeNoteId);
    const readOnly = !!note && store.isReadOnly(store.spaceOf(note.id));
    if (readOnly !== $('note-container').classList.contains('read-only')) render.editor();
    handlePendingLink();
  });
  window.addEventListener('hashchange', captureJoinLink);
}

/** Called when the app opens (after login or unlocking a file) and when it locks. */
export function resetWorkspacesUi(): void {
  lastNote.clear();
  shown = store.PERSONAL;
  closeWorkspaceDialog();
  renderSwitcher();
}
