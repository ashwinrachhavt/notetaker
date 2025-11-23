const SERVER_ENDPOINT = "http://localhost:5000/notes";
const BACKEND_BASE = SERVER_ENDPOINT.replace(/\/?notes\/?$/, "");
const DOCK_STORAGE_KEY = "noteDockPos:v1";
const FIRECRAWL_BASE = "http://localhost:8010";
const SCRAPE_ENDPOINT = `${BACKEND_BASE}/scrape-website`;
const CRAWL_ENDPOINT = `${BACKEND_BASE}/crawl-website`;
const WIDGET_ID = "note-taker-widget"; // selection toolbar id
const DOCK_ID = "note-taker-dock"; // persistent dock id
const TOAST_ID = "note-taker-toast";
const STYLE_ID = "note-widget-style";
const DRAFT_STORAGE_KEY = `noteDraft:${location.host}`;

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
    </div>
    <div class="note-dock__quickbar">
      <button class="note-btn note-btn--icon" data-action="save-selection" title="Save selection (S)">💾</button>
      <button class="note-btn note-btn--icon" data-action="highlight" title="Highlight (H)">🖍️</button>
      <button class="note-btn note-btn--icon" data-action="copy" title="Copy selection (C)">📋</button>
      <button class="note-btn note-btn--icon" data-action="scrape" title="Scrape page & save">🕷️</button>
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
          <span class="note-dock__counter" aria-live="polite">0</span>
        </div>
        <div>
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

  // Button actions
  const counterEl = dock.querySelector('.note-dock__counter');
  const textarea = dock.querySelector('.note-dock__textarea');
  const sideToggle = dock.querySelector('[data-action="toggle-side"]');
  const includeUrlEl = dock.querySelector('.note-dock__include-url');
  const progressWrap = dock.querySelector('.note-dock__progress');
  const progressFill = dock.querySelector('.note-progress__fill');
  const progressText = dock.querySelector('.note-progress__text');

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

  // side toggle button
  if (sideToggle) sideToggle.addEventListener('click', () => {
    dock.classList.toggle('note-dock--left');
    const rect = dock.getBoundingClientRect();
    const side = dock.classList.contains('note-dock--left') ? 'left' : 'right';
    try { localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify({top: rect.top, side})); } catch (_) {}
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
      await safeSave(text, include);
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
      await scrapePage();
      if (btn) btn.classList.remove('note-btn--loading');
    } else if (action === 'save-selection') {
      const selected = (window.getSelection()?.toString() || '').trim();
      if (!selected) return showToast('No selection');
      const btn = target.closest('button');
      if (btn) btn.classList.add('note-btn--loading');
      await safeSave(selected, true);
      if (btn) btn.classList.remove('note-btn--loading');
      showToast('Selection saved');
    } else if (action === 'copy') {
      copySelection();
    } else if (action === 'highlight') {
      highlightSelection();
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

async function scrapePage() {
  try {
    showToast('Scraping page...');
    const res = await fetch(SCRAPE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: window.location.href })
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text || 'Scrape failed');
    // Backend returns { id, markdown }
    showToast('Page scraped and saved!');
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
    <button class="note-btn note-btn--icon" data-action="save" title="Save selection (Alt+S)">💾</button>
    <button class="note-btn note-btn--icon" data-action="save-highlight" title="Save + highlight">✅</button>
    <button class="note-btn note-btn--icon" data-action="highlight" title="Highlight">🖍️</button>
    <button class="note-btn note-btn--icon" data-action="copy" title="Copy">📋</button>
    <button class="note-btn note-btn--icon" data-action="open-dock" title="Open dock">▣</button>
  `;
  bar.addEventListener('mousedown', e => e.stopPropagation());
  bar.addEventListener('click', async (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const action = t.getAttribute('data-action');
    if (!action) return;
    if (action === 'save') {
      await safeSave(selectedText, true);
      showToast('Saved');
      removeWidget();
    } else if (action === 'save-highlight') {
      await safeSave(selectedText, true);
      highlightSelection();
      showToast('Saved + highlighted');
      removeWidget();
    } else if (action === 'highlight') {
      highlightSelection();
      removeWidget();
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
  if (event.key === "Escape") {
    removeWidget();
  }
  if ((event.altKey || event.metaKey) && (event.key.toLowerCase() === 'n')) {
    // toggle dock minimize/maximize
    const dock = document.getElementById(DOCK_ID);
    if (dock) {
      const isMinimized = dock.classList.contains('note-dock--minimized');
      if (isMinimized) {
        dock.classList.remove('note-dock--minimized');
        dock.classList.remove('note-dock--compact');
        const toggle = dock.querySelector('.note-dock__toggle');
        if (toggle) {
          toggle.textContent = '▾';
          toggle.setAttribute('aria-label', 'Minimize');
        }
      } else {
        dock.classList.add('note-dock--minimized');
        dock.classList.add('note-dock--compact');
        const toggle = dock.querySelector('.note-dock__toggle');
        if (toggle) {
          toggle.textContent = '▸';
          toggle.setAttribute('aria-label', 'Maximize');
        }
      }
    } else {
      ensureDock();
    }
  }
  // Save selection via Alt+S or Meta+S
  if ((event.altKey || event.metaKey) && event.key.toLowerCase() === 's') {
    const selected = (window.getSelection()?.toString() || '').trim();
    if (selected) {
      event.preventDefault();
      safeSave(selected, true).then(() => showToast('Saved selection'));
    }
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
        safeSave(text, include).then(() => {
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

// Ensure UI present immediately on load/reload
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', ensureDock, { once: true });
} else {
  ensureDock();
}
