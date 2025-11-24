/* global API_BASE */
(function(){
  // Load persisted API base or default to local FastAPI
  window.API_BASE = (localStorage.getItem('API_BASE') || 'http://localhost:5000').replace(/\/$/, '');
  const routes = {
    notes: document.getElementById('panel-notes'),
    search: document.getElementById('panel-search'),
    docs: document.getElementById('panel-docs'),
    topics: document.getElementById('panel-topics'),
    scrape: document.getElementById('panel-scrape'),
    rollup: document.getElementById('panel-rollup'),
    agents: document.getElementById('panel-agents'),
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
    },
    async docs({q='', topic='', date='', skip=0, limit=20}={}){
      const params = new URLSearchParams({skip, limit});
      if(q) params.set('q', q);
      if(topic) params.set('topic', topic);
      if(date) params.set('date', date);
      const res = await fetch(`${this.base()}/documents?${params.toString()}`);
      if(!res.ok) throw new Error('Failed to load documents');
      return res.json();
    },
    async chunks({doc_id, topic='', date='', skip=0, limit=100}){
      const params = new URLSearchParams({skip, limit});
      if(doc_id) params.set('doc_id', doc_id);
      if(topic) params.set('topic', topic);
      if(date) params.set('date', date);
      const res = await fetch(`${this.base()}/chunks?${params.toString()}`);
      if(!res.ok) throw new Error('Failed to load chunks');
      return res.json();
    },
    async ingestFromText({text, url, title}){
      const body = {
        text,
        source_url: url || location.origin,
        title: title || 'Untitled',
        content_type: 'web',
        chunk_size: 1000,
        chunk_overlap: 150,
      };
      const res = await fetch(`${this.base()}/agent/ingest-text`, { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
      if(!res.ok) throw new Error(await res.text());
      return res.json();
    },
    async ingestUrl({url}){
      const res = await fetch(`${this.base()}/agent/ingest-url`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url, chunk_size: 1000, chunk_overlap: 150 })});
      if(!res.ok) throw new Error(await res.text());
      return res.json();
    },
    async rollupDay({date, rebuild=false}){
      const res = await fetch(`${this.base()}/rollup/day`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ date, rebuild })});
      if(!res.ok) throw new Error(await res.text());
      return res.json();
    },
    async summarizeDoc(id, {sentences=3, bullets=5}={}){
      const res = await fetch(`${this.base()}/summarize/doc/${id}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ sentences, bullets, save: true })});
      if(!res.ok) throw new Error(await res.text());
      return res.json();
    },
    async semanticSearch({query, scope='chunks', date='', topic='', top_k=10}){
      const res = await fetch(`${this.base()}/search/semantic`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ query, scope, date, topic, top_k })});
      if(!res.ok) throw new Error(await res.text());
      return res.json();
    }
    }
    , async summarizeText({text, sentences=3, bullets=5}){
      const res = await fetch(`${this.base()}/summarize/text`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text, sentences, bullets })});
      if(!res.ok) throw new Error(await res.text());
      return res.json();
    },
    async agentStatus(){
      const res = await fetch(`${this.base()}/agent/status`);
      if(!res.ok) throw new Error(await res.text());
      return res.json();
    },
    async agentIngestText({text, chunk_size=1000, chunk_overlap=150}){
      const res = await fetch(`${this.base()}/agent/ingest-text`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text, chunk_size, chunk_overlap })});
      if(!res.ok) throw new Error(await res.text());
      return res.json();
    },
    async agentIngestUrl({url, chunk_size=1000, chunk_overlap=150}){
      const res = await fetch(`${this.base()}/agent/ingest-url`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url, chunk_size, chunk_overlap })});
      if(!res.ok) throw new Error(await res.text());
      return res.json();
    },
    async agentCategorizeDoc(id){
      const res = await fetch(`${this.base()}/categorize/doc/${id}`, { method:'POST' });
      if(!res.ok) throw new Error(await res.text());
      return res.json();
    },
    async agentReprocessDoc(id, {chunk_size=1000, chunk_overlap=150, replace_chunks=true}={}){
      const res = await fetch(`${this.base()}/reprocess/doc/${id}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ chunk_size, chunk_overlap, replace_chunks })});
      if(!res.ok) throw new Error(await res.text());
      return res.json();
    },
    async topics({q='', limit=100}={}){
      const params = new URLSearchParams({ limit }); if(q) params.set('q', q);
      const res = await fetch(`${this.base()}/topics?${params.toString()}`);
      if(!res.ok) throw new Error(await res.text());
      return res.json();
    },
    async renameTopic({from_topic, to_topic}){
      const res = await fetch(`${this.base()}/topics/rename`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ from_topic, to_topic })});
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
  const scrapeDocsBtn = document.getElementById('scrapeDocs');
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
  if (scrapeDocsBtn) {
    scrapeDocsBtn.addEventListener('click', async ()=>{
      const url = urlEl.value.trim();
      if(!url){ scStatus.textContent = 'Enter a URL'; return; }
      scrapeDocsBtn.disabled=true; scStatus.textContent='Agent ingesting...'; preview.textContent='';
      try{
        await api.ingestUrl({ url });
        scStatus.textContent = `Agent saved document ✔`;
        try{ loadDocs(); }catch(_){ }
      }catch(e){ scStatus.textContent = 'Failed: '+e.message; }
      finally{ scrapeDocsBtn.disabled=false; }
    });
  }

  // New note
  const textEl = document.getElementById('note-text');
  const sourceEl = document.getElementById('note-source');
  const saveBtn = document.getElementById('save');
  const saveDocBtn = document.getElementById('saveDoc');
  const saveStatus = document.getElementById('save-status');
  saveBtn.addEventListener('click', async ()=>{
    const text = textEl.value.trim();
    if(!text){ saveStatus.textContent='Nothing to save'; return; }
    saveBtn.disabled=true; saveStatus.textContent='Saving...';
    try{ const out = await api.save(text, sourceEl.value.trim()); saveStatus.textContent='Saved ✔ id='+out.id; textEl.value=''; sourceEl.value=''; loadNotes(); }
    catch(e){ saveStatus.textContent='Failed: '+e.message; }
    finally{ saveBtn.disabled=false; }
  });
  if (saveDocBtn) {
    saveDocBtn.addEventListener('click', async ()=>{
      const text = textEl.value.trim();
      if(!text){ saveStatus.textContent='Nothing to save'; return; }
      saveDocBtn.disabled=true; saveStatus.textContent='Saving → Docs...';
      try{ const out = await api.ingestFromText({text, url: sourceEl.value.trim() || undefined}); saveStatus.textContent='Saved to Docs ✔ id='+out.id; textEl.value=''; sourceEl.value=''; try{ loadDocs(); }catch(_){ } }
      catch(e){ saveStatus.textContent='Failed: '+e.message; }
      finally{ saveDocBtn.disabled=false; }
    });
  }

  // Docs panel
  const dqEl = document.getElementById('dq');
  const dtEl = document.getElementById('dtopic');
  const ddEl = document.getElementById('ddate');
  const dRefresh = document.getElementById('drefresh');
  const docsEl = document.getElementById('docs');
  const dPager = document.getElementById('dpager');
  const docDetail = document.getElementById('docdetail');
  const dstate = { q:'', topic:'', date:'', skip:0, limit:20 };
  function docCard(d){
    const el = document.createElement('article'); el.className='card';
    const h = document.createElement('div'); h.className='card-head';
    const a = document.createElement('a'); a.className='card-link'; a.textContent = d.title || (d.source_url||'').slice(0,60); a.href=d.canonical_url||d.source_url||'#'; a.target='_blank'; a.rel='noopener';
    const t = document.createElement('time'); t.className='time'; t.textContent = d.captured_at? new Date(d.captured_at).toLocaleString() : '';
    h.appendChild(a); h.appendChild(t);
    const s = document.createElement('pre'); s.className='snippet'; s.textContent = (d.summary || '').toString().trim();
    el.appendChild(h); el.appendChild(s);
    const act = document.createElement('div'); act.className='card-actions';
    const view = document.createElement('button'); view.className='btn'; view.textContent='View chunks';
    view.onclick = async ()=>{
      if(docDetail){ docDetail.style.display='block'; docDetail.innerHTML='Loading chunks...'; }
      try{ const out = await api.chunks({doc_id: d.id, limit: 200});
        const items = out.items||[];
        const wrap = document.createElement('div');
        wrap.innerHTML = `<h3 style="margin-top:0">Chunks (${items.length})</h3>`;
        items.forEach(c=>{
          const p = document.createElement('pre'); p.className='snippet'; p.textContent = c.text||''; wrap.appendChild(p);
        });
        if(docDetail){ docDetail.innerHTML=''; docDetail.appendChild(wrap); }
      } catch(e){ if(docDetail) docDetail.textContent='Failed: '+e.message; }
    };
    const sum = document.createElement('button'); sum.className='btn'; sum.textContent='Summarize';
    sum.onclick = async ()=>{
      sum.disabled=true; const old=sum.textContent; sum.textContent='Summarizing...';
      try{ const out = await api.summarizeDoc(d.id, { sentences: 3, bullets: 5 }); s.textContent = (out.short||'').toString().trim(); }
      catch(e){ alert('Failed: '+e.message); }
      finally{ sum.disabled=false; sum.textContent=old; }
    };
    const cat = document.createElement('button'); cat.className='btn'; cat.textContent='Categorize';
    cat.onclick = async ()=>{
      cat.disabled=true; const old=cat.textContent; cat.textContent='Categorizing...';
      try{ const out = await api.agentCategorizeDoc(d.id); s.textContent = (out && out.primary) ? `Topic: ${out.primary}` : (s.textContent||''); }
      catch(e){ alert('Failed: '+e.message); }
      finally{ cat.disabled=false; cat.textContent=old; }
    };
    const rp = document.createElement('button'); rp.className='btn'; rp.textContent='Reprocess';
    rp.onclick = async ()=>{
      rp.disabled=true; const old=rp.textContent; rp.textContent='Reprocessing...';
      try{ await api.agentReprocessDoc(d.id, { chunk_size: 1000, chunk_overlap: 150, replace_chunks: true }); alert('Reprocessed'); }
      catch(e){ alert('Failed: '+e.message); }
      finally{ rp.disabled=false; rp.textContent=old; }
    };
    act.appendChild(view); act.appendChild(sum); act.appendChild(cat); act.appendChild(rp); el.appendChild(act);
    return el;
  }
  async function loadDocs(){
    if(!docsEl) return;
    docsEl.innerHTML='Loading...'; if(docDetail){ docDetail.style.display='none'; docDetail.innerHTML=''; }
    try{
      const out = await api.docs({ q: dstate.q, topic: dstate.topic, date: dstate.date, skip: dstate.skip, limit: dstate.limit });
      docsEl.innerHTML='';
      (out.items||[]).forEach(d=> docsEl.appendChild(docCard(d)) );
      if(dPager){ dPager.innerHTML=''; const pages = Math.ceil((out.total||0)/dstate.limit)||1; const current = Math.floor(dstate.skip/dstate.limit)+1;
      const mk = (label, on)=>{ const b=document.createElement('button'); b.className='btn'; b.textContent=label; b.onclick=on; return b; };
      dPager.appendChild(mk('Prev', ()=>{ dstate.skip=Math.max(0, dstate.skip-dstate.limit); loadDocs(); }));
      const info = document.createElement('span'); info.style.padding='8px'; info.textContent = `${current}/${pages}`; dPager.appendChild(info);
      dPager.appendChild(mk('Next', ()=>{ dstate.skip=Math.min((pages-1)*dstate.limit, dstate.skip+dstate.limit); loadDocs(); })); }
    }catch(e){ docsEl.textContent='Failed: '+e.message; }
  }
  if(dRefresh){ dRefresh.addEventListener('click', ()=>{ dstate.skip=0; dstate.q=dqEl.value.trim(); dstate.topic=dtEl.value.trim(); dstate.date=ddEl.value; loadDocs(); }); }
  if(dqEl){ dqEl.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ if(dRefresh) dRefresh.click(); }}); }
  if(dtEl){ dtEl.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ if(dRefresh) dRefresh.click(); }}); }
  if(ddEl){ ddEl.addEventListener('change', ()=> dRefresh && dRefresh.click()); }

  // Rollup panel
  const rdate = document.getElementById('rdate');
  const rrebuild = document.getElementById('rrebuild');
  const rbuild = document.getElementById('rbuild');
  const rstatus = document.getElementById('rstatus');
  const rview = document.getElementById('rview');
  if (rdate) { try{ const today = new Date().toISOString().slice(0,10); rdate.value = today; }catch(_){ } }
  if (rbuild) {
    rbuild.addEventListener('click', async ()=>{
      const date = rdate && rdate.value; if(!date){ if(rstatus) rstatus.textContent='Pick a date'; return; }
      rbuild.disabled=true; if(rstatus) rstatus.textContent='Building...'; if(rview) rview.innerHTML='';
      try{ const out = await api.rollupDay({ date, rebuild: !!(rrebuild && rrebuild.checked) });
        if(rstatus) rstatus.textContent='OK';
        if(rview){ const wrap = document.createElement('div');
          const h = document.createElement('h3'); h.textContent = `${date} Summary`; wrap.appendChild(h);
          const p = document.createElement('p'); p.textContent = out.summary || ''; wrap.appendChild(p);
          const ul = document.createElement('ul'); (out.bullets||[]).forEach(b=>{ const li=document.createElement('li'); li.textContent=b; ul.appendChild(li); }); wrap.appendChild(ul);
          const top = document.createElement('div'); top.style.color='var(--muted)';
          top.textContent = 'Top topics: ' + (out.top_topics||[]).map(t=>`${t.topic}(${t.count})`).join(', ');
          wrap.appendChild(top);
          rview.innerHTML=''; rview.appendChild(wrap); }
      }catch(e){ if(rstatus) rstatus.textContent='Failed: '+e.message; }
      finally{ rbuild.disabled=false; }
    });
  }

  // On load
  try{ loadDocs(); }catch(_){ }

  // Agents panel
  const astatus = document.getElementById('astatus');
  const astatusview = document.getElementById('astatusview');
  const atext = document.getElementById('atext');
  const achunk = document.getElementById('achunk');
  const aoverlap = document.getElementById('aoverlap');
  const aingestText = document.getElementById('aingestText');
  const aingestTextStatus = document.getElementById('aingestTextStatus');
  const aurl = document.getElementById('aurl');
  const auchunk = document.getElementById('auchunk');
  const auoverlap = document.getElementById('auoverlap');
  const aingestUrl = document.getElementById('aingestUrl');
  const aingestUrlStatus = document.getElementById('aingestUrlStatus');
  const abulk = document.getElementById('abulk');
  const abulkrun = document.getElementById('abulkrun');
  const abulkstatus = document.getElementById('abulkstatus');
  const aaq = document.getElementById('aaq');
  const aascope = document.getElementById('aascope');
  const aatopk = document.getElementById('aatopk');
  const aarun = document.getElementById('aarun');
  const aastatus = document.getElementById('aastatus');
  const aaview = document.getElementById('aaview');
  const actext = document.getElementById('actext');
  const acrun = document.getElementById('acrun');
  const acstatus = document.getElementById('acstatus');
  const acview = document.getElementById('acview');
  const acdocid = document.getElementById('acdocid');
  const acdocrun = document.getElementById('acdocrun');
  const acdocstatus = document.getElementById('acdocstatus');
  const arpdocid = document.getElementById('arpdocid');
  const arpchunk = document.getElementById('arpchunk');
  const arpoverlap = document.getElementById('arpoverlap');
  const arpreplace = document.getElementById('arpreplace');
  const arprun = document.getElementById('arprun');
  const arpstatus = document.getElementById('arpstatus');

  async function loadAgentStatus(){
    if(!astatusview) return;
    astatusview.textContent='Loading status...';
    try{
      const s = await api.agentStatus();
      astatusview.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">
          <div class="card"><b>LangGraph</b><div>${s.langgraph?'enabled':'disabled'}</div></div>
          <div class="card"><b>LangChain</b><div>${s.langchain?'enabled':'disabled'}</div></div>
          <div class="card"><b>Embeddings</b><div>${s.embedding_provider||'none'}</div></div>
          <div class="card"><b>Qdrant</b><div>${s.qdrant?.enabled?'enabled':'disabled'}${s.qdrant?.enabled?` (${s.qdrant.collections.docs}, ${s.qdrant.collections.chunks}, dim=${s.qdrant.vector_size})`:''}</div></div>
          <div class="card"><b>Firecrawl</b><div>${(s.env&&s.env.FIRECRAWL_BASE_URL)||''}</div></div>
        </div>`;
    }catch(e){ astatusview.textContent='Failed: '+e.message; }
  }
  if(astatus){ astatus.addEventListener('click', loadAgentStatus); }
  try{ loadAgentStatus(); }catch(_){ }

  if(aingestText){ aingestText.addEventListener('click', async ()=>{
    const t = (atext.value||'').trim(); if(!t){ aingestTextStatus.textContent='Paste text'; return; }
    aingestText.disabled=true; aingestTextStatus.textContent='Ingesting...';
    try{ const out = await api.agentIngestText({ text: t, chunk_size: parseInt(achunk.value||'1000',10), chunk_overlap: parseInt(aoverlap.value||'150',10) }); aingestTextStatus.textContent='Saved ✔ id='+out.id; atext.value=''; }
    catch(e){ aingestTextStatus.textContent='Failed: '+e.message; }
    finally{ aingestText.disabled=false; }
  }); }

  if(aingestUrl){ aingestUrl.addEventListener('click', async ()=>{
    const u = (aurl.value||'').trim(); if(!u){ aingestUrlStatus.textContent='Enter a URL'; return; }
    aingestUrl.disabled=true; aingestUrlStatus.textContent='Ingesting...';
    try{ const out = await api.agentIngestUrl({ url: u, chunk_size: parseInt(auchunk.value||'1000',10), chunk_overlap: parseInt(auoverlap.value||'150',10)}); aingestUrlStatus.textContent='Saved ✔ id='+out.id; }
    catch(e){ aingestUrlStatus.textContent='Failed: '+e.message; }
    finally{ aingestUrl.disabled=false; }
  }); }

  if(abulkrun){ abulkrun.addEventListener('click', async ()=>{
    const lines = (abulk.value||'').split(/\n+/).map(l=>l.trim()).filter(Boolean);
    if(!lines.length){ abulkstatus.textContent='Add some URLs'; return; }
    abulkrun.disabled=true; abulkstatus.textContent=`Ingesting ${lines.length}...`;
    let ok=0, fail=0;
    for(const u of lines){
      try{ await api.agentIngestUrl({ url: u }); ok++; } catch(e){ fail++; }
      abulkstatus.textContent = `Progress: ${ok+fail}/${lines.length} (ok ${ok}, fail ${fail})`;
    }
    abulkrun.disabled=false;
    abulkstatus.textContent = `Done: ok ${ok}, fail ${fail}`;
  }); }

  if(aarun){ aarun.addEventListener('click', async ()=>{
    const q = (aaq.value||'').trim(); if(!q){ aastatus.textContent='Enter a question'; return; }
    aastatus.textContent='Retrieving...'; aaview.innerHTML='';
    try{
      const out = await api.semanticSearch({ query: q, scope: aascope.value, top_k: parseInt(aatopk.value||'10',10) });
      const texts = (out.items||[]).map(r=> (r.text||r.snippet||'')).join('\n');
      const sum = await api.summarizeText({ text: texts, sentences: 3, bullets: 8 });
      aastatus.textContent='OK';
      const wrap = document.createElement('div');
      const p = document.createElement('p'); p.textContent = sum.short||''; wrap.appendChild(p);
      const ul = document.createElement('ul'); (sum.bullets||[]).forEach(b=>{ const li=document.createElement('li'); li.textContent=b; ul.appendChild(li); }); wrap.appendChild(ul);
      const save = document.createElement('button'); save.className='btn'; save.textContent='Save answer → Docs';
      save.onclick = async ()=>{ save.disabled=true; save.textContent='Saving...'; try{ await api.agentIngestText({ text: [sum.short,...(sum.bullets||[])].filter(Boolean).join('\n')}); save.textContent='Saved ✔'; } catch(e){ save.textContent='Failed'; } };
      aaview.innerHTML=''; aaview.appendChild(wrap); aaview.appendChild(save);
    }catch(e){ aastatus.textContent='Failed: '+e.message; }
  }); }

  if(acrun){ acrun.addEventListener('click', async ()=>{
    const t = (actext.value||'').trim(); if(!t){ acstatus.textContent='Paste text'; return; }
    acstatus.textContent='Categorizing...'; acview.textContent='';
    try{
      const res = await fetch(`${api.base()}/categorize/text`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text: t })});
      const out = await res.json();
      acstatus.textContent='OK';
      acview.textContent = JSON.stringify(out, null, 2);
    }catch(e){ acstatus.textContent='Failed: '+e.message; }
  }); }

  if(acdocrun){ acdocrun.addEventListener('click', async ()=>{
    const id = (acdocid.value||'').trim(); if(!id){ acdocstatus.textContent='Enter document id'; return; }
    acdocrun.disabled=true; acdocstatus.textContent='Categorizing...';
    try{ const out = await api.agentCategorizeDoc(id); acdocstatus.textContent = out && out.primary ? `Topic: ${out.primary}` : 'OK'; }
    catch(e){ acdocstatus.textContent='Failed: '+e.message; }
    finally{ acdocrun.disabled=false; }
  }); }

  if(arprun){ arprun.addEventListener('click', async ()=>{
    const id = (arpdocid.value||'').trim(); if(!id){ arpstatus.textContent='Enter document id'; return; }
    arprun.disabled=true; arpstatus.textContent='Reprocessing...';
    try{ const out = await api.agentReprocessDoc(id, { chunk_size: parseInt(arpchunk.value||'1000',10), chunk_overlap: parseInt(arpoverlap.value||'150',10), replace_chunks: !!(arpreplace && arpreplace.checked) }); arpstatus.textContent = `OK (inserted ${out.inserted}, replaced ${out.replaced})`; }
    catch(e){ arpstatus.textContent='Failed: '+e.message; }
    finally{ arprun.disabled=false; }
  }); }

  // Search panel
  const smode = document.getElementById('smode');
  const squery = document.getElementById('sq');
  const sscope = document.getElementById('sscope');
  const stopic = document.getElementById('stopic');
  const sdate = document.getElementById('sdate');
  const sgo = document.getElementById('sgo');
  const sresults = document.getElementById('sresults');
  async function runSearch(){
    const mode = smode.value;
    const q = (squery.value||'').trim(); if(!q){ sresults.textContent='Enter a query'; return; }
    sresults.textContent='Searching...';
    try{
      if(mode==='keyword'){
        const out = await api.docs({ q, topic: stopic.value.trim(), date: sdate.value, skip:0, limit: 20 });
        sresults.innerHTML='';
        (out.items||[]).forEach(d=> sresults.appendChild(docCard(d)) );
      }else{
        const out = await api.semanticSearch({ query: q, scope: sscope.value, date: sdate.value, topic: stopic.value.trim() });
        sresults.innerHTML='';
        (out.items||[]).forEach(r=>{
          if(r.type==='doc'){
            sresults.appendChild(docCard({ id:r.id, title:r.title, source_url:r.source_url, captured_at:r.captured_at, summary:r.snippet }));
          }else{
            const el = document.createElement('article'); el.className='card';
            const h = document.createElement('div'); h.className='card-head';
            const t = document.createElement('time'); t.className='time'; t.textContent = r.captured_at? new Date(r.captured_at).toLocaleString(): '';
            const span = document.createElement('span'); span.textContent = `Chunk • score ${r.score?.toFixed? r.score.toFixed(3): r.score||''}`; span.style.color='var(--muted)';
            h.appendChild(span); h.appendChild(t); el.appendChild(h);
            const pre = document.createElement('pre'); pre.className='snippet'; pre.textContent = r.text||''; el.appendChild(pre);
            sresults.appendChild(el);
          }
        });
      }
    }catch(e){ sresults.textContent='Failed: '+e.message; }
  }
  if(sgo){ sgo.addEventListener('click', runSearch); }
  if(squery){ squery.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ runSearch(); } }); }

  // Learned (time band) in Rollup
  const ldate = document.getElementById('ldate');
  const lhfrom = document.getElementById('lhfrom');
  const lhto = document.getElementById('lhto');
  const lsummarize = document.getElementById('lsummarize');
  const lstatus = document.getElementById('lstatus');
  const lview = document.getElementById('lview');
  if(ldate){ try{ ldate.value = new Date().toISOString().slice(0,10);}catch(_){ } }
  if(lsummarize){ lsummarize.addEventListener('click', async ()=>{
    const date = ldate && ldate.value; const h1 = parseInt(lhfrom.value||'0',10); const h2 = parseInt(lhto.value||'23',10);
    if(!date){ lstatus.textContent='Pick date'; return; }
    const from = new Date(`${date}T${String(Math.max(0,Math.min(23,h1))).padStart(2,'0')}:00:00Z`).toISOString();
    const to = new Date(`${date}T${String(Math.max(0,Math.min(23,h2))).padStart(2,'0')}:59:59Z`).toISOString();
    lstatus.textContent='Loading...'; lview.innerHTML='';
    try{
      const params = new URLSearchParams({ start: from, end: to, limit: '100' });
      const res = await fetch(`${api.base()}/documents?`+params.toString());
      const data = await res.json();
      const texts = (data.items||[]).map(d=> d.summary || '').join('\n');
      const resp = await fetch(`${api.base()}/summarize/text`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text: texts || ' ', sentences: 3, bullets: 8 }) });
      const out = await resp.json();
      lstatus.textContent='OK';
      const wrap = document.createElement('div');
      const p = document.createElement('p'); p.textContent = out.short || ''; wrap.appendChild(p);
      const ul = document.createElement('ul'); (out.bullets||[]).forEach(b=>{ const li=document.createElement('li'); li.textContent=b; ul.appendChild(li); }); wrap.appendChild(ul);
      lview.innerHTML=''; lview.appendChild(wrap);
    }catch(e){ lstatus.textContent='Failed: '+e.message; }
  }); }

  // Topics panel
  const tq = document.getElementById('tq');
  const trefresh = document.getElementById('trefresh');
  const tfrom = document.getElementById('tfrom');
  const tto = document.getElementById('tto');
  const trename = document.getElementById('trename');
  const tstatus = document.getElementById('tstatus');
  const tgrid = document.getElementById('topics');
  const tview = document.getElementById('tview');
  async function loadTopics(){
    if(!tgrid) return;
    tgrid.innerHTML='Loading...';
    try{
      const out = await api.topics({ q: (tq && tq.value||'').trim() });
      tgrid.innerHTML='';
      (out.items||[]).forEach(item=>{
        const el = document.createElement('article'); el.className='card';
        const h = document.createElement('div'); h.className='card-head';
        const a = document.createElement('a'); a.className='card-link'; a.textContent = item.topic || '(none)'; a.href = '#'; a.onclick=(e)=>{ e.preventDefault(); tfrom.value = item.topic; loadTopicDocs(item.topic); };
        const c = document.createElement('span'); c.className='time'; c.textContent = String(item.count);
        h.appendChild(a); h.appendChild(c); el.appendChild(h);
        tgrid.appendChild(el);
      });
    }catch(e){ tgrid.textContent='Failed: '+e.message; }
  }
  async function loadTopicDocs(topic){
    tview.innerHTML='Loading...';
    try{ const out = await api.docs({ topic, limit: 20 });
      const wrap = document.createElement('div');
      wrap.innerHTML = `<h3 style="margin-top:0">Docs for ${topic}</h3>`;
      (out.items||[]).forEach(d=> wrap.appendChild(docCard(d)) );
      tview.innerHTML=''; tview.appendChild(wrap);
    }catch(e){ tview.textContent='Failed: '+e.message; }
  }
  if(trefresh){ trefresh.addEventListener('click', loadTopics); }
  if(trename){ trename.addEventListener('click', async ()=>{
    const from = (tfrom.value||'').trim(); const to = (tto.value||'').trim(); if(!from || !to){ tstatus.textContent='Enter from/to'; return; }
    trename.disabled=true; tstatus.textContent='Renaming...';
    try{ const out = await api.renameTopic({ from_topic: from, to_topic: to }); tstatus.textContent=`OK (modified ${out.modified})`; loadTopics(); }
    catch(e){ tstatus.textContent='Failed: '+e.message; }
    finally{ trename.disabled=false; }
  }); }
  try{ loadTopics(); }catch(_){ }
})();
