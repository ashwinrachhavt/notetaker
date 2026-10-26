/* Minimal dashboard: notes only */
(function(){
  const API_BASE = 'http://localhost:8000';

  const routes = {
    notes: document.getElementById('panel-notes'),
    new: document.getElementById('panel-new'),
    palace: document.getElementById('panel-palace'),
  };
  const navLinks = Array.from(document.querySelectorAll('[data-route]'));
  function setRoute(hash){
    const key = (hash || location.hash || '#notes').replace('#','');
    Object.values(routes).forEach(el=> el && el.classList.remove('is-active'));
    (routes[key]||routes.notes).classList.add('is-active');
    navLinks.forEach(a=>a.classList.toggle('is-active', a.getAttribute('href')==='#'+key));
  }
  window.addEventListener('hashchange', ()=>setRoute());
  setRoute();

  const api = {
    base(){ return API_BASE; },
    async list(){
      const params = new URLSearchParams({skip: 0, limit: 20});
      const res = await fetch(`${this.base()}/notes?${params.toString()}`);
      if(!res.ok) throw new Error('Failed to load notes');
      return res.json();
    },
    async del(id){
      const res = await fetch(`${this.base()}/notes/${id}`, {method:'DELETE'});
      if(!res.ok && res.status!==204) throw new Error('Delete failed');
    },
    async save(text, source){
      const res = await fetch(`${this.base()}/notes`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({text, source_url: source || null, metadata:{ui:'extension'}})
      });
      if(!res.ok) throw new Error('Save failed');
      return res.json();
    },
    async mpSearch({q='', topic='', domain='', limit=20}={}){
      const params = new URLSearchParams({ limit: String(limit) });
      if(q) params.set('q', q);
      if(topic) params.set('topic', topic);
      if(domain) params.set('domain', domain);
      const res = await fetch(`${this.base()}/api/mind-palace/search?${params.toString()}`);
      if(!res.ok) throw new Error('Search failed');
      return res.json();
    },
    async mpGetDoc(id){
      const res = await fetch(`${this.base()}/api/mind-palace/doc/${id}`);
      if(!res.ok) throw new Error('Get doc failed');
      return res.json();
    },
  };

  // Notes listing
  const notesEl = document.getElementById('notes');
  let state = {};

  async function loadNotes(){
    const {items} = await api.list();
    if (notesEl) notesEl.innerHTML = '';
    items.forEach(addCard);
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
    time.textContent = n.created_at ? new Date(n.created_at).toLocaleString() : '';
    pre.textContent = (n.text||'').slice(0, 1000);
    del.addEventListener('click', async ()=>{
      if(confirm('Delete this note?')){ await api.del(n.id); loadNotes(); }
    });
    notesEl.appendChild(node);
  }

  // Pagination removed in minimal dashboard

  loadNotes();

  // Mind Palace search wiring
  const mpQ = document.getElementById('mp_q');
  const mpTopic = document.getElementById('mp_topic');
  const mpDomain = document.getElementById('mp_domain');
  const mpBtn = document.getElementById('mp_search');
  const mpResults = document.getElementById('mp_results');
  const mpDoc = document.getElementById('mp_doc');

  async function runMpSearch(){
    if(!mpResults) return;
    mpResults.innerHTML = 'Searching...'; if (mpDoc) mpDoc.innerHTML = '';
    try{
      const out = await api.mpSearch({ q: (mpQ?.value||'').trim(), topic: (mpTopic?.value||'').trim(), domain: (mpDomain?.value||'').trim(), limit: 20 });
      const items = out.items || [];
      mpResults.innerHTML = '';
      items.forEach(it => {
        const el = document.createElement('article'); el.className='card';
        const head = document.createElement('div'); head.className='card-head';
        const title = document.createElement('a'); title.className='card-link'; title.textContent = it.title || (it.source && it.source.url) || it.id || 'Doc'; title.href='#'; title.onclick=(e)=>{ e.preventDefault(); viewDoc(it._id || it.id); };
        head.appendChild(title);
        const time = document.createElement('time'); time.className='time'; if (it.created_at) { try { time.textContent = new Date(it.created_at).toLocaleString(); } catch(_){} }
        head.appendChild(time);
        el.appendChild(head);
        const pre = document.createElement('pre'); pre.className='snippet'; pre.textContent = String(it.summary || it.raw_text || '').slice(0,260);
        el.appendChild(pre);
        mpResults.appendChild(el);
      });
    }catch(e){ mpResults.textContent = 'Failed: '+e.message; }
  }

  async function viewDoc(id){
    if(!mpDoc) return;
    mpDoc.textContent = 'Loading...';
    try{ const doc = await api.mpGetDoc(id); mpDoc.textContent = JSON.stringify(doc, null, 2); }
    catch(e){ mpDoc.textContent = 'Failed: '+e.message; }
  }

  if (mpBtn) mpBtn.addEventListener('click', runMpSearch);
  if (mpQ) mpQ.addEventListener('keydown', (e)=>{ if(e.key==='Enter') runMpSearch(); });

  // New note
  const textEl = document.getElementById('note-text');
  const sourceEl = document.getElementById('note-source');
  const saveBtn = document.getElementById('save');
  const saveStatus = document.getElementById('save-status');
  if (saveBtn) saveBtn.addEventListener('click', async ()=>{
    const text = (textEl && textEl.value || '').trim();
    if(!text){ if (saveStatus) saveStatus.textContent='Nothing to save'; return; }
    saveBtn.disabled=true; if (saveStatus) saveStatus.textContent='Saving...';
    try{ const out = await api.save(text, sourceEl && sourceEl.value.trim()); if (saveStatus) saveStatus.textContent='Saved ✔ id='+out.id; if(textEl) textEl.value=''; if(sourceEl) sourceEl.value=''; loadNotes(); }
    catch(e){ if (saveStatus) saveStatus.textContent='Failed: '+e.message; }
    finally{ saveBtn.disabled=false; }
  });
})();
