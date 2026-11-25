Below is the **complete, structured project documentation** formatted so you can copy it directly into **Microsoft Word** or **Google Docs** (paste it in and click **File → Save As / Download → Microsoft Word (.docx)**). At the end, I’ve also included a quick PowerShell command if you want to save this report directly to your Desktop as a `.rtf` document (which opens cleanly in Word, LibreOffice, and Google Docs).

---

# Cherrion — Project Documentation & Work History

**Project Name:** Cherrion (CherryTree + Notion + Windows Sticky Notes)  
**Architecture:** Local-First Vanilla Web App (HTML/CSS/JS) + Optional Zero-Dependency Node.js Sync Server  
**Deliverables Created:** `index.html`, `styles.css`, `app.js`, `sync-server.js`

---

## 1. Work History (Session Log)

| Step | Task | Outcome |
| :--- | :--- | :--- |
| **1** | **Requirements Analysis & Architecture Design** | Merged features from CherryTree (tree hierarchy), Notion (slash-command blocks), and Windows Sticky Notes (pinned board & floating windows) into a lightweight, zero-framework codebase. |
| **2** | **Core Application Implementation** | Built the full 4-file application (`index.html`, `styles.css`, `app.js`, `sync-server.js`) with offline storage, cross-tab sync, block editing, sticky pop-outs, and server sync. |
| **3** | **Packaging Automation** | Provided a single-command Windows PowerShell script to generate the `cherrion-notes` project folder and package it into `cherrion-notes.zip` on the Desktop. |
| **4** | **Cloud Storage & Backup Guidance** | Documented how to upload the package to Google Drive and use JSON export/import with Google Drive for Desktop. |
| **5** | **Data Persistence Documentation** | Detailed all three data storage locations (`localStorage`, `sync-data/` folder, and JSON exports) along with browser storage caveats. |

---

## 2. Design Principles Followed

1. **Lightweight & Zero-Bloat:** Built with pure vanilla HTML5, CSS3, and ES6+ JavaScript—no React, Webpack, or `npm install` required.
2. **Maintainable Modular Structure:** Separated structure (`index.html`), theming/layout (`styles.css`), application logic (`app.js`), and remote sync (`sync-server.js`) into clean, readable files.
3. **Local-First Reliability:** Every edit saves immediately to local browser storage so the app works 100% offline with zero latency.
4. **Conflict-Safe Syncing:** Uses per-note timestamps (`updatedAt`) and soft-delete flags (`deleted: true` tombstones) so offline edits across devices merge using Last-Write-Wins without resurrecting deleted notes.
5. **Predictable Block Editing:** Uses auto-resizing `<textarea>` elements instead of `contenteditable` to prevent cross-browser cursor glitches and messy HTML paste behavior.

---

## 3. What Was Implemented

### A. CherryTree-Style Hierarchy (`app.js`, `styles.css`)
* Infinite nested parent/child note tree in the left sidebar.
* Expand/collapse toggles (`▶` / `▼`) persisted per note.
* Breadcrumb navigation trail in the top bar (e.g., `Welcome / Quick Code & Shortcuts`).
* Real-time search across note titles and all block contents (`Ctrl + K` / `Cmd + K` shortcut).
* Cascading soft-delete for parent notes and their child sub-notes.

