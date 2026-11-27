// Built-in documentation (works offline, also from the login screen). Text uses **bold** and
// `keys`; everything is rendered with textContent, so the page's CSP and XSS rules still hold.
import { DESKTOP } from '../platform';
import { $, el } from './dom';

type Item = string | { list: string[] } | { keys: [string, string][] } | { note: string };
interface Section { id: string; icon: string; title: string; only?: 'web' | 'desktop'; body: Item[] }

const SECTIONS: Section[] = [
  {
    id: 'start', icon: '🚀', title: 'Getting started',
    body: [
      'Cherrion keeps notes, passwords, 2FA codes and other sensitive details **end-to-end encrypted**: everything is encrypted on your device with your password before it is saved or synced. Nobody else can read it, not even the server.',
      { list: [
        '**Create a page** with ＋ (top of the sidebar). Pick a template: Blank page, Email account, Website login, Proxy, Secure note or Meeting.',
        '**Type in the page.** Press `/` in an empty line for headings, to-dos, tables, pictures, secret fields and more.',
        '**Organise** pages in the tree on the left: drag them, or add sub-pages with the ＋ next to a page.',
        '**Save your recovery key** when it is shown. It is the only way back in if you forget your password.',
      ] },
    ],
  },
  {
    id: 'account', icon: '👤', title: 'Your account (website)', only: 'web',
    body: [
      { list: [
        '**Create an account** with a username and password. Your password never leaves the browser; only a one-way login key is sent.',
        '**Log in on any device** with the same username and password. Changes sync to your other devices within about 20 seconds (or right away with **Sync now** in the account menu).',
        '**Forgot your password?** Choose “Use your recovery key” on the login screen and set a new password.',
        '**Install as an app** (Chrome or Edge): account menu → **Install app**, or the install icon in the address bar. Cherrion then opens in its own window from the Start menu, taskbar or dock. Only the page is installed: your notes stay encrypted in your account.',
        '**Browser menu:** in the sidebar and in pages, right-click opens Cherrion’s menu. Hold **Shift** while right-clicking for the browser’s own menu (spelling suggestions, translate).',
        '**Offline?** Keep the tab open: the status shows “Offline · N unsaved” and the changes are saved when you are back online. Closing the tab first asks for confirmation.',
      ] },
    ],
  },
  {
    id: 'files', icon: '📁', title: 'Vault files (desktop)', only: 'desktop',
    body: [
      'The desktop app keeps each vault in **one encrypted .cherrion file**, like a CherryTree document. Copy or back it up like any other file; it opens only with its password, also offline.',
      { list: [
        '**Create a new vault file:** choose your name, a password and where to save it.',
        '**Open a vault file:** pick a recent file (or browse) and enter its password.',
        '**Sync with an online account:** “I already have an account” downloads your web account into a new file that keeps syncing; “Create a new account” signs you up and creates the synced file in one step.',
        '**Link an existing file** in ⚙ Settings → Online sync. Changes made offline stay in the file and upload when the server can be reached.',
        '**Double-click to open:** ⚙ Settings → Vault file → “Open .cherrion files with Cherrion”.',
        '**Closing the window** asks whether to hide Cherrion in the tray (the 🍒 icon by the clock) or exit. Starting Cherrion again brings the running window back. Change the choice in ⚙ Settings.',
      ] },
    ],
  },
  {
    id: 'workspaces', icon: '👥', title: 'Shared workspaces',
    body: [
      'A **workspace** is a separate set of pages shared with other Cherrion accounts, for a family or a small team. Your **Personal** pages are never shared. Each workspace has its own key: its pages and its name are encrypted for its members only, and the server cannot read them.',
      { list: [
        '**Switch spaces** with the menu above the search box: Personal, then each workspace. The tree, search and stickies show the chosen space.',
        '**Create one:** space menu → New workspace…, then invite people from Workspace settings.',
        '**Invite by username:** they see the invitation (a red number on the space menu) after logging in, and choose to join or decline.',
        '**Invite by link:** “Create invite link” makes a single-use link valid for 7 days. Send it privately: anyone who has it can join once. The secret part of the link never reaches the server.',
        '**Roles:** Owners invite and remove people and can delete the workspace; Editors add, change and delete pages; Viewers can read and copy but not change anything.',
        '**Removing someone** gives the workspace a new key, so nothing written afterwards can be read with the old one. Pages they already saw may still be in their copies.',
        '**Move a page** between Personal and a workspace with ⋯ → Move to workspace… (or right-click it in the sidebar). Its sub-pages move with it.',
        '**Safety codes:** in Workspace settings, hover a member’s name to see a code. If they see the same code for you, nobody (not even the server) swapped your keys.',
        'Two people editing the **same page at the same moment**: the last save wins. Editing different pages at the same time is always fine.',
      ] },
      { note: DESKTOP
        ? 'In the desktop app, workspaces need a vault file linked to an online account, and are shown while connected; they are not stored in the .cherrion file. Files that are not linked are never shared.'
        : 'Workspaces need a connection, like the rest of the website.' },
    ],
  },
  {
    id: 'pages', icon: '🌲', title: 'Pages and the tree',
    body: [
      { list: [
        '**Sub-pages:** hover a page and press its ＋, use ↳ Sub-note in the toolbar, or type `/page` in a page to add a linked sub-page.',
        '**Click a page** to open it and show or hide its sub-pages (the ▶ arrow only shows or hides). With the keyboard: `→` expands, `←` collapses, `↑` `↓` move between pages.',
        '**Move pages** by dragging them onto another page (to nest) or onto its top or bottom edge (to reorder).',
        '**Breadcrumbs** above the page open its parent pages.',
        '**Search** (`Ctrl+K`) looks through titles and text; secret values are never searched.',
        '**Categories** (Note, Email account, Website login, Proxy, Secure note, Meeting) set the icon and filter. Changing a page’s category offers to add that category’s form.',
        '**Right-click a page** in the sidebar for Open, New sub-page, Rename, Duplicate, Pin, Move, Export, Import and Delete.',
      ] },
    ],
  },
  {
    id: 'blocks', icon: '🧱', title: 'Writing: blocks and / commands',
    body: [
      'Every line is a block. Type `/` in an empty block to choose its type, or use a Markdown shortcut at the start of a line:',
      { keys: [
        ['/', 'Block menu: Text, Page, Heading 1/2, To-do, Callout, Quote, Code, Table, Picture, Divider, Field group, Secret field, 2FA code'],
        ['# ', 'Heading 1'], ['## ', 'Heading 2'], ['[] ', 'To-do'], ['> ', 'Quote'], ['``` ', 'Code block'], ['---', 'Divider'],
      ] },
      { list: [
        '`Enter` starts a new block, `Shift+Enter` a new line inside it. `Backspace` in an empty block removes it.',
        'Hover a block for ↑ ↓ ✕ in the left margin (⋮ on narrow screens). Right-click a block for Turn into, Insert below, Duplicate, Move and Delete; in a text field the menu also has Cut, Copy and Paste.',
      ] },
    ],
  },
  {
    id: 'tables', icon: '▦', title: 'Tables',
    body: [
      'Type `/table` for a 3 × 3 table with a header row.',
      { keys: [
        ['Tab / Shift+Tab', 'Next / previous cell (Tab in the last cell adds a row)'],
        ['Enter', 'Cell below (adds a row at the bottom)'],
        ['Shift+Enter', 'New line inside a cell'],
        ['↑ / ↓', 'Cell above / below, then out of the table'],
      ] },
      'Hover the table for **Row**, **Column** and **⋯** (insert above/below/left/right, delete a row or column, turn the header row on or off).',
    ],
  },
  {
    id: 'pictures', icon: '🖼', title: 'Pictures',
    body: [
      { list: [
        'Add a picture with `/picture`, by pasting it (`Ctrl+V`), or by dropping picture files onto the page.',
        'Pictures are shrunk to at most 1600 px and stored inside the page, so they are **encrypted and synced** with it.',
        'Click a picture to see it full size. Add a caption below it (captions are searchable).',
        'A page holds about 2 MB of pictures; put more on sub-pages.',
      ] },
    ],
  },
  {
    id: 'fields', icon: '🔐', title: 'Fields, secrets and 2FA codes',
    body: [
      { list: [
        '**Field groups** hold labelled values (email, URL, phone, date…). Add more with **+ Field**, **+ Secret field**, **+ Secret note** and **+ 2FA code**.',
        '**Secrets** (passwords, secret notes, backup codes) are masked until you press 👁. Copying a secret clears the clipboard after 30 seconds.',
        '**2FA code** fields store the secret key (or otpauth:// link) from a site’s 2FA setup and show the current 6-digit code with a countdown, like an authenticator app. ✎ edits the key; 📋 copies the code.',
        '**Proxy pages:** paste `ip:port:user:password` into **Link** and the IP address, Port, User and Password fields fill in automatically.',
      ] },
    ],
  },
  {
    id: 'stickies', icon: '📌', title: 'Sticky notes',
    body: [
      { list: [
        '**📌 Pin Sticky** in the toolbar puts a page on the Stickies board; choose its colour next to it.',
        'Simple pages (text and to-dos) can be edited right on the board; others are shown read-only with secrets masked.',
        DESKTOP ? 'Floating pop-out stickies are available on the website (Chrome or Edge).' : '**Pop-Out** floats a sticky above other windows (Chrome or Edge).',
      ] },
    ],
  },
  {
    id: 'transfer', icon: '⇅', title: 'Export, import and backups',
    body: [
      { list: [
        '**Export a page** from ⋯ in the page toolbar: a **Cherrion page file** keeps everything (optionally with its sub-pages) and can be protected with its own password; **Markdown** is readable anywhere (secret values masked unless you include them).',
        '**Import a page** from ⋯ → Import: a page file (asks for its password if it has one) or any Markdown/text file. Imported pages are added as new pages; nothing existing is overwritten.',
        '**Encrypted backup of everything:** ⚙ Settings → Backup. Only your password or recovery key can open it.',
      ] },
    ],
  },
  {
    id: 'security', icon: '🛡', title: 'Security and privacy',
    body: [
      { list: [
        'Your password turns into an encryption key on your device (Argon2id); notes are encrypted with XChaCha20-Poly1305. The server only stores ciphertext.',
        '**Recovery key:** shown once when you start. ⚙ Settings → Security can make a new one (the old one stops working).',
        '**Change password** in ⚙ Settings → Security. Notes are not re-encrypted; only the key that unlocks them is.',
        `**${DESKTOP ? 'Lock' : 'Log out'} automatically** after inactivity (⚙ Settings; 10 minutes by default), or any time with 🔒. This wipes the key and decrypted notes from memory.`,
        'There is no “reset” without your password or recovery key: keep the recovery key somewhere safe and offline.',
      ] },
    ],
  },
  {
    id: 'keys', icon: '⌨', title: 'Keyboard shortcuts',
    body: [
      { keys: [
        ['Ctrl+K', 'Search pages'],
        ['/', 'Block menu (in an empty block)'],
        ['Enter / Shift+Enter', 'New block / new line'],
        ['↑ / ↓', 'Previous / next page in the tree'],
        ['→', 'Expand the page; again: go to its first sub-page'],
        ['←', 'Collapse the page; again: go to its parent'],
        ['Home / End', 'First / last page in the tree'],
        ['Alt+↑ / Alt+↓', 'Move the selected page up / down in the tree'],
        ['Alt+→ / Alt+←', 'Nest the page under the one above / move it out of its parent'],
        ['F2', 'Rename the selected page'],
        ['Delete', 'Delete the selected page (asks first)'],
        ['Ctrl+X / C / V / A', 'Cut / copy / paste / select all'],
        ['Esc', 'Close a menu or dialog'],
      ] },
    ],
  },
  {
    id: 'help', icon: '🩺', title: 'Troubleshooting',
    body: [
      { list: [
        '**“Wrong username or password”**: usernames are lower-case. New to Cherrion? Create an account first.',
        '**Offline / Sync error**: hover the status under your name for the reason (name lookup, refused connection, timeout, or a proxy or antivirus blocking HTTPS).',
        ...(DESKTOP ? [
          '**“That account holds a different vault”**: the file was created separately from the online account. Use “Sync with an online account” on the start screen to get the account into its own file.',
          '**“Already open in another Cherrion window”**: a vault file can be open in one window at a time.',
          '**Something went wrong?** The app writes warnings and errors (never note content) to `%APPDATA%\\Cherrion\\cherrion.log`. Send that file when reporting a problem.',
        ] : [
          '**“Your session has expired”**: sessions last 12 hours; log in again. Changes are saved within a second or two, so normally nothing is lost.',
        ]),
      ] },
    ],
  },
];

