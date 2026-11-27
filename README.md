Below is the **complete, structured project documentation** formatted so you can copy it directly into **Microsoft Word** or **Google Docs** (paste it in and click **File → Save As / Download → Microsoft Word (.docx)**). At the end, I’ve also included a quick PowerShell command if you want to save this report directly to your Desktop as a `.rtf` document (which opens cleanly in Word, LibreOffice, and Google Docs).

---

# Cherrion — Project Documentation & Work History

**Project Name:** Cherrion (CherryTree + Notion + Windows Sticky Notes)  
**Architecture:** End-to-End Encrypted Web App (TypeScript + Vite, libsodium) on Vercel, with a small serverless API and Postgres, plus an offline Windows desktop app (Python + pywebview + SQLite) that can sync with it  
**Deliverables Created:** `index.html`, `src/` (TypeScript app and styles), `api/` (Vercel functions), `desktop/` (desktop app), `tests/`, `.github/workflows/`

---

## 1. Work History (Session Log)

| Step | Task | Outcome |
| :--- | :--- | :--- |
| **1** | **Requirements Analysis & Architecture Design** | Merged features from CherryTree (tree hierarchy), Notion (slash-command blocks), and Windows Sticky Notes (pinned board & floating windows) into a lightweight, zero-framework codebase. |
| **2** | **Core Application Implementation** | Built the full 4-file application (`index.html`, `styles.css`, `app.js`, `sync-server.js`) with offline storage, cross-tab sync, block editing, sticky pop-outs, and server sync. |
| **3** | **Packaging Automation** | Provided a single-command Windows PowerShell script to generate the `cherrion-notes` project folder and package it into `cherrion-notes.zip` on the Desktop. |
| **4** | **Cloud Storage & Backup Guidance** | Documented how to upload the package to Google Drive and use JSON export/import with Google Drive for Desktop. |
| **5** | **Data Persistence Documentation** | Detailed all three data storage locations (`localStorage`, `sync-data/` folder, and JSON exports) along with browser storage caveats. |
| **6** | **Encrypted Vault & Templates (Step 1)** | Moved to TypeScript + Vite. Notes are encrypted on the device (Argon2id + XChaCha20-Poly1305 via libsodium) and stored in IndexedDB; the sync server and backups only ever see ciphertext. Added a vault password with a recovery key, auto-lock, a new-page template picker (Email account, Website login, Secure note, Meeting), categories, and field-group / secret-field blocks. |
| **7** | **Online Version on Vercel + Postgres** | The web app became online-only: username/password accounts on a Vercel serverless API with Postgres (Neon), automatic encrypted saving and multi-device sync, offline edits kept until reconnect, password reset with the recovery key, and a one-time move of the vault saved in the browser into the account. |
| **8** | **Offline Desktop App (Python + SQLite)** | A Windows desktop app (`desktop/`, Python + pywebview, packaged as one `Cherrion.exe`) that keeps each vault in one encrypted `.cherrion` SQLite file, like a CherryTree document. Works fully offline; a file can be linked to an online account (sync URL) and syncs with the web version. GitHub Actions builds the exe on every push and publishes a release for each `v*` tag. |
| **9** | **Shared Workspaces** | Separate sets of pages shared with other accounts (Owner / Editor / Viewer), invited by username or by a single-use link. Each workspace has its own key, sealed to each member's public key, so the server still sees only ciphertext. Removing a member replaces the key. Pages move between Personal and a workspace. |

---

## 2. Design Principles Followed

1. **Lightweight:** Plain TypeScript and DOM code with no UI framework. The only runtime dependency is libsodium; Vite, TypeScript and Vitest are development tools.
2. **Maintainable Modular Structure:** Data model, templates, encryption, storage, sync and UI each live in their own module under `src/`, with unit tests for the security-critical parts in `tests/`.
3. **Online, Zero-Knowledge Storage:** Every edit is encrypted in the browser and saved to the account within about a second; the server never sees plaintext or the password.
4. **Conflict-Safe Syncing:** Uses per-note timestamps (`updatedAt`) and soft-delete flags (`deleted: true` tombstones) so offline edits across devices merge using Last-Write-Wins without resurrecting deleted notes.
5. **Predictable Block Editing:** Uses auto-resizing `<textarea>` elements instead of `contenteditable` to prevent cross-browser cursor glitches and messy HTML paste behavior.
6. **Zero-Knowledge Encryption:** The vault password never leaves the device. Storage, sync and backups only hold ciphertext, and each note's id, timestamp and deleted flag are bound to its ciphertext so a server cannot tamper with them.

