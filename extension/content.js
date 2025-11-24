const SERVER_ENDPOINT = "http://localhost:5000/notes";
const BACKEND_BASE = SERVER_ENDPOINT.replace(/\/?notes\/?$/, "");
const DOCK_STORAGE_KEY = "noteDockPos:v1";
const DOCK_HIDDEN_KEY = "noteDockHidden:v1";
const FIRECRAWL_BASE = "http://localhost:8010";
const SCRAPE_ENDPOINT = `${BACKEND_BASE}/scrape-website`;
const CRAWL_ENDPOINT = `${BACKEND_BASE}/crawl-website`;
const SUMMARIZE_TEXT_ENDPOINT = `${BACKEND_BASE}/summarize/text`;
const SEMANTIC_SEARCH_ENDPOINT = `${BACKEND_BASE}/search/semantic`;
const WIDGET_ID = "note-taker-widget"; // selection toolbar id
const DOCK_ID = "note-taker-dock"; // persistent dock id
const CMD_ID = "note-cmd"; // command palette id
const TOAST_ID = "note-taker-toast";
const STYLE_ID = "note-widget-style";
const REVEAL_ID = "note-dock-reveal";
const DRAFT_STORAGE_KEY = `noteDraft:${location.host}`;
const QUICK_COPY_KEY = "noteQuickCopy:v1"; // auto-save copied text pref
const SAVE_TARGET_KEY = "noteSaveTarget:v1"; // 'doc' or 'note'
const AGENT_INGEST_TEXT = `${BACKEND_BASE}/agent/ingest-text`;
const AGENT_INGEST_URL = `${BACKEND_BASE}/agent/ingest-url`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const link = document.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("widget.css");
  document.head.appendChild(link);
}

function removeWidget() {
  const existing = document.getElementById(WIDGET_ID);
  if (existing) {
    existing.remove();
  }
}

function ensureRevealTab(side) {
  if (document.getElementById(REVEAL_ID)) return;
  injectStyles();
  const tab = document.createElement('div');
  tab.id = REVEAL_ID;
  tab.className = 'note-reveal';
  if (side === 'left') tab.classList.add('note-reveal--left');
  tab.innerHTML = `<span class="note-reveal__icon">✶</span>`;
  tab.title = 'Show Notes (Alt+N)';
  tab.addEventListener('click', () => {
    try { localStorage.removeItem(DOCK_HIDDEN_KEY); } catch (_) {}
    const dock = document.getElementById(DOCK_ID);
    if (dock) dock.classList.remove('note-dock--hidden'); else ensureDock();
    removeRevealTab();
  });
  document.body.appendChild(tab);
}

function removeRevealTab(){
  const t = document.getElementById(REVEAL_ID);
  if (t) t.remove();
}

