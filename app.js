(() => {
  const STORAGE_KEY = 'cherrion_state_v1';
  const SETTINGS_KEY = 'cherrion_settings_v1';
  const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('cherrion_sync') : null;

  const SLASH_COMMANDS = [
    { type: 'p', label: 'Text', icon: '¶', hint: 'Plain paragraph' },
    { type: 'h1', label: 'Heading 1', icon: 'H1', hint: 'Large section title' },
    { type: 'h2', label: 'Heading 2', icon: 'H2', hint: 'Medium heading' },
    { type: 'todo', label: 'To-do Checkbox', icon: '☑', hint: 'Track tasks' },
    { type: 'callout', label: 'Callout', icon: '💡', hint: 'Highlighted note' },
    { type: 'quote', label: 'Quote', icon: '❝', hint: 'Blockquote' },
    { type: 'code', label: 'Code Block', icon: '<>', hint: 'Monospace snippet' },
    { type: 'divider', label: 'Divider', icon: '―', hint: 'Horizontal line' }
  ];

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const now = () => Date.now();

  let state = loadState();
  let settings = loadSettings();
  let activeNoteId = Object.values(state.notes).find(n => !n.deleted)?.id || null;
  let activeTab = 'tree';
  let searchQuery = '';
  let slashState = { open: false, blockId: null, filter: '', selectedIdx: 0 };
  let syncTimer = null;

  function defaultState() {
    const welcomeId = uid();
    const childId = uid();
    const t = now();
    return {
      notes: {
        [welcomeId]: {
          id: welcomeId, parentId: null, title: 'Welcome to Cherrion', collapsed: false,
          isSticky: true, stickyColor: 'yellow', updatedAt: t, deleted: false,
          blocks: [
            { id: uid(), type: 'h2', content: 'Tree + Blocks + Sticky Notes' },
            { id: uid(), type: 'callout', content: 'Type "/" in an empty block for Notion-style slash commands, or use "# ", "[] ", "> ", "``` " shortcuts!' },
            { id: uid(), type: 'todo', content: 'Click "↗ Pop-Out" above to float this as an always-on-top Sticky Note', checked: false },
            { id: uid(), type: 'todo', content: 'Create nested sub-notes in the CherryTree sidebar on the left', checked: false }
          ]
        },
        [childId]: {
          id: childId, parentId: welcomeId, title: 'Quick Code & Shortcuts', collapsed: false,
          isSticky: false, stickyColor: 'blue', updatedAt: t, deleted: false,
          blocks: [
            { id: uid(), type: 'p', content: 'Nested child note example:' },
            { id: uid(), type: 'code', content: 'node sync-server.js\n# Syncs multiple devices on port 3456' }
          ]
        }
      }
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : defaultState();
    } catch { return defaultState(); }
  }

  function loadSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || { syncUrl: '', syncKey: 'my-personal-notes', dark: false };
    } catch { return { syncUrl: '', syncKey: 'my-personal-notes', dark: false }; }
  }

  function saveState(broadcast = true) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (broadcast && bc) bc.postMessage({ type: 'STATE_UPDATED' });
    scheduleRemoteSync();
  }

  function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }

  if (bc) {
    bc.onmessage = (e) => {
      if (e.data?.type === 'STATE_UPDATED') { state = loadState(); renderAll(); }
    };
  }

  function mergeNotes(remoteNotes) {
    let changed = false;
    for (const [id, rNote] of Object.entries(remoteNotes || {})) {
      const lNote = state.notes[id];
      if (!lNote || rNote.updatedAt > lNote.updatedAt) { state.notes[id] = rNote; changed = true; }
    }
    if (changed) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      if (bc) bc.postMessage({ type: 'STATE_UPDATED' });
      renderAll();
    }
  }

  function scheduleRemoteSync() {
    if (!settings.syncUrl) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncWithServer, 1200);
  }

  async function syncWithServer() {
    const statusEl = document.getElementById('sync-status');
    if (!settings.syncUrl) { statusEl.textContent = '● Local'; statusEl.className = 'sync-status'; return; }
    statusEl.textContent = '↻ Syncing...';
    try {
      const base = settings.syncUrl.replace(/\/+$/, '');
      const res = await fetch(`${base}/sync/${encodeURIComponent(settings.syncKey || 'default')}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: state.notes })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      mergeNotes(data.notes);
      statusEl.textContent = '● Synced'; statusEl.className = 'sync-status ok';
    } catch {
      statusEl.textContent = '● Offline'; statusEl.className = 'sync-status err';
    }
  }

  function getActiveNotes() { return Object.values(state.notes).filter(n => !n.deleted); }
  function getChildren(parentId) {
    return getActiveNotes().filter(n => (n.parentId || null) === parentId).sort((a, b) => a.title.localeCompare(b.title));
  }
  function noteMatchesSearch(note, q) {
    if (!q) return true;
    const low = q.toLowerCase();
    if ((note.title || '').toLowerCase().includes(low)) return true;
    return (note.blocks || []).some(b => (b.content || '').toLowerCase().includes(low));
  }
  function getBreadcrumbs(note) {
    const trail = []; let curr = note; const guard = new Set();
    while (curr && !guard.has(curr.id)) {
      guard.add(curr.id); trail.unshift(curr.title || 'Untitled');
      curr = curr.parentId ? state.notes[curr.parentId] : null;
    }
    return trail.join(' / ');
  }

  function createNote(parentId = null) {
    const id = uid();
    state.notes[id] = {
      id, parentId, title: '', collapsed: false, isSticky: false, stickyColor: 'yellow',
      updatedAt: now(), deleted: false, blocks: [{ id: uid(), type: 'p', content: '' }]
    };
    if (parentId && state.notes[parentId]) state.notes[parentId].collapsed = false;
    activeNoteId = id; activeTab = 'tree';
    saveState(); renderAll(); document.getElementById('note-title').focus();
  }

  function deleteNoteTree(id) {
    const t = now(); const toDelete = [id]; const all = getActiveNotes();
    for (let i = 0; i < toDelete.length; i++) {
      const pid = toDelete[i]; all.filter(n => n.parentId === pid).forEach(c => toDelete.push(c.id));
    }
    toDelete.forEach(nid => { if (state.notes[nid]) { state.notes[nid].deleted = true; state.notes[nid].updatedAt = t; } });
    if (toDelete.includes(activeNoteId)) activeNoteId = getActiveNotes()[0]?.id || null;
    saveState(); renderAll();
  }

  function touchNote(note) { note.updatedAt = now(); saveState(); }

  function renderTree() {
    const container = document.getElementById('tree-container');
    container.innerHTML = '';
    if (searchQuery.trim()) {
      const matches = getActiveNotes().filter(n => noteMatchesSearch(n, searchQuery.trim()));
      if (!matches.length) {
        container.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:13px;">No matches found.</div>';
        return;
      }
      matches.forEach(n => container.appendChild(makeTreeRow(n, 0, false)));
      return;
    }
    function walk(parentId, depth) {
      getChildren(parentId).forEach(note => {
        const sub = getChildren(note.id);
        container.appendChild(makeTreeRow(note, depth, sub.length > 0));
        if (sub.length > 0 && !note.collapsed) walk(note.id, depth + 1);
      });
    }
    walk(null, 0);
  }

  function makeTreeRow(note, depth, hasChildren) {
    const row = document.createElement('div');
    row.className = 'tree-row' + (note.id === activeNoteId ? ' active' : '');
    row.style.paddingLeft = `${8 + depth * 14}px`;

    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';
    toggle.textContent = hasChildren ? (note.collapsed ? '▶' : '▼') : '•';
    toggle.onclick = (e) => {
      e.stopPropagation(); if (!hasChildren) return;
      note.collapsed = !note.collapsed; touchNote(note); renderTree();
    };

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = note.title || 'Untitled';
    row.append(toggle, label);

    if (note.isSticky) {
      const pin = document.createElement('span'); pin.className = 'tree-badge'; pin.textContent = '📌';
      row.appendChild(pin);
    }
    row.onclick = () => { activeNoteId = note.id; activeTab = 'tree'; renderAll(); };
    return row;
  }

  function autoResize(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }

  function renderEditor() {
    const note = activeNoteId ? state.notes[activeNoteId] : null;
    const empty = document.getElementById('empty-state');
    const container = document.getElementById('note-container');
    const actions = document.getElementById('note-actions');
    const crumbs = document.getElementById('breadcrumbs');

    if (!note || note.deleted) {
      empty.classList.remove('hidden'); container.classList.add('hidden');
      actions.classList.add('hidden'); crumbs.textContent = ''; return;
    }

    empty.classList.add('hidden'); container.classList.remove('hidden'); actions.classList.remove('hidden');
    crumbs.textContent = getBreadcrumbs(note);
    document.getElementById('note-title').value = note.title;
    document.getElementById('note-meta').textContent =
      `Updated ${new Date(note.updatedAt).toLocaleString()} • ${note.blocks.length} block(s)`;

    const pinBtn = document.getElementById('btn-pin-sticky');
    pinBtn.classList.toggle('active', !!note.isSticky);
    pinBtn.textContent = note.isSticky ? '📌 Pinned' : '📌 Pin Sticky';
    document.getElementById('sticky-color-select').value = note.stickyColor || 'yellow';

    const blocksEl = document.getElementById('blocks-container');
    blocksEl.innerHTML = '';

    note.blocks.forEach((block, idx) => {
      const row = document.createElement('div');
      row.className = `block-row block-${block.type}` + (block.checked ? ' checked' : '');
      row.dataset.blockId = block.id;

      const ctrls = document.createElement('div');
      ctrls.className = 'block-controls';
      const upBtn = document.createElement('button'); upBtn.className = 'block-ctrl-btn'; upBtn.textContent = '↑'; upBtn.onclick = () => moveBlock(note, idx, -1);
      const downBtn = document.createElement('button'); downBtn.className = 'block-ctrl-btn'; downBtn.textContent = '↓'; downBtn.onclick = () => moveBlock(note, idx, 1);
      const delBtn = document.createElement('button'); delBtn.className = 'block-ctrl-btn'; delBtn.textContent = '✕'; delBtn.onclick = () => removeBlock(note, idx);
      ctrls.append(upBtn, downBtn, delBtn);
      row.appendChild(ctrls);

      const body = document.createElement('div');
      body.className = 'block-body';

      if (block.type === 'divider') {
        const hr = document.createElement('hr'); hr.className = 'block-divider'; body.appendChild(hr);
      } else {
        if (block.type === 'todo') {
          const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!block.checked;
          cb.onchange = () => { block.checked = cb.checked; row.classList.toggle('checked', block.checked); touchNote(note); };
          body.appendChild(cb);
        }
        const ta = document.createElement('textarea');
        ta.className = 'block-input'; ta.rows = 1; ta.value = block.content || '';
        ta.placeholder = block.type === 'p' ? "Type '/' for commands..." : `${block.type.toUpperCase()}...`;
        ta.addEventListener('input', () => {
          block.content = ta.value; autoResize(ta);
          checkMarkdownShortcuts(note, block, ta); checkSlashMenu(block, ta); touchNote(note);
        });
        ta.addEventListener('keydown', (e) => handleBlockKeydown(e, note, block, idx, ta));
        body.appendChild(ta);
        requestAnimationFrame(() => autoResize(ta));
      }
      row.appendChild(body);
      blocksEl.appendChild(row);
    });
  }

  function checkMarkdownShortcuts(note, block, ta) {
    if (block.type !== 'p') return;
    const v = ta.value;
    const map = [
      { prefix: '# ', type: 'h1' }, { prefix: '## ', type: 'h2' },
      { prefix: '[] ', type: 'todo' }, { prefix: '[ ] ', type: 'todo' },
      { prefix: '> ', type: 'quote' }, { prefix: '``` ', type: 'code' }
    ];
    for (const m of map) {
      if (v.startsWith(m.prefix)) {
        block.type = m.type; block.content = v.slice(m.prefix.length);
        touchNote(note); renderEditor(); focusBlock(block.id); return;
      }
    }
    if (v === '---') {
      block.type = 'divider'; block.content = '';
      const next = { id: uid(), type: 'p', content: '' };
      const idx = note.blocks.findIndex(b => b.id === block.id);
      note.blocks.splice(idx + 1, 0, next);
      touchNote(note); renderEditor(); focusBlock(next.id);
    }
  }

  function handleBlockKeydown(e, note, block, idx, ta) {
    if (slashState.open && slashState.blockId === block.id) {
      const items = getFilteredSlashItems();
      if (e.key === 'ArrowDown') { e.preventDefault(); slashState.selectedIdx = (slashState.selectedIdx + 1) % Math.max(items.length, 1); renderSlashMenu(ta); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashState.selectedIdx = (slashState.selectedIdx - 1 + items.length) % Math.max(items.length, 1); renderSlashMenu(ta); return; }
      if (e.key === 'Enter' && items.length) { e.preventDefault(); applySlashCommand(note, block, items[slashState.selectedIdx].type); return; }
      if (e.key === 'Escape') { closeSlashMenu(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && (block.type !== 'code' || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const nextType = block.type === 'todo' && block.content.trim() !== '' ? 'todo' : 'p';
      const newBlock = { id: uid(), type: nextType, content: '', checked: false };
      note.blocks.splice(idx + 1, 0, newBlock);
      touchNote(note); renderEditor(); focusBlock(newBlock.id); return;
    }
    if (e.key === 'Backspace' && ta.value === '' && note.blocks.length > 1) {
      e.preventDefault();
      if (block.type !== 'p') {
        block.type = 'p'; touchNote(note); renderEditor(); focusBlock(block.id);
      } else {
        const prev = note.blocks[idx - 1];
        note.blocks.splice(idx, 1); touchNote(note); renderEditor();
        if (prev) focusBlock(prev.id, true);
      }
      return;
    }
    if (e.key === 'ArrowUp' && ta.selectionStart === 0 && idx > 0) {
      e.preventDefault(); focusBlock(note.blocks[idx - 1].id, true);
    } else if (e.key === 'ArrowDown' && ta.selectionEnd === ta.value.length && idx < note.blocks.length - 1) {
      e.preventDefault(); focusBlock(note.blocks[idx + 1].id);
    }
  }

  function focusBlock(blockId, atEnd = false) {
    requestAnimationFrame(() => {
      const ta = document.querySelector(`[data-block-id="${blockId}"] .block-input`);
      if (!ta) return; ta.focus();
      const pos = atEnd ? ta.value.length : 0; ta.setSelectionRange(pos, pos);
    });
  }

  function moveBlock(note, idx, dir) {
    const target = idx + dir;
    if (target < 0 || target >= note.blocks.length) return;
    const [b] = note.blocks.splice(idx, 1); note.blocks.splice(target, 0, b);
    touchNote(note); renderEditor();
  }

  function removeBlock(note, idx) {
    if (note.blocks.length <= 1) note.blocks[0] = { id: uid(), type: 'p', content: '' };
    else note.blocks.splice(idx, 1);
    touchNote(note); renderEditor();
  }

  function checkSlashMenu(block, ta) {
    if (ta.value.startsWith('/')) {
      slashState = { open: true, blockId: block.id, filter: ta.value.slice(1).toLowerCase(), selectedIdx: 0 };
      renderSlashMenu(ta);
    } else if (slashState.open && slashState.blockId === block.id) closeSlashMenu();
  }

  function getFilteredSlashItems() {
    return SLASH_COMMANDS.filter(c => c.label.toLowerCase().includes(slashState.filter) || c.type.includes(slashState.filter));
  }

  function renderSlashMenu(ta) {
    const menu = document.getElementById('slash-menu');
    const items = getFilteredSlashItems();
    if (!items.length) { closeSlashMenu(); return; }
    const rect = ta.getBoundingClientRect();
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 280)}px`;
    menu.innerHTML = '';
    const note = state.notes[activeNoteId];
    const block = note?.blocks.find(b => b.id === slashState.blockId);
    items.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'slash-item' + (i === slashState.selectedIdx ? ' selected' : '');
      el.innerHTML = `<span style="width:22px;text-align:center">${item.icon}</span><div><strong>${item.label}</strong><div style="font-size:11px;color:var(--text-muted)">${item.hint}</div></div>`;
      el.onmousedown = (e) => { e.preventDefault(); if (note && block) applySlashCommand(note, block, item.type); };
      menu.appendChild(el);
    });
    menu.classList.remove('hidden');
  }

  function applySlashCommand(note, block, type) {
    block.type = type; block.content = '';
    if (type === 'divider') {
      const idx = note.blocks.findIndex(b => b.id === block.id);
      const next = { id: uid(), type: 'p', content: '' };
      note.blocks.splice(idx + 1, 0, next);
      closeSlashMenu(); touchNote(note); renderEditor(); focusBlock(next.id); return;
    }
    closeSlashMenu(); touchNote(note); renderEditor(); focusBlock(block.id);
  }

  function closeSlashMenu() { slashState.open = false; document.getElementById('slash-menu').classList.add('hidden'); }

  function noteToPlainText(note) {
    return (note.blocks || []).map(b => (b.type === 'todo' ? `${b.checked ? '[x]' : '[ ]'} ${b.content}` : b.content)).join('\n');
  }
  function plainTextToBlocks(text) {
    return text.split('\n').map(line => {
      if (line.startsWith('[x] ')) return { id: uid(), type: 'todo', checked: true, content: line.slice(4) };
      if (line.startsWith('[ ] ')) return { id: uid(), type: 'todo', checked: false, content: line.slice(4) };
      return { id: uid(), type: 'p', content: line };
    });
  }

  function renderStickyBoard() {
    const stickies = getActiveNotes().filter(n => n.isSticky);
    document.getElementById('sticky-count').textContent = stickies.length;
    const grid = document.getElementById('sticky-grid');
    grid.innerHTML = '';
    if (!stickies.length) {
      grid.innerHTML = '<p style="color:var(--text-muted)">No pinned stickies yet. Open any note and click "📌 Pin Sticky".</p>';
      return;
    }
    stickies.forEach(note => {
      const card = document.createElement('div');
      card.className = `sticky-card sticky-${note.stickyColor || 'yellow'}`;
      const head = document.createElement('div'); head.className = 'sticky-card-head';
      const title = document.createElement('input'); title.className = 'sticky-card-title'; title.value = note.title || 'Untitled';
      title.onchange = () => { note.title = title.value; touchNote(note); renderTree(); };
      const popBtn = document.createElement('button'); popBtn.className = 'sticky-mini'; popBtn.textContent = '↗ Pop-Out';
      popBtn.onclick = () => openFloatingSticky(note.id);
      head.append(title, popBtn);

      const body = document.createElement('textarea'); body.className = 'sticky-card-body'; body.value = noteToPlainText(note);
      body.addEventListener('input', () => { note.blocks = plainTextToBlocks(body.value); touchNote(note); });

      const foot = document.createElement('div'); foot.className = 'sticky-card-foot';
      const openBtn = document.createElement('button'); openBtn.className = 'sticky-mini'; openBtn.textContent = 'Open in Editor';
      openBtn.onclick = () => { activeNoteId = note.id; activeTab = 'tree'; renderAll(); };
      const unpinBtn = document.createElement('button'); unpinBtn.className = 'sticky-mini'; unpinBtn.textContent = 'Unpin';
      unpinBtn.onclick = () => { note.isSticky = false; touchNote(note); renderAll(); };
      foot.append(openBtn, unpinBtn);
      card.append(head, body, foot); grid.appendChild(card);
    });
  }

  async function openFloatingSticky(noteId) {
    const note = state.notes[noteId]; if (!note) return;
    note.isSticky = true; touchNote(note); renderAll();
    let win;
    if ('documentPictureInPicture' in window) win = await window.documentPictureInPicture.requestWindow({ width: 320, height: 360 });
    else win = window.open('', `sticky_${noteId}`, 'width=320,height=360,resizable=yes');
    if (!win) return alert('Popup blocked - please allow popups for floating sticky notes.');

    const colors = { yellow: '#fff7b1', blue: '#cde9ff', green: '#d2f8d2', pink: '#ffd6e7', purple: '#e6d6ff' };
    const bg = colors[note.stickyColor || 'yellow'];
    win.document.body.innerHTML = '';
    win.document.title = `📌 ${note.title || 'Sticky Note'}`;
    win.document.body.style.cssText = `margin:0;padding:12px;background:${bg};font-family:sans-serif;display:flex;flex-direction:column;height:100vh;box-sizing:border-box;`;

    const titleInput = win.document.createElement('input');
    titleInput.value = note.title || ''; titleInput.placeholder = 'Sticky Title';
    titleInput.style.cssText = 'border:none;background:transparent;font-weight:700;font-size:16px;outline:none;margin-bottom:8px;color:#222;';
    const area = win.document.createElement('textarea');
    area.value = noteToPlainText(note); area.placeholder = 'Jot quick thoughts...';
    area.style.cssText = 'flex:1;border:none;background:transparent;resize:none;outline:none;font-family:inherit;font-size:14px;line-height:1.5;color:#222;';

    titleInput.addEventListener('input', () => { note.title = titleInput.value; win.document.title = `📌 ${note.title || 'Sticky Note'}`; touchNote(note); renderTree(); });
    area.addEventListener('input', () => { note.blocks = plainTextToBlocks(area.value); touchNote(note); if (activeNoteId === note.id) renderEditor(); });
    win.document.body.append(titleInput, area);
  }

  function renderTabs() {
    const isTree = activeTab === 'tree';
    document.getElementById('tab-tree').classList.toggle('active', isTree);
    document.getElementById('tab-stickies').classList.toggle('active', !isTree);
    document.getElementById('editor-view').classList.toggle('hidden', !isTree);
    document.getElementById('sticky-board-view').classList.toggle('hidden', isTree);
  }

  function renderAll() {
    document.body.classList.toggle('dark', !!settings.dark);
    renderTabs(); renderTree(); renderEditor(); renderStickyBoard();
  }

  document.getElementById('btn-new-root').onclick = () => createNote(null);
  document.getElementById('btn-empty-create').onclick = () => createNote(null);
  document.getElementById('btn-add-child').onclick = () => activeNoteId && createNote(activeNoteId);
  document.getElementById('btn-delete-note').onclick = () => { if (activeNoteId && confirm('Delete this note and its sub-notes?')) deleteNoteTree(activeNoteId); };
  document.getElementById('btn-theme').onclick = () => { settings.dark = !settings.dark; saveSettings(); renderAll(); };
  document.getElementById('tab-tree').onclick = () => { activeTab = 'tree'; renderAll(); };
  document.getElementById('tab-stickies').onclick = () => { activeTab = 'stickies'; renderAll(); };
  document.getElementById('search-input').addEventListener('input', (e) => { searchQuery = e.target.value; renderTree(); });
  document.getElementById('note-title').addEventListener('input', (e) => {
    const note = state.notes[activeNoteId]; if (!note) return;
    note.title = e.target.value; touchNote(note); renderTree();
  });
  document.getElementById('btn-add-block').onclick = () => {
    const note = state.notes[activeNoteId]; if (!note) return;
    const b = { id: uid(), type: 'p', content: '' }; note.blocks.push(b); touchNote(note); renderEditor(); focusBlock(b.id);
  };
  document.getElementById('btn-pin-sticky').onclick = () => {
    const note = state.notes[activeNoteId]; if (!note) return;
    note.isSticky = !note.isSticky; touchNote(note); renderAll();
  };
  document.getElementById('sticky-color-select').onchange = (e) => {
    const note = state.notes[activeNoteId]; if (!note) return;
    note.stickyColor = e.target.value; touchNote(note); renderStickyBoard();
  };
  document.getElementById('btn-popout').onclick = () => activeNoteId && openFloatingSticky(activeNoteId);
  document.getElementById('btn-sync-now').onclick = syncWithServer;

  const modal = document.getElementById('settings-modal');
  document.getElementById('btn-settings').onclick = () => {
    document.getElementById('input-sync-url').value = settings.syncUrl || '';
    document.getElementById('input-sync-key').value = settings.syncKey || 'my-personal-notes';
    modal.classList.remove('hidden');
  };
  document.getElementById('btn-close-settings').onclick = () => modal.classList.add('hidden');
  document.getElementById('btn-save-settings').onclick = () => {
    settings.syncUrl = document.getElementById('input-sync-url').value.trim();
    settings.syncKey = document.getElementById('input-sync-key').value.trim() || 'my-personal-notes';
    saveSettings(); modal.classList.add('hidden'); syncWithServer();
  };
  document.getElementById('btn-export-json').onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `cherrion-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  };
  document.getElementById('input-import-json').onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { mergeNotes(JSON.parse(reader.result).notes); alert('Notes merged successfully!'); }
      catch { alert('Invalid JSON backup file.'); }
    };
    reader.readAsText(file);
  };

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); document.getElementById('search-input').focus(); }
  });

  renderAll();
  if (settings.syncUrl) syncWithServer();
})();