---

## 3. What Was Implemented

### A. CherryTree-Style Hierarchy (`src/ui/app.ts`, `src/styles.css`)
* Infinite nested parent/child note tree in the left sidebar.
* Expand/collapse toggles (`▶` / `▼`) persisted per note.
* Breadcrumb navigation trail in the top bar (e.g., `Welcome / Quick Code & Shortcuts`).
* Real-time search across note titles and all block contents (`Ctrl + K` / `Cmd + K` shortcut).
* Cascading soft-delete for parent notes and their child sub-notes.

### B. Notion-Style Block Editor (`src/ui/editor.ts`)
* **Supported Block Types:** Paragraph (`p`), Heading 1 (`h1`), Heading 2 (`h2`), To-do Checkbox (`todo`), Callout (`callout`), Quote (`quote`), Code Block (`code`), Divider (`divider`), Field group (`fields`, including secret fields), Page link (`page`) and Table (`table`).
* **Pictures (`/picture`, paste or drag and drop):**
  * Each picture is shrunk to at most 1600 px and saved as WebP inside the page, so it is encrypted and synced like the rest of the page. A 5 MB photo typically becomes tens or hundreds of KB.
  * Click a picture to see it full size; add a caption below it (captions are searchable).
  * A page can hold about 2 MB of pictures; put more on sub-pages.
* **Export / import a page (⋯ in the page toolbar, or right-click in the desktop sidebar):**
  * **Cherrion page file** (`.cherrion-page`) keeps everything, with or without sub-pages. You can protect it with its own password, which is then asked for on import. Without a password, a warning says the file is readable by anyone.
  * **Markdown** (`.md`) is readable anywhere. Secret values are masked unless you tick "Include secret values".
  * **Import** a page file or any Markdown/text file at the top level or under the current page. Imported pages always get new ids, so nothing existing is overwritten.
* **Tables (`/table`):**
  * A grid with an optional header row.
  * **Tab** / **Shift+Tab** move between cells, **Enter** moves down, and Tab in the last cell adds a row.
  * Hover the table for **Row**, **Column** and **⋯** (insert above/below/left/right, delete row or column, toggle the header row).
  * Table text is searchable and shows on sticky cards.