function ensureDock() {
  if (document.getElementById(DOCK_ID)) return;
  injectStyles();

  const dock = document.createElement("div");
  dock.id = DOCK_ID;
  dock.className = "note-dock note-dock--compact";
  dock.innerHTML = `
    <div class="note-dock__header" title="Drag to move">
      <span class="note-dock__logo">✶</span>
      <span class="note-dock__title">Notes</span>
      <button class="note-dock__toggle" aria-label="Expand">▸</button>
      <button class="note-dock__close" aria-label="Hide">✕</button>
    </div>
    <div class="note-dock__quickbar">
      <button class="note-btn note-btn--icon" data-action="save-selection" title="Save selection (S)">💾</button>
      <button class="note-btn note-btn--icon" data-action="highlight" title="Highlight (H)">🖍️</button>
      <button class="note-btn note-btn--icon" data-action="copy" title="Copy selection (C)">📋</button>
      <button class="note-btn note-btn--icon" data-action="scrape" title="Scrape page (Alt+P)">🕷️</button>
      <button class="note-btn note-btn--icon" data-action="crawl" title="Crawl site (Alt+C)">🌐</button>
      <button class="note-btn note-btn--icon" data-action="paste-save" title="Paste & save (Alt+V)">📥</button>
      <button class="note-btn note-btn--icon" data-action="palette" title="Command palette (Alt+K)">⌘</button>
    </div>
    <div class="note-dock__progress" aria-live="polite">
      <div class="note-progress"><div class="note-progress__fill"></div></div>
      <span class="note-progress__text">Starting…</span>
    </div>
    <div class="note-dock__body">
      <textarea class="note-dock__textarea" rows="4" placeholder="Quick note... (Cmd/Ctrl+Enter to save)"></textarea>
      <div class="note-dock__actions">
        <div class="note-dock__meta">
          <button class="note-dock__side-toggle" data-action="toggle-side" title="Pin left/right">⇆</button>
          <span class="note-dock__context" title="Site">${location.hostname}</span>
          <label class="note-dock__opt"><input type="checkbox" class="note-dock__include-url" checked> URL</label>
          <label class="note-dock__opt"><input type="checkbox" class="note-dock__savedoc"> AI ingest</label>
          <label class="note-dock__opt"><input type="checkbox" class="note-dock__quickcopy"> Auto‑save copy</label>
          <span class="note-dock__counter" aria-live="polite">0</span>
        </div>
        <div>
          <button class="note-btn" data-action="summarize-note" title="Summarize note">🧠 Summarize</button>
          <button class="note-btn note-btn--ghost" data-action="cancel">Cancel</button>
          <button class="note-btn note-btn--primary" data-action="save-note">Save</button>
        </div>
      </div>
    </div>
  `;

  // Restore last position/side
  try {
    const saved = JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) || "null");
    if (saved && typeof saved.top === 'number') {
      dock.style.top = `${saved.top}px`;
    }
    if (saved && saved.side === 'left') {
      dock.classList.add('note-dock--left');
    }
  } catch (_) { /* ignore */ }

  // Drag to reposition (vertical + horizontal snap)
  let dragging = false;
  let startY = 0;
  let startTop = 0;
  let startX = 0;
  let startLeft = 0;
  const header = dock.querySelector('.note-dock__header');
  header.addEventListener('mousedown', (e) => {
    if ((e.target).classList && (e.target).classList.contains('note-dock__toggle')) return;
    dragging = true;
    startY = e.clientY;
    startTop = dock.getBoundingClientRect().top;
    startX = e.clientX;
    startLeft = dock.getBoundingClientRect().left;
    document.body.classList.add('note-dock--dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    let newTop = Math.max(8, startTop + dy);
    const maxTop = window.innerHeight - dock.offsetHeight - 8;
    newTop = Math.min(maxTop, newTop);
    dock.style.top = `${newTop}px`;
    // preview side switch if moved near left edge
    const dx = e.clientX - startX;
    const newLeft = startLeft + dx;
    const nearLeft = newLeft < window.innerWidth / 2;
    dock.classList.toggle('note-dock--left', nearLeft);
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    document.body.classList.remove('note-dock--dragging');
    // persist position and side
    const rect = dock.getBoundingClientRect();
    const side = dock.classList.contains('note-dock--left') ? 'left' : 'right';
    try { localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify({top: rect.top, side})); } catch (_) {}
  });

  // Toggle minimize/maximize
  const toggleBtn = dock.querySelector('.note-dock__toggle');
  const closeBtn = dock.querySelector('.note-dock__close');
  toggleBtn.addEventListener('click', () => {
    const isMinimized = dock.classList.contains('note-dock--minimized');
    if (isMinimized) {
      // Maximize
      dock.classList.remove('note-dock--minimized');
      dock.classList.remove('note-dock--compact');
      toggleBtn.textContent = '▾';
      toggleBtn.setAttribute('aria-label', 'Minimize');
    } else {
      // Minimize
      dock.classList.add('note-dock--minimized');
      dock.classList.add('note-dock--compact');
      toggleBtn.textContent = '▸';
      toggleBtn.setAttribute('aria-label', 'Maximize');
    }
  });

  function setHidden(hidden){
    if (hidden) {
      dock.classList.add('note-dock--hidden');
      try { localStorage.setItem(DOCK_HIDDEN_KEY, '1'); } catch (_) {}
      const side = dock.classList.contains('note-dock--left') ? 'left' : 'right';
      ensureRevealTab(side);
      showToast('Hidden — press Alt+N to show');
    } else {
      dock.classList.remove('note-dock--hidden');
      try { localStorage.removeItem(DOCK_HIDDEN_KEY); } catch (_) {}
      removeRevealTab();
    }
  }
  if (closeBtn) closeBtn.addEventListener('click', () => setHidden(true));

  // Button actions
  const counterEl = dock.querySelector('.note-dock__counter');
  const textarea = dock.querySelector('.note-dock__textarea');
  const sideToggle = dock.querySelector('[data-action="toggle-side"]');
  const includeUrlEl = dock.querySelector('.note-dock__include-url');
  const saveDocEl = dock.querySelector('.note-dock__savedoc');
  const quickCopyEl = dock.querySelector('.note-dock__quickcopy');
  const progressWrap = dock.querySelector('.note-dock__progress');
  const progressFill = dock.querySelector('.note-progress__fill');
  const progressText = dock.querySelector('.note-progress__text');

  // expose progress for global shortcuts
  dock._progress = { wrap: progressWrap, fill: progressFill, text: progressText };

  // Load persisted draft
  try {
    const draft = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (draft) textarea.value = draft;
  } catch (_) {}

  // counter + autoresize
  function updateCounter(){
    const count = (textarea.value || '').length;
    if(counterEl) counterEl.textContent = String(count);
    textarea.style.height = 'auto';
    const h = Math.min(220, Math.max(80, textarea.scrollHeight));
    textarea.style.height = h + 'px';
  }
  textarea.addEventListener('input', () => {
    updateCounter();
    try { localStorage.setItem(DRAFT_STORAGE_KEY, textarea.value); } catch (_) {}
  });
  updateCounter();

  // Quick copy setting
  try {
    const val = localStorage.getItem(QUICK_COPY_KEY);
    if (val === '1' && quickCopyEl) quickCopyEl.checked = true;
  } catch (_) {}
  if (quickCopyEl) quickCopyEl.addEventListener('change', () => {
    try { localStorage.setItem(QUICK_COPY_KEY, quickCopyEl.checked ? '1' : '0'); } catch (_) {}
    showToast(quickCopyEl.checked ? 'Auto‑save on Copy enabled' : 'Auto‑save on Copy disabled');
  });

  // side toggle button
  if (sideToggle) sideToggle.addEventListener('click', () => {
    dock.classList.toggle('note-dock--left');
    const rect = dock.getBoundingClientRect();
    const side = dock.classList.contains('note-dock--left') ? 'left' : 'right';
    try { localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify({top: rect.top, side})); } catch (_) {}
    // if hidden, update reveal tab side
    if (dock.classList.contains('note-dock--hidden')) {
      removeRevealTab();
      ensureRevealTab(side);
    }
  });

  dock.addEventListener('click', async (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const action = target.getAttribute('data-action');
    if (!action) return;
    if (action === 'save-note') {
      const text = textarea.value.trim();
      if (!text) return showToast('Write something first');
      const btn = target.closest('button');
      if (btn) btn.classList.add('note-btn--loading');
      const include = includeUrlEl ? includeUrlEl.checked : true;
      await smartSave(text, include);
      textarea.value = '';
      updateCounter();
      try { localStorage.removeItem(DRAFT_STORAGE_KEY); } catch (_) {}
      showToast('Saved');
      if (btn) btn.classList.remove('note-btn--loading');
    } else if (action === 'cancel') {
      textarea.value = '';
      updateCounter();
      try { localStorage.removeItem(DRAFT_STORAGE_KEY); } catch (_) {}
    } else if (action === 'scrape') {
      const btn = target.closest('button');
      if (btn) btn.classList.add('note-btn--loading');
      await scrapePageToDocs();
      if (btn) btn.classList.remove('note-btn--loading');
    } else if (action === 'crawl') {
      const btn = target.closest('button');
      if (btn) btn.classList.add('note-btn--loading');
      await crawlSite(progressWrap, progressFill, progressText);
      if (btn) btn.classList.remove('note-btn--loading');
    } else if (action === 'save-selection') {
      const selected = (window.getSelection()?.toString() || '').trim();
      if (!selected) return showToast('No selection');
      const btn = target.closest('button');
      if (btn) btn.classList.add('note-btn--loading');
      await smartSave(selected, true);
      if (btn) btn.classList.remove('note-btn--loading');
      showToast('Selection saved');
    } else if (action === 'copy') {
      copySelection();
    } else if (action === 'highlight') {
      highlightSelection();
    } else if (action === 'paste-save') {
      try {
        const clip = await navigator.clipboard.readText();
        const text = (clip || '').trim();
        if (!text) return showToast('Clipboard is empty');
        await safeSave(text, true);
        showToast('Saved from clipboard');
      } catch (err) {
        showToast('Clipboard read blocked');
      }
    } else if (action === 'palette') {
      showCommandPalette();
    } else if (action === 'summarize-note') {
      const t = (textarea.value||'').trim(); if(!t) return showToast('Write something first'); summarizeText(t);
    }
  });

  document.body.appendChild(dock);

  // Position initially mid-right and visible immediately
  if (!dock.style.top) {
    dock.style.top = `${Math.round(window.innerHeight / 2 - 60)}px`;
  }
}

