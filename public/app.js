const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let sites = [], pages = [], jobs = [], currentSiteId = null;
const addDialog = $('#add-dialog'), siteDialog = $('#site-dialog');

function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 3500);
}
async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  let key = localStorage.getItem('nexoraAdminKey') || '';
  if (key) headers.set('x-admin-key', key);
  const send = () => fetch(url, { ...options, headers });
  let res = await send();
  if (res.status === 401 && sessionStorage.getItem('nexoraAdminPrompted') !== '1') {
    sessionStorage.setItem('nexoraAdminPrompted', '1');
    const entered = prompt('ClÃ© administrateur Nexora configurÃ©e dans Cloudflare :', key);
    if (entered) {
      key = entered.trim();
      localStorage.setItem('nexoraAdminKey', key);
      headers.set('x-admin-key', key);
      res = await send();
    }
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `Erreur HTTP ${res.status}`);
  return data;
}
function esc(s='') { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function shortDate(s) { if (!s) return 'Jamais'; const d = new Date(s); return Number.isNaN(d.getTime()) ? 'â€”' : d.toLocaleString('fr-FR', { dateStyle:'short', timeStyle:'short' }); }
function siteCard(site) {
  return `<article class="site-card" data-open="${esc(site.id)}"><div class="site-card-top"><div class="site-favicon">${esc(new URL(site.origin).hostname[0].toUpperCase())}</div><div><h4>${esc(new URL(site.origin).hostname)}</h4><div class="url">${esc(site.origin)}</div></div></div><span class="badge ${site.verified||site.publicSeed?'ok':''}">${site.verified?'âœ“ VÃ©rifiÃ©':'â— VÃ©rification requise'}</span><div class="site-card-bottom"><span>${site.pageCount} page(s) indexÃ©e(s)</span><span>${shortDate(site.lastCrawlAt)}</span></div></article>`;
}
function renderSites() {
  $('#overview-sites').innerHTML = sites.length ? sites.slice(0,3).map(siteCard).join('') : '<div class="panel empty">Aucun site. Cliquez sur Â« Ajouter un site Â» pour commencer.</div>';
  $('#sites-list').innerHTML = sites.length ? sites.map(s => `<div class="site-row"><div class="site-favicon">${esc(new URL(s.origin).hostname[0].toUpperCase())}</div><div class="site-info"><h4>${esc(new URL(s.origin).hostname)} <span class="badge ${s.verified?'ok':''}">${s.publicSeed?'Exploration publique':s.verified?'VÃ©rifiÃ©':'Ã€ vÃ©rifier'}</span></h4><p>${esc(s.origin)} Â· ${s.pageCount} page(s) indexÃ©e(s)</p></div><div class="row-actions"><button class="button outline" data-open="${esc(s.id)}">GÃ©rer</button>${(s.verified||s.publicSeed)?`<button class="button primary" data-crawl="${esc(s.id)}">Explorer</button>`:''}</div></div>`).join('') : '<div class="panel empty">Aucun site enregistrÃ© pour le moment.</div>';
  const old = $('#page-site-filter').value;
  $('#page-site-filter').innerHTML = '<option value="">Tous les sites</option>' + sites.map(s => `<option value="${esc(s.id)}">${esc(new URL(s.origin).hostname)}</option>`).join('');
  $('#page-site-filter').value = old;
  $('#stat-sites').textContent = sites.length;
  $('#stat-verified').textContent = sites.filter(s => s.verified).length;
  $('#stat-pages').textContent = sites.reduce((n,s) => n+s.pageCount,0);
}
function renderJobs() {
  $('#stat-jobs').textContent = jobs.length;
  $('#jobs-list').innerHTML = jobs.length ? `<div>${jobs.slice(0,8).map(j => {const s=sites.find(x=>x.id===j.siteId);return `<div class="job-row"><div><strong>${esc(s ? new URL(s.origin).hostname : 'Site')}</strong><small>DÃ©marrÃ© le ${shortDate(j.startedAt)} Â· ${j.crawled||0} page(s) explorÃ©e(s)</small></div><span class="badge ${j.status==='completed'?'ok':''}">${esc(j.status==='completed'?'TerminÃ©':j.status==='running'?'En cours':j.status==='failed'?'Ã‰chec':j.status)}</span><small>${j.errors||0} erreur(s)</small></div>`}).join('')}</div>` : '<div class="empty">Aucune exploration pour le moment.</div>';
}
function renderPages() {
  const filter = $('#page-site-filter').value;
  const selected = pages.filter(p => !filter || p.siteId === filter);
  $('#pages-list').innerHTML = selected.length ? `<div>${selected.map(p => `<div class="page-row"><div><strong>${esc(p.title || p.url)}</strong><a style="display:block;color:#7dd3fc;overflow-wrap:anywhere" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.url)}</a><small>${esc(p.preview || p.description || "")}</small>${p.error?`<small class="error">${esc(p.error)}</small>`:''}</div><span class="badge ${p.status==='indexed'?'ok':''}">${esc(p.status)}</span><small>${p.httpStatus ? 'HTTP '+p.httpStatus : 'â€”'}<br>${shortDate(p.updatedAt)}</small></div>`).join('')}</div>` : '<div class="empty">Aucune page affichÃ©e. VÃ©rifiez un site puis lancez une exploration.</div>';
}
async function refresh() {
  try {
    [sites, jobs] = await Promise.all([api('/api/sites'), api('/api/jobs')]);
    pages = [];
    for (const s of sites) {
      try { const arr = await api(`/api/sites/${s.id}/pages`); pages.push(...arr.map(p => ({...p, siteId:s.id}))); } catch {}
    }
    renderSites(); renderJobs(); renderPages();
  } catch (e) { toast('Impossible de contacter le serveur : ' + e.message); }
}
function showView(name) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  $(`#${name}-view`).classList.remove('hidden');
  $$('.nav').forEach(n => n.classList.toggle('active', n.dataset.view === name));
  $('#page-title').textContent = ({overview:"Vue d'ensemble",sites:'Mes sites',pages:'Pages indexÃ©es',search:'Tester la recherche'})[name];
  if (name === 'pages') renderPages();
}
function openAdd() { $('#add-error').classList.add('hidden'); $('#site-url').value=''; addDialog.showModal(); }
async function openSite(id) {
  const s = sites.find(x => x.id === id); if (!s) return;
  currentSiteId = id;
  const host = new URL(s.origin).hostname;
  const meta = `<meta name="nexora-site-verification" content="${s.verificationToken}">`;
  const file = `CrÃ©er ${s.origin}/.well-known/nexora-verification.txt\nContenu exact du fichier :\n${s.verificationToken}`;
  const dnsTxt = `Nom : _nexora-verification.${host}\nType : TXT\nValeur : ${s.verificationToken}`;
  $('#site-detail').innerHTML = `<div class="detail-wrap"><div class="dialog-head"><div><div class="eyebrow">PROPRIÃ‰TÃ‰ WEB</div><h2>${esc(host)}</h2><p>${esc(s.origin)}</p></div><button class="close" data-close-site>Ã—</button></div><span class="badge ${s.verified?'ok':''}">${s.verified?'âœ“ PropriÃ©tÃ© vÃ©rifiÃ©e':'â— VÃ©rification requise'}</span><div class="detail-section"><h3>1. VÃ©rifier que vous contrÃ´lez le site</h3><p>Choisissez la mÃ©thode sÃ©lectionnÃ©e lors de la crÃ©ation, ajoutez le jeton ci-dessous, puis cliquez sur Â« VÃ©rifier Â».</p><label>Jeton de vÃ©rification</label><div class="token-box">${esc(s.verificationToken)}</div><div class="code-box">${esc(s.verificationMethod==='file'?file:s.verificationMethod==='dns'?dnsTxt:meta)}</div><div class="detail-actions"><button class="button primary" data-verify="${esc(s.id)}">VÃ©rifier la propriÃ©tÃ©</button><button class="button outline" data-copy="${esc(s.verificationToken)}">Copier le jeton</button></div></div><div class="detail-section"><h3>2. Soumettre le sitemap</h3><p>Le sitemap doit appartenir Ã  ce domaine. Par dÃ©faut, Nexora essaie /sitemap.xml.</p><input id="sitemap-input" value="${esc(s.lastSubmittedSitemap || s.origin+'/sitemap.xml')}" placeholder="https://monsite.fr/sitemap.xml"><div class="detail-actions"><button class="button outline" data-sitemap="${esc(s.id)}">VÃ©rifier le sitemap</button><button class="button primary" data-crawl="${esc(s.id)}" ${s.verified?'':'disabled'}>Lancer le crawler</button></div><div id="site-action-message"></div></div><div class="detail-section"><h3>Statistiques</h3><p>${s.pageCount} page(s) indexÃ©e(s) Â· DerniÃ¨re exploration : ${shortDate(s.lastCrawlAt)}</p></div></div>`;
  siteDialog.showModal();
}
async function verifySite(id) {
  const s = sites.find(x=>x.id===id); if (!s) return;
  try { const r = await api(`/api/sites/${id}/verify`, {method:'POST', body:JSON.stringify({method:s.verificationMethod})}); toast(r.message); await refresh(); openSite(id); }
  catch(e) { toast(e.message); const box=$('#site-action-message'); if(box) box.innerHTML=`<div class="error">${esc(e.message)}</div>`; }
}
async function submitSitemap(id) {
  const input=$('#sitemap-input'); const url=input?.value || '';
  try { const r=await api(`/api/sites/${id}/sitemap`,{method:'POST',body:JSON.stringify({url})}); $('#site-action-message').innerHTML=`<div class="hint">${esc(r.message)} (${r.discoveredUrls} URL)</div>`; toast('Sitemap vÃ©rifiÃ©.'); }
  catch(e) { $('#site-action-message').innerHTML=`<div class="error">${esc(e.message)}</div>`; }
}
async function crawl(id) {
  const sitemap=$('#sitemap-input')?.value;
  try { const r=await api(`/api/sites/${id}/crawl`,{method:'POST',body:JSON.stringify({sitemap})}); toast(r.message); if(siteDialog.open) siteDialog.close(); await refresh(); }
  catch(e) { toast(e.message); }
}
document.addEventListener('click', async e => {
  const nav=e.target.closest('[data-view]'); if(nav) showView(nav.dataset.view);
  const goto=e.target.closest('[data-goto]'); if(goto) showView(goto.dataset.goto);
  if(e.target.closest('#add-top') || e.target.closest('#add-site') || e.target.closest('#hero-add')) openAdd();
  const close=e.target.closest('[data-close]'); if(close) addDialog.close();
  if(e.target.closest('[data-close-site]')) siteDialog.close();
  const open=e.target.closest('[data-open]'); if(open) openSite(open.dataset.open);
  const verify=e.target.closest('[data-verify]'); if(verify) verifySite(verify.dataset.verify);
  const sm=e.target.closest('[data-sitemap]'); if(sm) submitSitemap(sm.dataset.sitemap);
  const cr=e.target.closest('[data-crawl]'); if(cr) crawl(cr.dataset.crawl);
  const cp=e.target.closest('[data-copy]'); if(cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); toast('Jeton copiÃ©.'); } catch { toast('Copiez le jeton manuellement.'); } }
});
$('#add-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn=$('#create-site-btn'); btn.disabled=true; btn.textContent='CrÃ©ationâ€¦';
  try {
    const site=await api('/api/sites',{method:'POST',body:JSON.stringify({url:$('#site-url').value,method:$('#verify-method').value})});
    addDialog.close(); await refresh(); toast('PropriÃ©tÃ© crÃ©Ã©e. Ajoutez le jeton de vÃ©rification.'); openSite(site.id);
  } catch(err) { $('#add-error').textContent=err.message; $('#add-error').classList.remove('hidden'); }
  finally { btn.disabled=false; btn.textContent='CrÃ©er la propriÃ©tÃ©'; }
});
$('#page-site-filter').addEventListener('change',renderPages);
$('#search-form').addEventListener('submit', async e => {
  e.preventDefault(); const q=$('#search-query').value.trim(); if(q.length<2) return;
  const out=$('#search-results'); out.innerHTML='<div class="panel empty">Recherche en coursâ€¦</div>';
  try {
    const r=await api('/api/search?q='+encodeURIComponent(q));
    out.innerHTML=r.results.length ? `<p style="color:#8793a5;font-size:11px;margin:18px 3px">${r.results.length} rÃ©sultat(s) dans votre index</p>`+r.results.map(x=>`<article class="result"><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a><div class="result-url">${esc(x.url)}</div><p>${esc(x.description)}</p></article>`).join('') : '<div class="panel empty">Aucun rÃ©sultat. VÃ©rifiez un site et lancez une exploration pour crÃ©er votre index.</div>';
  } catch(err) { out.innerHTML=`<div class="error">${esc(err.message)}</div>`; }
});
refresh();
setInterval(refresh, 10000);