* **Slash Command Menu (`/`):** Typing `/` opens a filterable command menu navigable via `ArrowUp`, `ArrowDown`, `Enter`, `Escape`, or mouse click.
* **Markdown Shortcuts:** Auto-converts `# `, `## `, `[] ` / `[ ] `, `> `, ```` ```  ````, and `---` into structured blocks.
* **Keyboard & Hover Controls:** `Enter` creates a block below, `Backspace` on an empty block removes/resets it, `ArrowUp`/`ArrowDown` moves between blocks, plus hover buttons (`↑`, `↓`, `✕`) to reorder or delete blocks.

### C. Windows Sticky Notes Integration (`src/ui/stickies.ts`)
* **Pin & Color Coding:** Any note can be pinned as a Sticky Note with 5 color themes (`yellow`, `blue`, `green`, `pink`, `purple`).
* **Sticky Board View:** Dedicated tab (`📌 Stickies`) displaying all pinned notes as editable desktop-style cards.
* **Always-on-Top Pop-Out Windows:** Clicking `↗ Pop-Out` opens a floating sticky note window via the **Document Picture-in-Picture API** (stays above all other OS windows in Chrome/Edge), with `window.open` popup fallback in other browsers.
* **Live Synchronization:** Edits inside a floating sticky note sync immediately back to the main tree and editor.

### D. Accounts, Sync, Theme & Backup (`src/store.ts`, `src/sync.ts`, `api/`)
* **Instant Multi-Tab Sync:** Uses `BroadcastChannel` (`cherrion_sync`) to keep open tabs synchronized.
* **Online Accounts (`api/`):** Vercel serverless functions with Postgres. Log in with a username and password from any device; the browser sends only a one-way auth key derived from the password, and the server stores only encrypted notes. Changes save automatically and other devices pick them up within about 20 seconds (or with **Sync now**).
* **Dark / Light Mode:** CSS-variable theme switcher (`🌓`) persisted in settings.
* **Portable Backups:** Export full workspace to `.json` and import/merge `.json` backups without overwriting newer notes.

### E. Encrypted Vault, Templates & Secret Fields (`src/`)
* **Vault:** A vault password (Argon2id, 64 MiB) unlocks a random 256-bit vault key that encrypts every note with XChaCha20-Poly1305. A one-time **recovery key** can reset a forgotten password. Changing the password or making a new recovery key does not re-encrypt notes.
* **User Name:** Asked for when the vault is created and changeable under **⚙ Settings → Profile**. It is stored encrypted in the vault, synced to joined devices, and shown in the sidebar and on the unlock screen ("Welcome back, …").
* **Sub-note Shortcut:** Hovering a note in the tree shows a **+** that opens the template picker for a new sub-note under it.
* **Drag & Drop Tree:** Drag a note onto the middle of another to nest it, or onto the top or bottom edge to reorder it. On touch screens, long-press first. **Alt+↑/↓** reorders from the keyboard, **Alt+→** nests and **Alt+←** moves a note out of its parent.
* **Clickable Breadcrumbs & Page Links:** Each breadcrumb opens that page. Typing `/page` creates a sub-page from a template and leaves a link to it.
* **Confirmations:** Removing a field, deleting a non-empty block, or deleting a page asks first in an in-app dialog.
* **2FA Codes:** A **2FA code** field stores an authenticator secret key (or `otpauth://` link) and shows the current 6-digit code with a countdown ring, like an authenticator app (RFC 6238; SHA-1/256/512, 6–8 digits). **✎** edits the key and **📋** copies the current code. The Email account and Website login templates include it; `/2FA code` and **+ 2FA code** add one anywhere.
* **Account Menu & Status:** The sidebar footer shows your name and the connection status: Local only, Syncing…, Online · synced, Offline, or Sync error. Clicking the name opens a menu with Sync now, Settings, Edit name, Dark/Light mode and Lock vault.
* **Responsive Layout:** On narrow screens the sidebar slides in from ☰, top-bar buttons become icons, and block actions collapse into a ⋮ menu. All pickers are custom dropdowns that behave the same on every device.
* **Lock & Auto-lock:** 🔒 locks every open tab. The vault also locks after 1–60 minutes of inactivity (configurable). Locking wipes decrypted content from memory and the page and closes pop-outs.
* **Template Picker:** ＋ and ↳ Sub-note open a picker: Blank page, **Email account** (address, password, recovery email/phone, 2-Step method, backup codes), **Website login**, **Proxy**, **Secure note** and **Meeting / general note**.
* **Proxy pages:** Link, IP address, Port, User, Password and Note. Paste `ip:port:user:password` (also `user:password@ip:port`, with an optional `socks5://` or `http://`) into **Link** and the other four fields fill in. Editing them rebuilds the link, unless you typed your own. Link and Password are secret fields.
* **Changing a page's category** offers that category's form, listing its fields. It fills a blank page, or goes on top of existing content without removing anything. It isn't offered again if the page already has the form.
* **Field groups:** + Field, + Secret field, + Secret note (hidden multi-line text) and + 2FA code.
* **Categories:** Each note has a category, shown as a tree icon and usable as a sidebar filter.
* **Field Groups & Secret Fields:** Labelled inputs that can be added anywhere with `/` (**Field group**, **Secret field**). Secret values are masked until revealed, excluded from search, masked in stickies and pop-outs, and copied with a 30-second clipboard clear.
* **Shared Workspaces (`src/workspaces.ts`, `src/ui/workspaces.ts`, `api/_lib/workspaces.ts`):** The space menu above the search box switches between **Personal** and each workspace. Owners invite by username (the invitee accepts or declines) or by a **single-use invite link** valid for 7 days; the secret part after `#` never reaches the server. Roles: **Owner** (manage people, delete), **Editor** (change pages), **Viewer** (read and copy only). Every account gets an X25519 key pair: the private key is encrypted in the vault header, the public key is published. Each workspace has a random key per *epoch*, sealed to every member; the workspace name and pages are encrypted with it. Removing someone creates a new epoch with a new key. **Move to workspace…** (⋯ menu or right-click) moves a page and its sub-pages between spaces. Safety codes (hover a member) let two people check that nobody swapped their keys. Not available for desktop files that are not linked to an account.
* **Migration:** Notes from the earlier unencrypted version (in this browser, in old JSON backups, or in an old sync room) are encrypted on import, and the plaintext browser copy is removed.