### B. Notion-Style Block Editor (`app.js`, `styles.css`)
* **Supported Block Types:** Paragraph (`p`), Heading 1 (`h1`), Heading 2 (`h2`), To-do Checkbox (`todo`), Callout (`callout`), Quote (`quote`), Code Block (`code`), and Divider (`divider`).
* **Slash Command Menu (`/`):** Typing `/` opens a filterable command menu navigable via `ArrowUp`, `ArrowDown`, `Enter`, `Escape`, or mouse click.
* **Markdown Shortcuts:** Auto-converts `# `, `## `, `[] ` / `[ ] `, `> `, ```` ```  ````, and `---` into structured blocks.
* **Keyboard & Hover Controls:** `Enter` creates a block below, `Backspace` on an empty block removes/resets it, `ArrowUp`/`ArrowDown` moves between blocks, plus hover buttons (`↑`, `↓`, `✕`) to reorder or delete blocks.

### C. Windows Sticky Notes Integration (`app.js`, `styles.css`)
* **Pin & Color Coding:** Any note can be pinned as a Sticky Note with 5 color themes (`yellow`, `blue`, `green`, `pink`, `purple`).
* **Sticky Board View:** Dedicated tab (`📌 Stickies`) displaying all pinned notes as editable desktop-style cards.
* **Always-on-Top Pop-Out Windows:** Clicking `↗ Pop-Out` opens a floating sticky note window via the **Document Picture-in-Picture API** (stays above all other OS windows in Chrome/Edge), with `window.open` popup fallback in other browsers.
* **Live Synchronization:** Edits inside a floating sticky note sync immediately back to the main tree and editor.

### D. Sync, Theme & Backup (`app.js`, `sync-server.js`)
* **Instant Multi-Tab Sync:** Uses `BroadcastChannel` (`cherrion_sync`) to keep open tabs synchronized.
* **Self-Hosted Sync Server (`sync-server.js`):** ~45-line Node.js HTTP server (`PORT 3456`) with CORS enabled and room-based JSON persistence (`POST /sync/:room`).
* **Dark / Light Mode:** CSS-variable theme switcher (`🌓`) persisted in settings.
* **Portable Backups:** Export full workspace to `.json` and import/merge `.json` backups without overwriting newer notes.

---

## 4. Data Storage Locations

1. **Browser `localStorage` (Primary):**
   * Notes & tree state: `cherrion_state_v1`
   * User preferences & sync config: `cherrion_settings_v1`
2. **Optional Sync Server Folder:**
   * Saved on disk as `cherrion-notes/sync-data/<room-key>.json`
3. **Manual Backups:**
   * Downloaded as `cherrion-backup-YYYY-MM-DD.json` via **⚙ Settings → ⬇ Export JSON**

---

## 5. Step-by-Step Setup & Usage Guide

### Step 1: Create the Project Files
* Run the provided PowerShell script (creates `Desktop\cherrion-notes\` and `Desktop\cherrion-notes.zip`), **or** create a folder containing `index.html`, `styles.css`, `app.js`, and `sync-server.js`.

### Step 2: Launch Locally (Offline Mode)
1. Open the `cherrion-notes` folder.
2. Double-click `index.html` to open it in Chrome, Edge, or Firefox.
3. Click **＋** to create root notes, **↳ Sub-note** for nested child notes, or press `Ctrl + K` to search.

### Step 3: Use Blocks & Sticky Notes
1. Click inside any block and type `/` to insert Headings, To-do lists, Callouts, Quotes, Code blocks, or Dividers.
2. Click **📌 Pin Sticky** and choose a color to add a note to the **📌 Stickies** board.
3. Click **↗ Pop-Out** (best in Chrome/Edge) to float the sticky note above other desktop apps.

### Step 4: Enable Multi-Device Sync (Optional)
1. Ensure Node.js is installed, then open a terminal inside `cherrion-notes` and run:
   ```bash
   node sync-server.js
   ```
2. In the app, click **⚙ Settings**, set **Sync Server URL** to `http://localhost:3456` (or your server/LAN IP), enter a **Sync Room Key**, and click **Save & Sync**.

### Step 5: Backup or Sync via Google Drive (Zero-Server Option)
1. Click **⚙ Settings → ⬇ Export JSON**.
2. Save the `.json` file into your **Google Drive** (web upload or Google Drive for Desktop folder).
3. On another device, click **⚙ Settings → ⬆ Import JSON** to merge changes.

### Step 6: Optional Native Desktop App Upgrade
* To turn this folder into a ~5 MB native Windows/Mac/Linux app with system tray support, initialize a **Tauri** project (`npm create tauri-app`) and point `frontendDist` to the `cherrion-notes` directory.

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