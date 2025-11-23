/* global API_BASE */
(function(){
  // Load persisted API base or default to local FastAPI
  window.API_BASE = (localStorage.getItem('API_BASE') || 'http://localhost:5000').replace(/\/$/, '');
  const routes = {
    notes: document.getElementById('panel-notes'),
    scrape: document.getElementById('panel-scrape'),
    new: document.getElementById('panel-new'),
  };
  const navLinks = Array.from(document.querySelectorAll('[data-route]'));
  function setRoute(hash){
    const key = (hash || location.hash || '#notes').replace('#','');
    Object.values(routes).forEach(el=>el.classList.remove('is-active'));
    (routes[key]||routes.notes).classList.add('is-active');
    navLinks.forEach(a=>a.classList.toggle('is-active', a.getAttribute('href')==='#'+key));
  }
  window.addEventListener('hashchange', ()=>setRoute());
  setRoute();

  // Settings for API base
  const apiInput = document.getElementById('apiBase');
  const apiSave = document.getElementById('apiSave');
  apiInput.value = window.API_BASE;
  apiSave.addEventListener('click', ()=>{
    const v = (apiInput.value||'').trim().replace(/\/$/, '');
    if(!v) return;
    localStorage.setItem('API_BASE', v);
    window.API_BASE = v;
    // quick visual cue
    apiSave.textContent = 'Saved';
    setTimeout(()=> apiSave.textContent='Use', 1200);
  });

  const api = {
    base(){ return window.API_BASE; },
    async list({q='', skip=0, limit=20}={}){
      const params = new URLSearchParams({skip, limit});
      if(q) params.set('q', q);
      const res = await fetch(`${this.base()}/notes?${params.toString()}`);
      if(!res.ok) throw new Error('Failed to load notes');
      return res.json();
    },
    async del(id){
      const res = await fetch(`${this.base()}/notes/${id}`, {method:'DELETE'});
      if(!res.ok && res.status!==204) throw new Error('Delete failed');
    },
    async save(text, source){
      const res = await fetch(`${this.base()}/notes`,{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text, source_url: source || null, metadata:{ui:'extension'}})});
      if(!res.ok) throw new Error('Save failed');
      return res.json();
    },
    async scrape(url){
      const res = await fetch(`${this.base()}/scrape-website`,{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url})});
      if(!res.ok) throw new Error(await res.text());
      return res.json();
    }
  };

  // Notes listing
  const notesEl = document.getElementById('notes');
  const pagerEl = document.getElementById('pager');
  const searchEl = document.getElementById('search');
  const refreshBtn = document.getElementById('refresh');
  let state = {skip:0, limit:20, q:''};

  async function loadNotes(){
    const {items, total} = await api.list(state);
    notesEl.innerHTML = '';
    items.forEach(addCard);
    renderPager(total);
  }

  function addCard(n){
    const tpl = document.getElementById('note-card');
    const node = tpl.content.cloneNode(true);
    const a = node.querySelector('.card-link');
    const time = node.querySelector('.time');
    const pre = node.querySelector('.snippet');
    const del = node.querySelector('.delete');
    a.textContent = n.source_url || 'No URL';
    if(n.source_url) a.href = n.source_url; else a.removeAttribute('href');
    time.textContent = new Date(n.created_at).toLocaleString();
    pre.textContent = (n.text||'').slice(0, 1000);
    del.addEventListener('click', async ()=>{
      if(confirm('Delete this note?')){ await api.del(n.id); loadNotes(); }
    });
    notesEl.appendChild(node);
  }

  function renderPager(total){
    const pages = Math.ceil(total / state.limit) || 1;
    const current = Math.floor(state.skip / state.limit) + 1;
    pagerEl.innerHTML = '';
    const mk = (label, on)=>{ const b=document.createElement('button'); b.className='btn'; b.textContent=label; b.onclick=on; return b; };
    pagerEl.appendChild(mk('Prev', ()=>{ state.skip=Math.max(0, state.skip-state.limit); loadNotes(); }));
    const info = document.createElement('span'); info.style.padding='8px'; info.textContent = `${current}/${pages}`; pagerEl.appendChild(info);
    pagerEl.appendChild(mk('Next', ()=>{ state.skip = Math.min((pages-1)*state.limit, state.skip+state.limit); loadNotes(); }));
  }

  refreshBtn.addEventListener('click', ()=>{ state.skip=0; state.q=searchEl.value.trim(); loadNotes(); });
  searchEl.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ state.skip=0; state.q=searchEl.value.trim(); loadNotes(); }});
  loadNotes();

  // Scrape
  const urlEl = document.getElementById('url');
  const scrapeBtn = document.getElementById('scrape');
  const scStatus = document.getElementById('scrape-status');
  const preview = document.getElementById('preview');
  scrapeBtn.addEventListener('click', async ()=>{
    const url = urlEl.value.trim();
    if(!url){ scStatus.textContent = 'Enter a URL'; return; }
    scrapeBtn.disabled=true; scStatus.textContent='Scraping...'; preview.textContent='';
    try{
      const res = await api.scrape(url);
      scStatus.textContent = `Saved ✔ id=${res.id}`;
      preview.textContent = res.markdown || '';
      loadNotes();
    }catch(e){ scStatus.textContent = 'Failed: '+e.message; }
    finally{ scrapeBtn.disabled=false; }
  });

  // New note
  const textEl = document.getElementById('note-text');
  const sourceEl = document.getElementById('note-source');
  const saveBtn = document.getElementById('save');
  const saveStatus = document.getElementById('save-status');
  saveBtn.addEventListener('click', async ()=>{
    const text = textEl.value.trim();
    if(!text){ saveStatus.textContent='Nothing to save'; return; }
    saveBtn.disabled=true; saveStatus.textContent='Saving...';
    try{ const out = await api.save(text, sourceEl.value.trim()); saveStatus.textContent='Saved ✔ id='+out.id; textEl.value=''; sourceEl.value=''; loadNotes(); }
    catch(e){ saveStatus.textContent='Failed: '+e.message; }
    finally{ saveBtn.disabled=false; }
  });
})();