---

## 4. Data Storage Locations

1. **Postgres on Vercel (the only place notes live):**
   * `cherrion_accounts`: username, the key-wrapped vault header, and SHA-256 hashes of the login and recovery auth keys
   * `cherrion_notes`: one encrypted envelope per note (only id, timestamp and deleted flag are readable)
   * `cherrion_sessions`: hashed session tokens (12 hours)
   * `cherrion_workspaces`, `cherrion_workspace_members`, `cherrion_workspace_invites`, `cherrion_workspace_notes`: workspaces with their encrypted names, each member's role and sealed keys, pending invitations (invite links store only a hash of their secret), and encrypted workspace pages. `cherrion_accounts.public_key` holds each account's workspace public key.
2. **Browser:** nothing but non-secret preferences in `localStorage` (`cherrion_settings_v1`: theme, auto-logout, last username). Decrypted notes exist only in memory while you are logged in.
3. **Manual Backups:** `cherrion-backup-YYYY-MM-DD.json` via **⚙ Settings → ⬇ Export encrypted backup**; only your password or recovery key can open it.
4. **Desktop app:** each vault is one `.cherrion` file wherever you save it (a SQLite database holding the key-wrapped header and the encrypted notes, plus which notes are not yet synced). The app's own folder `%APPDATA%\Cherrion` holds only the recent-files list (`desktop.json`) and window preferences (`WebView\`).

---

## 5. Step-by-Step Setup & Usage Guide

### Step 1: Install
* Install Node.js 22.12 or newer, then run `npm install` in the project folder.

### Step 2: Run Locally
1. `npm run dev`, then open `http://localhost:5173`. The API runs inside the dev server with a **temporary in-memory database** (the login screen warns about it).
2. To use the real database instead: `npm run dev:live` (the local app talks to `https://cherrion-note.vercel.app`), or put `DATABASE_URL=...` in `.env.local` (`vercel env pull .env.local` fetches it).
3. `npm test` runs the unit tests, `npm run typecheck` checks the browser and server code, `npm run build` builds `dist/`.

### Step 3: Deploy to Vercel (cherrion-note.vercel.app)
1. In the Vercel project: **Storage → Create Database → Neon (Postgres)** and connect it to the project. This adds `DATABASE_URL`. Tables are created automatically on the first request.
2. Optional: add an environment variable `CHERRION_SECRET` (any long random string).
3. Deploy (Framework preset **Vite**, build `npm run build`, output `dist`). The `api/` folder becomes serverless functions automatically.

### Step 4: Accounts and Devices
1. Open the site and choose **Create an account**. Start with an empty vault, the vault saved in this browser by an earlier version, or an encrypted backup file. Save the recovery key it shows.
2. On any other device, **Log in** with the same username and password.
3. Forgot the password? **Use your recovery key** on the login screen.
4. Sessions last 12 hours and are renewed automatically while you work. If that isn't possible (for example, the password was changed on another device), Cherrion asks for your password without logging you out, so nothing is lost.
5. Offline: keep the tab open. The status shows **Offline · N unsaved** and the changes are saved when you reconnect (closing the tab first asks for confirmation).
6. Share with others: open the space menu (above the search box) → **New workspace…**, then invite people by username or with an invite link in **Workspace settings…**. Invitations appear in the invitee's space menu with a red badge.