function positionWidget(widget, rect) {
  const offsetTop = rect.bottom + window.scrollY + 8;
  const offsetLeft = rect.left + window.scrollX;
  widget.style.top = `${offsetTop}px`;

  const maxLeft = document.documentElement.clientWidth - widget.offsetWidth - 16;
  widget.style.left = `${Math.min(Math.max(8, offsetLeft), Math.max(8, maxLeft))}px`;
}

async function sendNote(text, includeUrl = true) {
  const payload = {
    text,
    source_url: includeUrl ? window.location.href : null,
    metadata: {
      page_title: document.title,
      captured_at: new Date().toISOString(),
    },
  };

  const response = await fetch(SERVER_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    mode: "cors",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Failed to save note");
  }

  return response.json();
}

async function safeSave(text, includeUrl = true) {
  try {
    await sendNote(text, includeUrl);
  } catch (e) {
    showToast(e?.message || 'Failed to save');
  }
}

async function sendIngest(text) {
  const payload = {
    text,
    source_url: window.location.href,
    title: document.title || null,
    content_type: 'web',
    lang: document.documentElement.lang || null,
    chunk_size: 1000,
    chunk_overlap: 150,
  };
  const res = await fetch(AGENT_INGEST_TEXT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    mode: 'cors',
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || 'Ingest failed');
  }
  return res.json();
}

async function smartSave(text, includeUrl = true) {
  // Decide between /ingest (Documents) vs /notes based on pref
  let target = 'doc';
  try { target = localStorage.getItem(SAVE_TARGET_KEY) || 'doc'; } catch (_) {}
  try {
    if (target === 'doc') {
      await sendIngest(text);
    } else {
      await sendNote(text, includeUrl);
    }
  } catch (e) {
    showToast(e?.message || 'Save failed');
  }
}