/** Renders **bold** and `keys` inside a line of text. */
function rich(text: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  const re = /\*\*(.+?)\*\*|`(.+?)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] !== undefined ? el('strong', { text: m[1] }) : el('kbd', { text: m[2]! }));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderItem(item: Item): HTMLElement {
  if (typeof item === 'string') return el('p', {}, ...rich(item));
  if ('list' in item) return el('ul', {}, ...item.list.map(t => el('li', {}, ...rich(t))));
  if ('note' in item) return el('p', { className: 'notice' }, ...rich(item.note));
  return el('table', { className: 'docs-keys' }, el('tbody', {}, ...item.keys.map(([k, v]) =>
    el('tr', {}, el('th', {}, ...k.split(' / ').flatMap((part, i) => [...(i ? [' / '] : []), el('kbd', { text: part })])), el('td', {}, ...rich(v))))));
}

let built = false;

function build(): void {
  if (built) return;
  built = true;
  const sections = SECTIONS.filter(s => !s.only || s.only === (DESKTOP ? 'desktop' : 'web'));
  const content = $('docs-content');
  const toc = $('docs-toc');
  for (const s of sections) {
    const heading = el('h3', { id: `docs-${s.id}`, tabIndex: -1 }, el('span', { className: 'docs-icon', text: s.icon }), s.title);
    content.append(el('section', { className: 'docs-section' }, heading, ...s.body.map(renderItem)));
    const link = el('button', { type: 'button', className: 'docs-link' }, el('span', { className: 'docs-icon', text: s.icon }), s.title);
    link.onclick = () => { heading.scrollIntoView({ block: 'start', behavior: 'smooth' }); heading.focus({ preventScroll: true }); };
    toc.append(link);
  }
}

export function openDocs(sectionId?: string): void {
  build();
  $('docs-modal').classList.remove('hidden');
  const target = sectionId ? document.getElementById(`docs-${sectionId}`) : null;
  requestAnimationFrame(() => {
    if (target) target.scrollIntoView({ block: 'start' });
    else $('docs-content').scrollTop = 0;
    $('btn-close-docs').focus();
  });
}

export function closeDocs(): void {
  $('docs-modal').classList.add('hidden');
}

export function wireDocs(): void {
  const modal = $('docs-modal');
  $('btn-close-docs').onclick = closeDocs;
  modal.addEventListener('mousedown', e => { if (e.target === modal) closeDocs(); });
  modal.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); closeDocs(); } });
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-open-docs]')) b.onclick = () => openDocs(b.dataset.openDocs || undefined);
}