### Step 5: Use Blocks & Sticky Notes
1. Click inside any block and type `/` to insert headings, to-dos, callouts, quotes, code, dividers, pages, field groups, secret fields or 2FA codes.
2. Click **📌 Pin Sticky** and choose a color to add a note to the **📌 Stickies** board.
3. Click **Pop-Out** (best in Chrome/Edge) to float the sticky note above other desktop apps. (Not available in the desktop app yet.)

### Step 6: Desktop App (offline, one file)
**Use it:** download `Cherrion.exe` from the GitHub **Releases** page and run it. No installation is needed.
1. **Create a new vault file**: choose your name, a password, and where to save the `.cherrion` file. Save the recovery key it shows.
2. **Open a vault file**: pick a recent file (or browse) and enter its password. This works offline.
3. **Sync with an online account**:
   - *I already have an account* downloads your web account into a new file that keeps syncing. It opens with your account password.
   - *Create a new account* signs you up and creates the synced file in one step. Use the same username and password on the website or another PC.
   - If the server can't be reached, the message names the server and the cause (name lookup, refused connection, timeout, or a proxy/antivirus breaking HTTPS).
4. **Sync an existing file**: ⚙ Settings → **Online sync** → *Link to my account* (same vault) or *Create an account from this file*. Changes made offline are kept in the file and uploaded when you are back online.
5. 🔒 locks the file (wipes the key and decrypted notes from memory); it also locks after the auto-lock time.
6. **Right-click menus:**
   - On a page in the sidebar: Open, New sub-page, New page here, Rename (F2), Duplicate, Pin/Unpin, Expand/Collapse, Move up/down and Delete.
   - In the page: Cut, Copy, Paste and Select all on text, plus Turn into, Insert below, Duplicate, Move up/down and Delete block.
   - With a page selected in the sidebar, the **Delete** key asks before deleting it, like the toolbar's Delete button (this also works on the website).
7. **Closing the window** asks whether to **hide Cherrion in the tray** (🍒 by the clock; double-click it, or its menu: Open / Lock / Exit) or **exit**. Tick "Don't ask again" to remember, or change it in ⚙ Settings → Vault file. Starting Cherrion again (or double-clicking a `.cherrion` file) brings the running window back instead of opening a second one.
8. **Problems?** The app writes warnings and errors (never note content) to `%APPDATA%\Cherrion\cherrion.log`.
9. **📖 Documentation** (account menu, or the start screen) explains every feature, with keyboard shortcuts and troubleshooting. It's also on the website's login screen.
10. **Double-click to open:** ⚙ Settings → Vault file → *Open .cherrion files with Cherrion*. After that, double-clicking a `.cherrion` file in File Explorer opens Cherrion with that file ready for its password, like `.ctb` files in CherryTree. It's registered for your Windows user only (no admin rights) and follows `Cherrion.exe` if you move it.

**Develop it:**
1. `python -m venv desktop/.venv`, then `desktop\.venv\Scripts\pip install -r desktop/requirements-build.txt`.
2. `npm run desktop` builds the front end (`dist-desktop/`) and opens the app. For live reload: `npm run dev:desktop` in one terminal and `desktop\.venv\Scripts\python desktop/main.py --dev --debug` in another.
3. `npm run test:desktop` runs the vault-file and sync-client tests. `npm run desktop:package` builds `desktop/dist/Cherrion.exe`.

**Release it:** `.github/workflows/build-release.yml` tests and builds `Cherrion.exe` on every push and pull request to `master` and `feature/desktop` (download it from the run's *Artifacts*). Every push to **feature/desktop** also replaces the **`desktop-latest` pre-release** on the Releases page with the new build. To publish a release, push a tag such as `git tag v1.0.1 && git push origin v1.0.1` (the tag sets the exe's version; keep `version` in `package.json` in step); the workflow attaches `Cherrion.exe` and its SHA-256 to a new GitHub Release.