async function scrapePageToDocs() {
  try {
    showToast('Agent ingesting page...');
    const res = await fetch(AGENT_INGEST_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url: window.location.href, chunk_size: 1000, chunk_overlap: 150 }) });
    const text = await res.text();
    if (!res.ok) throw new Error(text || 'Ingest failed');
    showToast('Agent saved document');
  } catch (e) {
    showToast(e?.message || 'Scrape failed');
  }
}

async function crawlSite(progressWrap, progressFill, progressText) {
  try {
    const startRes = await fetch(`${BACKEND_BASE}/crawl-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: window.location.href, maxDepth: 1, limit: 10 })
    });
    const startText = await startRes.text();
    if (!startRes.ok) throw new Error(startText || 'Failed to start crawl');
    let startData = {}; try { startData = JSON.parse(startText); } catch {}
    const crawlId = startData.crawl_id;
    if (!crawlId) throw new Error('Crawl id missing');

    // Show progress UI
    if (progressWrap) progressWrap.style.display = 'flex';
    const setProgress = (completed, total, status) => {
      const pct = total > 0 ? Math.round((completed / total) * 100) : 5;
      if (progressFill) progressFill.style.width = `${pct}%`;
      if (progressText) progressText.textContent = `${status || 'running'} ${completed}/${total}`;
    };
    setProgress(0, 0, 'starting');

    // Poll status
    let done = false; let attempts = 0;
    while (!done && attempts < 240) { // ~8 minutes max
      attempts++;
      await new Promise(r => setTimeout(r, 2000));
      const sRes = await fetch(`${BACKEND_BASE}/crawl-status/${crawlId}`);
      const sText = await sRes.text();
      if (!sRes.ok) throw new Error(sText || 'Status failed');
      let sData = {}; try { sData = JSON.parse(sText); } catch {}
      const status = sData.status || 'unknown';
      const total = sData.total || 0;
      const completed = sData.completed || 0;
      setProgress(completed, total, status);
      if (status === 'completed') done = true;
      if (status === 'failed') throw new Error('Crawl failed');
    }

    // Save results
    const saveRes = await fetch(`${BACKEND_BASE}/crawl-save/${crawlId}`, { method: 'POST' });
    const saveText = await saveRes.text();
    if (!saveRes.ok) throw new Error(saveText || 'Save failed');
    let saveData = {}; try { saveData = JSON.parse(saveText); } catch {}
    const n = saveData.inserted_count || 0;
    showToast(`Crawl saved ${n} notes`);
  } catch (e) {
    showToast(e?.message || 'Crawl failed');
  } finally {
    if (progressWrap) progressWrap.style.display = 'none';
    if (progressFill) progressFill.style.width = '0%';
  }
}

function showToast(message) {
  let toast = document.getElementById(TOAST_ID);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = TOAST_ID;
    toast.className = 'note-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('is-visible');
  setTimeout(() => toast.classList.remove('is-visible'), 1800);
}

function showSelectionToolbar(selectedText, rect) {
  removeWidget();
  injectStyles();
  const bar = document.createElement('div');
  bar.id = WIDGET_ID;
  bar.className = 'note-toolbar';
  bar.innerHTML = `
    <button class="note-btn note-btn--icon" data-key="S" data-action="save" title="Save selection (S or Alt+S)">💾</button>
    <button class="note-btn note-btn--icon" data-key="A" data-action="save-highlight" title="Save + highlight (A)">✅</button>
    <button class="note-btn note-btn--icon" data-key="M" data-action="summarize" title="Summarize (M)">🧠</button>
    <button class="note-btn note-btn--icon" data-key="H" data-action="highlight" title="Highlight (H)">🖍️</button>
    <button class="note-btn note-btn--icon" data-key="C" data-action="copy" title="Copy (C)">📋</button>
    <button class="note-btn note-btn--icon" data-key="O" data-action="open-dock" title="Open dock (O)">▣</button>
  `;
  bar.addEventListener('mousedown', e => e.stopPropagation());
  bar.addEventListener('click', async (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const action = t.getAttribute('data-action');
    if (!action) return;
    if (action === 'save') {
      await smartSave(selectedText, true);
      showToast('Saved');
      removeWidget();
    } else if (action === 'save-highlight') {
      await smartSave(selectedText, true);
      highlightSelection();
      showToast('Saved + highlighted');
      removeWidget();
    } else if (action === 'highlight') {
      highlightSelection();
      removeWidget();
    } else if (action === 'summarize') {
      const t = selectedText;
      summarizeText(t);
    } else if (action === 'copy') {
      copySelection();
      removeWidget();
    } else if (action === 'open-dock') {
      ensureDock();
      removeWidget();
    }
  });
  document.body.appendChild(bar);
  requestAnimationFrame(() => positionWidget(bar, rect));
}

function getSelectionRect(selection) {
  if (!selection.rangeCount) {
    return null;
  }

  const range = selection.getRangeAt(0).cloneRange();
  const rect = range.getBoundingClientRect();
  return rect.width || rect.height ? rect : null;
}

function handleSelection() {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const selectedText = selection.toString().trim();
  if (!selectedText) {
    removeWidget();
    return;
  }

  const rect = getSelectionRect(selection);
  if (!rect) {
    removeWidget();
    return;
  }

  showSelectionToolbar(selectedText, rect);
}

document.addEventListener("mouseup", () => {
  setTimeout(handleSelection, 0);
});

document.addEventListener("keydown", (event) => {
  // Quick actions when selection toolbar is visible and focus is not in input
  const selBar = document.getElementById(WIDGET_ID);
  const tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
  const inEditable = tag === 'input' || tag === 'textarea' || (document.activeElement && document.activeElement.isContentEditable);
  if (selBar && !inEditable && !event.metaKey && !event.ctrlKey && !event.altKey) {
    const k = event.key.toLowerCase();
    if (k === 's') { event.preventDefault(); smartSave((window.getSelection()?.toString()||'').trim(), true).then(()=>{ showToast('Saved'); removeWidget();}); return; }
    if (k === 'a') { event.preventDefault(); (async()=>{ const t=(window.getSelection()?.toString()||'').trim(); if(t){ await smartSave(t,true); highlightSelection(); showToast('Saved + highlighted'); removeWidget(); }})(); return; }
    if (k === 'm') { event.preventDefault(); const t=(window.getSelection()?.toString()||'').trim(); if(t){ summarizeText(t); } return; }
    if (k === 'h') { event.preventDefault(); highlightSelection(); removeWidget(); return; }
    if (k === 'c') { event.preventDefault(); copySelection(); removeWidget(); return; }
    if (k === 'o') { event.preventDefault(); ensureDock(); removeWidget(); return; }
  }

  if (event.key === "Escape") {
    removeWidget();
    const dock = document.getElementById(DOCK_ID);
    if (dock && !dock.classList.contains('note-dock--hidden')) {
      dock.classList.add('note-dock--hidden');
      try { localStorage.setItem(DOCK_HIDDEN_KEY, '1'); } catch (_) {}
    }
  }
  if (event.altKey && !event.metaKey && !event.ctrlKey && (event.key.toLowerCase() === 'n')) {
    // Toggle show/hide quickly
    let dock = document.getElementById(DOCK_ID);
    if (!dock) {
      ensureDock();
      dock = document.getElementById(DOCK_ID);
    }
    if (dock) {
      const hidden = dock.classList.toggle('note-dock--hidden');
      try {
        if (hidden) localStorage.setItem(DOCK_HIDDEN_KEY, '1');
        else localStorage.removeItem(DOCK_HIDDEN_KEY);
      } catch (_) {}
      // manage reveal tab
      const side = dock.classList.contains('note-dock--left') ? 'left' : 'right';
      if (hidden) { ensureRevealTab(side); } else { removeRevealTab(); }
    }
  }
  // Save selection via Alt+S or Meta+S
  if ((event.altKey || event.metaKey) && event.key.toLowerCase() === 's') {
    const selected = (window.getSelection()?.toString() || '').trim();
    if (selected) {
      event.preventDefault();
      smartSave(selected, true).then(() => showToast('Saved selection'));
    }
  }
  // Scrape page Alt+P
  if (event.altKey && !event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'p') {
    event.preventDefault();
    scrapePageToDocs();
  }
  // Crawl site Alt+C
  if (event.altKey && !event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'c') {
    event.preventDefault();
    const dock = document.getElementById(DOCK_ID);
    const pr = dock && dock._progress;
    crawlSite(pr?.wrap, pr?.fill, pr?.text);
  }
  // Command palette Alt+K
  if (event.altKey && !event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    showCommandPalette();
  }
  // Semantic Answer palette Alt+/
  if (event.altKey && !event.metaKey && !event.ctrlKey && event.key === '/') {
    event.preventDefault();
    showSemanticAnswerPalette();
  }
  // Compose palette Alt+A (threaded)
  if (event.altKey && !event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    showSemanticAnswerPalette(true);
  }
  // Summarize selection Alt+M
  if (event.altKey && !event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'm') {
    const t = (window.getSelection()?.toString()||'').trim();
    if (t) { event.preventDefault(); summarizeText(t); }
  }
  // Paste & save Alt+V
  if (event.altKey && !event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'v') {
    event.preventDefault();
    (async()=>{
      try { const clip = await navigator.clipboard.readText(); const text=(clip||'').trim(); if(!text) return showToast('Clipboard is empty'); await safeSave(text,true); showToast('Saved from clipboard'); } catch(_) { showToast('Clipboard read blocked'); }
    })();
  }
  // Cmd/Ctrl + Enter saves from dock textarea
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    const dock = document.getElementById(DOCK_ID);
    const ta = dock ? dock.querySelector('.note-dock__textarea') : null;
    if (ta && document.activeElement === ta) {
      const includeEl = dock.querySelector('.note-dock__include-url');
      const include = includeEl ? includeEl.checked : true;
      const text = ta.value.trim();
      if (text) {
        smartSave(text, include).then(() => {
          ta.value = '';
          try { localStorage.removeItem(DRAFT_STORAGE_KEY); } catch (_) {}
          showToast('Saved');
        });
      }
    }
  }
});

document.addEventListener("mousedown", (event) => {
  const widget = document.getElementById(WIDGET_ID);
  if (widget && !widget.contains(event.target)) {
    removeWidget();
  }
});

window.addEventListener("scroll", () => { removeWidget(); });

// Quick save on copy (optional)
let _lastCopy = { text: '', ts: 0 };
document.addEventListener('copy', () => {
  let enabled = false;
  try { enabled = localStorage.getItem(QUICK_COPY_KEY) === '1'; } catch (_) {}
  if (!enabled) return;
  const text = (window.getSelection()?.toString() || '').trim();
  if (!text) return;
  const now = Date.now();
  if (text === _lastCopy.text && now - _lastCopy.ts < 1500) return; // throttle duplicates
  _lastCopy = { text, ts: now };
  smartSave(text, true).then(() => showToast('Saved from copy'));
});

function copySelection() {
  const text = (window.getSelection()?.toString() || '').trim();
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => showToast('Copied'));
  }
}

function highlightSelection() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  try {
    if (range && range.toString().trim()) {
      const mark = document.createElement('mark');
      mark.className = 'note-highlight';
      range.surroundContents(mark);
    }
  } catch (_) {
    // If surround fails (complex selection), skip safely
  }
}

async function summarizeText(text){
  try{
    showToast('Summarizing...');
    const res = await fetch(SUMMARIZE_TEXT_ENDPOINT, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text, sentences: 3, bullets: 5 }) });
    const t = await res.text();
    if(!res.ok) throw new Error(t||'Summarize failed');
    let out = {}; try{ out = JSON.parse(t); }catch{}
    showSummaryOverlay(out, text);
  }catch(e){ showToast(e?.message||'Summarize failed'); }
}

function showSummaryOverlay(summaryObj, original){
  injectStyles();
  const id = 'note-summary-overlay';
  const existing = document.getElementById(id); if(existing) existing.remove();
  const overlay = document.createElement('div'); overlay.id = id; overlay.className='note-cmd';
  const short = (summaryObj && summaryObj.short) || '';
  const bullets = (summaryObj && summaryObj.bullets) || [];
  const keyPoints = (summaryObj && summaryObj.key_points) || [];
  const bulletsHtml = bullets.map(b=>`<li>${escapeHtml(String(b))}</li>`).join('');
  const kpHtml = keyPoints.length? `<div style="color:#94a3b8;margin-top:6px">Key: ${keyPoints.map(escapeHtml).join(', ')}</div>`: '';
  overlay.innerHTML = `
    <div class="note-cmd__panel" role="dialog" aria-modal="true">
      <div class="note-cmd__title">Summary</div>
      <div class="note-cmd__list" style="gap:10px">
        <div class="snippet" style="white-space:pre-wrap;background:#0b1326;border:1px solid #1e293b;border-radius:10px;padding:10px">${escapeHtml(String(short||''))}</div>
        <ul style="margin:0;padding-left:18px">${bulletsHtml}</ul>
        ${kpHtml}
      </div>
      <div class="note-cmd__hint">Actions</div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="note-cmd__item" data-ss-action="copy">Copy</button>
        <button class="note-cmd__item" data-ss-action="save-doc">Save summary → Docs</button>
        <button class="note-cmd__item" data-ss-action="close">Close</button>
      </div>
    </div>`;
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) overlay.remove(); });
  const panel = overlay.querySelector('.note-cmd__panel'); panel.tabIndex=0; panel.focus();
  overlay.addEventListener('keydown', (e)=>{ if(e.key==='Escape'){ overlay.remove(); }});
  overlay.addEventListener('click', async (e)=>{
    const btn = e.target.closest('[data-ss-action]'); if(!btn) return;
    const act = btn.getAttribute('data-ss-action');
    if(act==='close'){ overlay.remove(); return; }
    if(act==='copy'){
      const s = [short, ...bullets].filter(Boolean).join('\n');
      try{ await navigator.clipboard.writeText(s); showToast('Copied'); }catch(_){ showToast('Copy blocked'); }
    }
    if(act==='save-doc'){
      const s = [short, ...bullets].filter(Boolean).join('\n');
      await sendIngest(s);
      showToast('Summary saved');
      overlay.remove();
    }
  });
  document.body.appendChild(overlay);
}

function showSemanticAnswerPalette(threaded){
  injectStyles();
  const id = 'note-semantic-overlay';
  const exist = document.getElementById(id); if(exist) exist.remove();
  const overlay = document.createElement('div'); overlay.id=id; overlay.className='note-cmd';
  const suggested = (window.getSelection()?.toString()||'').trim();
  const storeKey = `noteCompose:${location.host}`;
  let thread = [];
  if (threaded) { try { thread = JSON.parse(localStorage.getItem(storeKey)||'[]'); } catch(_) { thread = []; } }
  overlay.innerHTML = `
    <div class="note-cmd__panel" role="dialog" aria-modal="true">
      <div class="note-cmd__title">Ask the Assistant</div>
      <div class="note-cmd__list" style="gap:8px">
        ${threaded ? `<div id="sathread" class="preview" style="max-height:160px;overflow:auto"></div>` : ''}
        <input id="saq" class="input" placeholder="Ask a question..." value="${escapeHtml(suggested)}" />
        <div style="display:flex;gap:8px;align-items:center">
          <select id="sascope" class="input small"><option value="chunks">Chunks</option><option value="docs">Docs</option></select>
          <input id="satopk" class="input small" type="number" value="8" />
          <button id="sarun" class="note-cmd__item">Answer</button>
          <label style="color:#94a3b8;display:flex;align-items:center;gap:6px"><input id="sauselmm" type="checkbox"/> LLM</label>
        </div>
        <div id="sastatus" class="status"></div>
        <div id="saview" class="panel" style="margin-top:8px"></div>
        ${threaded ? `<div style="display:flex;gap:8px;justify-content:flex-end"><button id="saclear" class="note-cmd__item">Clear</button></div>`: ''}
      </div>
      <div class="note-cmd__hint">Alt+/ to open • Esc to close</div>
    </div>`;
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) overlay.remove(); });
  overlay.addEventListener('keydown', (e)=>{ if(e.key==='Escape'){ overlay.remove(); }});
  document.body.appendChild(overlay);
  const qEl = overlay.querySelector('#saq'); const scopeEl=overlay.querySelector('#sascope'); const kEl=overlay.querySelector('#satopk'); const runBtn=overlay.querySelector('#sarun'); const status=overlay.querySelector('#sastatus'); const view=overlay.querySelector('#saview'); const useLlm=overlay.querySelector('#sauselmm'); const threadEl=overlay.querySelector('#sathread'); const clearBtn=overlay.querySelector('#saclear');
  if (threaded && threadEl){ threadEl.textContent = thread.map(p=>`Q: ${p.q}\nA: ${p.a}`).join('\n\n'); }
  if(qEl){ qEl.focus(); }
  async function run(){
    const q = (qEl.value||'').trim(); if(!q){ status.textContent='Enter a question'; return; }
    status.textContent='Retrieving...'; view.innerHTML='';
    try{
      let answerText = '';
      if(useLlm && useLlm.checked){
        const res = await fetch(`${BACKEND_BASE}/answer/compose`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ query: q, scope: scopeEl.value, top_k: parseInt(kEl.value||'8',10), include_sources: true }) });
        const out = await res.json();
        answerText = out.answer || '';
      } else {
        const res = await fetch(SEMANTIC_SEARCH_ENDPOINT, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ query: q, scope: scopeEl.value, top_k: parseInt(kEl.value||'8',10) }) });
        const data = await res.json();
        const texts = (data.items||[]).map(r=> (r.text||r.snippet||'')).join('\n');
        const sres = await fetch(SUMMARIZE_TEXT_ENDPOINT, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text: texts, sentences: 3, bullets: 8 }) });
        const sum = await sres.json();
        answerText = [sum.short, ...(sum.bullets||[])].filter(Boolean).join('\n');
      }
      status.textContent='OK';
      const wrap = document.createElement('div');
      const pre = document.createElement('pre'); pre.className='snippet'; pre.textContent = answerText; wrap.appendChild(pre);
      const save = document.createElement('button'); save.className='note-cmd__item'; save.textContent='Save answer → Docs';
      save.onclick = async ()=>{ save.disabled=true; save.textContent='Saving...'; try{ await sendIngest(answerText); save.textContent='Saved ✔'; } catch(e){ save.textContent='Failed'; } };
      view.innerHTML=''; view.appendChild(wrap); view.appendChild(save);
      if(threaded){ thread.push({ q, a: answerText }); try{ localStorage.setItem(storeKey, JSON.stringify(thread)); }catch(_){} if(threadEl){ threadEl.textContent = thread.map(p=>`Q: ${p.q}\nA: ${p.a}`).join('\n\n'); } }
    }catch(e){ status.textContent='Failed: '+(e?.message||''); }
  }
  if(runBtn){ runBtn.addEventListener('click', run); }
  if(clearBtn){ clearBtn.addEventListener('click', ()=>{ try{ localStorage.removeItem(storeKey); }catch(_){} if(threadEl){ threadEl.textContent=''; } }); }
}

function escapeHtml(s){ return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c])); }

// Ensure UI present immediately on load/reload
function shouldAutoShowDock(){
  try { return localStorage.getItem(DOCK_HIDDEN_KEY) !== '1'; } catch (_) { return true; }
}
function boot(){
  if (shouldAutoShowDock()) {
    ensureDock();
  } else {
    // hidden: show reveal tab only
    try {
      const saved = JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) || 'null');
      const side = saved && saved.side === 'left' ? 'left' : 'right';
      ensureRevealTab(side);
    } catch (_) { ensureRevealTab('right'); }
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

// Command palette (minimal, unobtrusive)
function removeCommandPalette(){ const ex = document.getElementById(CMD_ID); if (ex) ex.remove(); }
function showCommandPalette(){
  if (document.getElementById(CMD_ID)) return;
  injectStyles();
  const overlay = document.createElement('div');
  overlay.id = CMD_ID;
  overlay.className = 'note-cmd';
  const hasSel = !!(window.getSelection()?.toString()||'').trim();
  let enabledQuickCopy = false; try { enabledQuickCopy = localStorage.getItem(QUICK_COPY_KEY) === '1'; } catch(_){}
  let saveTarget = 'doc'; try { saveTarget = localStorage.getItem(SAVE_TARGET_KEY) || 'doc'; } catch(_){}
  overlay.innerHTML = `
    <div class="note-cmd__panel" role="dialog" aria-modal="true">
      <div class="note-cmd__title">Quick Actions</div>
      <div class="note-cmd__list">
        <button class="note-cmd__item" data-action="save-selection" ${hasSel? '': 'disabled'}><span>Save selection</span><kbd>S</kbd></button>
        <button class="note-cmd__item" data-action="paste-save"><span>Save from clipboard</span><kbd>Alt+V</kbd></button>
        <button class="note-cmd__item" data-action="scrape"><span>Scrape page</span><kbd>Alt+P</kbd></button>
        <button class="note-cmd__item" data-action="crawl"><span>Crawl site</span><kbd>Alt+C</kbd></button>
        <button class="note-cmd__item" data-action="toggle-quickcopy"><span>${enabledQuickCopy? 'Disable' : 'Enable'} auto‑save on copy</span></button>
        <button class="note-cmd__item" data-action="semantic-answer"><span>Semantic answer (Alt+/)</span></button>
        <button class="note-cmd__item" data-action="toggle-savetarget"><span>Save target: ${saveTarget==='doc'?'Documents':'Notes'} (toggle)</span></button>
        <button class="note-cmd__item" data-action="toggle-dock"><span>Show/Hide dock</span><kbd>Alt+N</kbd></button>
        <button class="note-cmd__item" data-action="flip-side"><span>Move dock left/right</span></button>
        <button class="note-cmd__item" data-action="open-agents"><span>Open Agents panel</span></button>
      </div>
      <div class="note-cmd__hint">Esc to close</div>
    </div>`;
  overlay.addEventListener('click', (e)=>{ if (e.target === overlay) removeCommandPalette(); });
  overlay.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') { e.stopPropagation(); removeCommandPalette(); }});
  overlay.querySelector('.note-cmd__list').addEventListener('click', async (e)=>{
    const btn = e.target.closest('button[data-action]'); if (!btn) return;
    const action = btn.getAttribute('data-action');
    if (action === 'save-selection') {
      const t = (window.getSelection()?.toString()||'').trim(); if (t) await smartSave(t, true); showToast('Saved selection');
    } else if (action === 'paste-save') {
      try { const clip = await navigator.clipboard.readText(); const t=(clip||'').trim(); if(!t) return showToast('Clipboard is empty'); await smartSave(t,true); showToast('Saved from clipboard'); } catch(_) { showToast('Clipboard read blocked'); }
    } else if (action === 'scrape') {
      await scrapePageToDocs();
    } else if (action === 'crawl') {
      const dock = document.getElementById(DOCK_ID); const pr = dock && dock._progress; await crawlSite(pr?.wrap, pr?.fill, pr?.text);
    } else if (action === 'toggle-quickcopy') {
      try { const cur = localStorage.getItem(QUICK_COPY_KEY) === '1'; localStorage.setItem(QUICK_COPY_KEY, cur ? '0' : '1'); showToast(cur? 'Auto‑save on Copy disabled' : 'Auto‑save on Copy enabled'); } catch(_) {}
    } else if (action === 'toggle-savetarget') {
      try { const cur = localStorage.getItem(SAVE_TARGET_KEY) || 'doc'; const next = cur === 'doc' ? 'note' : 'doc'; localStorage.setItem(SAVE_TARGET_KEY, next); showToast(next==='doc' ? 'Saving to Documents' : 'Saving to Notes'); } catch(_) {}
    } else if (action === 'toggle-dock') {
      let dock = document.getElementById(DOCK_ID); if (!dock) { ensureDock(); dock = document.getElementById(DOCK_ID); }
      if (dock) { const hidden = dock.classList.toggle('note-dock--hidden'); const side = dock.classList.contains('note-dock--left') ? 'left' : 'right'; if (hidden) ensureRevealTab(side); else removeRevealTab(); }
    } else if (action === 'flip-side') {
      const dock = document.getElementById(DOCK_ID); if (dock) { dock.classList.toggle('note-dock--left'); const rect = dock.getBoundingClientRect(); const side = dock.classList.contains('note-dock--left') ? 'left' : 'right'; try { localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify({top: rect.top, side})); } catch(_) {} }
    } else if (action === 'semantic-answer') {
      showSemanticAnswerPalette();
    } else if (action === 'open-agents') {
      try { const url = chrome.runtime.getURL('dashboard.html#agents'); window.open(url, '_blank'); } catch(_) {}
    }
    removeCommandPalette();
  });
  document.body.appendChild(overlay);
  // focus panel for Esc handling
  const panel = overlay.querySelector('.note-cmd__panel');
  panel.tabIndex = 0; panel.focus();
}
