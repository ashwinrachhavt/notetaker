const MP_API_BASE = "http://localhost:8000";
const WIDGET_ID = "note-taker-widget";
const TOAST_ID = "note-taker-toast";
const STYLE_ID = "note-widget-style";
const DOCK_ID = "note-taker-dock";
const REVEAL_ID = "note-dock-reveal";

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("widget.css");
  document.head.appendChild(link);
}

function removeWidget() {
  const existing = document.getElementById(WIDGET_ID);
  if (existing) existing.remove();
}

function positionWidget(widget, rect) {
  const offsetTop = rect.bottom + window.scrollY + 8;
  const offsetLeft = rect.left + window.scrollX;
  widget.style.top = `${offsetTop}px`;
  const maxLeft = document.documentElement.clientWidth - widget.offsetWidth - 16;
  widget.style.left = `${Math.min(Math.max(8, offsetLeft), Math.max(8, maxLeft))}px`;
}

async function sendMindPalaceCapture(rawText, selectionType = "selection", html = null) {
  const payload = {
    raw_text: rawText,
    html: html,
    page_url: window.location.href,
    page_title: document.title,
    selection_type: selectionType,
  };
  const response = await fetch(`${MP_API_BASE}/api/mind-palace/page/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    mode: "cors",
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Failed to save");
  }
  return response.json();
}

async function safeSave(text) {
  try { await sendMindPalaceCapture(text, "selection"); }
  catch (e) { showToast(e?.message || 'Failed to save'); }
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
  `;
  bar.addEventListener('mousedown', e => e.stopPropagation());
  bar.addEventListener('click', async (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const action = t.getAttribute('data-action');
    if (!action) return;
    if (action === 'save') {
      await safeSave(selectedText);
      showToast('Saved');
      removeWidget();
    }
  });
  document.body.appendChild(bar);
  requestAnimationFrame(() => positionWidget(bar, rect));
}

function getSelectionRect(selection) {
  if (!selection.rangeCount) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const rect = range.getBoundingClientRect();
  return rect.width || rect.height ? rect : null;
}

function handleSelection() {
  const selection = window.getSelection();
  if (!selection) return;
  const selectedText = selection.toString().trim();
  if (!selectedText) { removeWidget(); return; }
  const rect = getSelectionRect(selection);
  if (!rect) { removeWidget(); return; }
  showSelectionToolbar(selectedText, rect);
}

document.addEventListener("mouseup", () => { setTimeout(handleSelection, 0); });

document.addEventListener("keydown", (event) => {
  // Quick actions when selection toolbar is visible and focus is not in input
  const selBar = document.getElementById(WIDGET_ID);
  const tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
  const inEditable = tag === 'input' || tag === 'textarea' || (document.activeElement && document.activeElement.isContentEditable);
  if (selBar && !inEditable && !event.metaKey && !event.ctrlKey && !event.altKey) {
    const k = event.key.toLowerCase();
    if (k === 's') { event.preventDefault(); safeSave((window.getSelection()?.toString()||'').trim()).then(()=>{ showToast('Saved'); removeWidget();}); return; }
  }

  if (event.key === "Escape") {
    removeWidget();
  }
  if ((event.altKey || event.metaKey) && event.key.toLowerCase() === 's') {
    const selected = (window.getSelection()?.toString() || '').trim();
    if (selected) {
      event.preventDefault();
      safeSave(selected).then(() => showToast('Saved selection'));
    }
  }
});

// --- Minimal on-screen toggle + dock ---
function ensureRevealTab() {
  if (document.getElementById(REVEAL_ID)) return;
  injectStyles();
  const tab = document.createElement('div');
  tab.id = REVEAL_ID;
  tab.className = 'note-reveal';
  tab.innerHTML = '<span class="note-reveal__icon">✶</span>';
  tab.title = 'Open Mind Palace (Alt+N)';
  tab.addEventListener('click', () => { showDock(true); });
  document.body.appendChild(tab);
}

function removeRevealTab(){ const el = document.getElementById(REVEAL_ID); if (el) el.remove(); }

function ensureDock() {
  if (document.getElementById(DOCK_ID)) return;
  injectStyles();
  const dock = document.createElement('div');
  dock.id = DOCK_ID;
  dock.className = 'note-dock note-dock--hidden';
  dock.innerHTML = `
    <div class="note-dock__header">
      <span class="note-dock__title">Mind Palace</span>
      <button class="note-dock__close" title="Hide">✕</button>
    </div>
    <div class="note-dock__body">
      <div class="note-dock__quickbar">
        <button class="note-btn note-btn--icon" data-action="mp-save-page" title="Save full page">📄</button>
        <button class="note-btn note-btn--icon" data-action="mp-save-selection" title="Save selection">💾</button>
      </div>
    </div>`;
  dock.addEventListener('click', async (e)=>{
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (!btn) return;
    if (btn.classList.contains('note-dock__close')) { hideDock(); return; }
    if (btn.getAttribute('data-action') === 'mp-save-selection'){
      const t = (window.getSelection()?.toString()||'').trim();
      if (!t) { showToast('No selection'); return; }
      btn.disabled = true; const old = btn.textContent; btn.textContent = '…';
      try { await sendMindPalaceCapture(t, 'selection'); showToast('Saved selection'); }
      catch(e){ showToast(e?.message || 'Save failed'); }
      finally { btn.disabled=false; btn.textContent = old; }
      return;
    }
    if (btn.getAttribute('data-action') === 'mp-save-page'){
      const full = (document.body && document.body.innerText || '').trim();
      if (!full) { showToast('Page has no text'); return; }
      btn.disabled = true; const old = btn.textContent; btn.textContent = '…';
      try { await sendMindPalaceCapture(full, 'full_page', document.documentElement && document.documentElement.outerHTML || null); showToast('Saved page'); }
      catch(e){ showToast(e?.message || 'Save failed'); }
      finally { btn.disabled=false; btn.textContent = old; }
      return;
    }
    // no quick-capture textarea/button in minimal dock
  });
  document.body.appendChild(dock);
}

function showDock(focusTextarea){
  ensureDock();
  removeRevealTab();
  const dock = document.getElementById(DOCK_ID);
  if (!dock) return;
  dock.classList.remove('note-dock--hidden');
  if (focusTextarea) {
    const ta = dock.querySelector('.note-dock__textarea');
    if (ta) { try { ta.focus(); } catch(_){} }
  }
}

function hideDock(){
  const dock = document.getElementById(DOCK_ID);
  if (!dock) return;
  dock.classList.add('note-dock--hidden');
  ensureRevealTab();
}

// Alt+N toggles dock visibility
document.addEventListener('keydown', (e)=>{
  if (e.altKey && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'n'){
    const dock = document.getElementById(DOCK_ID);
    if (dock && !dock.classList.contains('note-dock--hidden')) hideDock(); else showDock(true);
  }
});

// Boot: ensure reveal appears
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', ()=>{ ensureRevealTab(); ensureDock(); }, { once: true });
} else {
  ensureRevealTab(); ensureDock();
}