---

### Optional: Save This Report as a File via PowerShell
If you want a standalone document file on your Desktop right away (that opens directly in **Microsoft Word**, **WordPad**, or **Google Docs** without warnings), copy the documentation above into a `.txt`/`.md` file—or run this in PowerShell to save a clean **Word-importable HTML document** (`Cherrion_Documentation.html`) on your Desktop, which you can open in Word/Google Docs and **Save As `.docx`**:

```powershell
$docPath = "$HOME\Desktop\Cherrion_Documentation.html"
@'
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Cherrion Documentation</title>
<style>body{font-family:Calibri,Arial,sans-serif;max-width:800px;margin:40px auto;line-height:1.5;color:#222;}
table{border-collapse:collapse;width:100%;margin:16px 0;}th,td{border:1px solid #ccc;padding:8px;text-align:left;}
th{background:#f3f3f3;}code{background:#f4f4f4;padding:2px 5px;border-radius:3px;}</style>
</head>
<body>
<h1>Cherrion — Project Documentation &amp; Work History</h1>
<p><strong>Architecture:</strong> Local-First Vanilla Web App (HTML/CSS/JS) + Optional Zero-Dependency Node.js Sync Server<br>
<strong>Files:</strong> <code>index.html</code>, <code>styles.css</code>, <code>app.js</code>, <code>sync-server.js</code></p>
<h2>1. Work History</h2>
<table>
<tr><th>Step</th><th>Task</th><th>Outcome</th></tr>
<tr><td>1</td><td>Architecture Design</td><td>Combined CherryTree hierarchy, Notion slash blocks, and Windows Sticky Notes into a zero-framework local-first app.</td></tr>
<tr><td>2</td><td>App Implementation</td><td>Built <code>index.html</code>, <code>styles.css</code>, <code>app.js</code>, and <code>sync-server.js</code> with offline storage, pop-out stickies, and sync.</td></tr>
<tr><td>3</td><td>ZIP Automation</td><td>Provided a Windows PowerShell script to generate all 4 files and package <code>cherrion-notes.zip</code>.</td></tr>
<tr><td>4</td><td>Cloud &amp; Storage Docs</td><td>Documented Google Drive backup workflow, <code>localStorage</code> keys, and <code>sync-data/</code> storage.</td></tr>
</table>
<h2>2. Implemented Features</h2>
<ul>
<li><strong>CherryTree Sidebar:</strong> Infinite parent/child tree, collapse toggles, breadcrumbs, cascading soft-delete, and <code>Ctrl+K</code> search.</li>
<li><strong>Notion Block Editor:</strong> <code>/</code> slash command menu, Markdown shortcuts (<code># </code>, <code>## </code>, <code>[] </code>, <code>&gt; </code>, <code>``` </code>, <code>---</code>), hover reorder/delete controls.</li>
<li><strong>Windows Sticky Notes:</strong> 5 color themes, Sticky Board grid view, and Always-on-Top floating pop-out windows (Document Picture-in-Picture API + popup fallback).</li>
<li><strong>Sync &amp; Backup:</strong> <code>BroadcastChannel</code> tab sync, Node.js Last-Write-Wins sync server (port 3456), and JSON Export/Import merge.</li>
</ul>
<h2>3. Setup &amp; Usage Steps</h2>
<ol>
<li>Create the <code>cherrion-notes</code> folder using the PowerShell script.</li>
<li>Double-click <code>index.html</code> to run offline in Chrome, Edge, or Firefox.</li>
<li>Optionally run <code>node sync-server.js</code> and configure <code>http://localhost:3456</code> in Settings for multi-device sync.</li>
<li>Use <strong>Settings &rarr; Export JSON</strong> to back up into Google Drive.</li>
</ol>
</body>
</html>
'@ | Set-Content -Path $docPath -Encoding UTF8
Write-Host "Saved to $docPath — open in Microsoft Word or Google Docs and Save As .docx"
```