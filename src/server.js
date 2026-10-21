const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const net = require('node:net');

const app = express();
const PORT = Number(process.env.PORT || 3080);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const VERIFY_PREFIX = 'nexora-site-verification=';

fs.mkdirSync(DATA_DIR, { recursive: true });
app.use(express.json({ limit: '200kb' }));
app.use(express.static(PUBLIC_DIR));

let db = { sites: [], pages: [], jobs: [] };
try {
  if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
} catch (e) {
  console.error('La base JSON est illisible. Une nouvelle base sera créée.', e.message);
}
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function id() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function normalizeSite(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch { throw new Error('URL invalide. Exemple : https://monsite.fr'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Seules les URL HTTP et HTTPS sont acceptées.');
  if (u.username || u.password) throw new Error('Les URL avec identifiants intégrés ne sont pas acceptées.');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('Les ports personnalisés ne sont pas acceptés.');
  u.hash = '';
  u.search = '';
  u.pathname = '/';
  return u.origin;
}
function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    p[0] >= 224;
}
function isPrivateIPv6(ip) {
  const s = ip.toLowerCase();
  return s === '::1' || s === '::' || s.startsWith('fe80:') ||
    s.startsWith('fc') || s.startsWith('fd') || s.startsWith('ff') ||
    s.startsWith('::ffff:127.') || s.startsWith('::ffff:10.') ||
    s.startsWith('::ffff:192.168.');
}
async function assertPublicUrl(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Protocole non autorisé.');
  if (u.username || u.password) throw new Error('Identifiants URL interdits.');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Les hôtes locaux/privés ne peuvent pas être explorés.');
  }
  if (net.isIP(host)) {
    if ((net.isIPv4(host) && isPrivateIPv4(host)) || (net.isIPv6(host) && isPrivateIPv6(host))) {
      throw new Error('Les adresses IP privées ne peuvent pas être explorées.');
    }
  } else {
    let addresses;
    try { addresses = await dns.lookup(host, { all: true, verbatim: true }); }
    catch { throw new Error('Le domaine ne résout pas vers une adresse IP valide.'); }
    if (!addresses.length || addresses.some(a =>
      (net.isIPv4(a.address) && isPrivateIPv4(a.address)) ||
      (net.isIPv6(a.address) && isPrivateIPv6(a.address)))) {
      throw new Error('Le domaine pointe vers une adresse IP privée ou non autorisée.');
    }
  }
  return u;
}
async function safeFetch(raw, options = {}) {
  let current = raw;
  for (let hop = 0; hop <= 4; hop++) {
    const u = await assertPublicUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || 10000);
    let response;
    try {
      response = await fetch(u, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'NexoraBot/1.0 (+site crawler; respectful indexing)', 'Accept': options.accept || 'text/html,application/xml,text/plain,*/*;q=0.5' }
      });
    } finally { clearTimeout(timer); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const loc = response.headers.get('location');
      if (!loc) return response;
      if (hop === 4) throw new Error('Trop de redirections.');
      current = new URL(loc, u).href;
      continue;
    }
    return response;
  }
  throw new Error('Trop de redirections.');
}
function findSiteByUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  return db.sites.find(s => s.origin === u.origin && s.verified) || null;
}
function siteHostMatches(site, url) {
  try { return new URL(url).origin === site.origin; } catch { return false; }
}
function decodeEntities(s) {
  return s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32));
}
function stripHtml(html) {
  return decodeEntities(String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/article|\/section)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim().slice(0, 50000);
}
function getTag(html, tag, attr) {
  const re = new RegExp('<' + tag + '\\b([^>]*)>', 'i');
  const m = html.match(re);
  if (!m) return '';
  const a = m[1].match(new RegExp("\\b" + attr + "\\s*=\\s*[\"']([^\"']*)[\"']", "i"));
  return a ? decodeEntities(a[1]) : '';
}
function extractLinks(html, baseUrl) {
  const links = [];
  const re = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) && links.length < 300) {
    const href = decodeEntities(m[1] || m[2] || m[3] || '').trim();
    if (!href || href.startsWith('#') || /^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    try {
      const u = new URL(href, baseUrl);
      if (['http:', 'https:'].includes(u.protocol)) {
        u.hash = '';
        links.push(u.href);
      }
    } catch {}
  }
  return [...new Set(links)];
}
function parseSitemap(xml, base) {
  const urls = [];
  const locRe = /<loc\b[^>]*>\s*([\s\S]*?)\s*<\/loc>/gi;
  let m;
  while ((m = locRe.exec(xml)) && urls.length < 5000) {
    const val = decodeEntities(m[1].trim()).replace(/&amp;/g, '&');
    try { urls.push(new URL(val, base).href); } catch {}
  }
  return [...new Set(urls)];
}
async function getRobots(origin) {
  try {
    const r = await safeFetch(new URL('/robots.txt', origin).href, { accept: 'text/plain,*/*;q=0.5', timeout: 7000 });
    if (!r.ok) return { text: '', disallow: [], sitemaps: [] };
    const text = (await r.text()).slice(0, 200000);
    const lines = text.split(/\r?\n/);
    let applies = false;
    const disallow = [];
    const sitemaps = [];
    for (const line of lines) {
      const [keyRaw, ...v] = line.split(':');
      if (!keyRaw || !v.length) continue;
      const key = keyRaw.trim().toLowerCase();
      const value = v.join(':').trim();
      if (key === 'user-agent') applies = value === '*' || /nexorabot/i.test(value);
      if (key === 'disallow' && applies && value) disallow.push(value);
      if (key === 'sitemap' && value) sitemaps.push(value);
    }
    return { text, disallow, sitemaps };
  } catch { return { text: '', disallow: [], sitemaps: [] }; }
}
function robotsAllows(url, rules) {
  const pathAndQuery = new URL(url).pathname + new URL(url).search;
  const blocked = rules.disallow.filter(p => p && p !== '/').some(p => pathAndQuery.startsWith(p));
  return !blocked && !rules.disallow.includes('/');
}
function upsertPage(siteId, page) {
  const existing = db.pages.find(p => p.siteId === siteId && p.url === page.url);
  if (existing) Object.assign(existing, page, { updatedAt: new Date().toISOString() });
  else db.pages.push({ id: id(), siteId, ...page, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
}
const activeCrawls = new Set();
async function crawlSite(siteId, seedUrls = []) {
  if (activeCrawls.has(siteId)) return;
  const site = db.sites.find(s => s.id === siteId);
  if (!site || !site.verified) throw new Error('Site introuvable ou non vérifié.');
  activeCrawls.add(siteId);
  const job = { id: id(), siteId, status: 'running', startedAt: new Date().toISOString(), crawled: 0, errors: 0 };
  db.jobs.unshift(job); db.jobs = db.jobs.slice(0, 100); saveDb();
  try {
    const robots = await getRobots(site.origin);
    const candidates = [...seedUrls, ...robots.sitemaps];
    if (!candidates.length) candidates.push(new URL('/sitemap.xml', site.origin).href);
    const queue = [];
    for (const candidate of candidates) {
      try {
        const sitemapUrl = new URL(candidate, site.origin).href;
        if (!siteHostMatches(site, sitemapUrl)) continue;
        const res = await safeFetch(sitemapUrl, { accept: 'application/xml,text/xml,text/plain,*/*;q=0.5' });
        if (!res.ok) continue;
        const body = (await res.text()).slice(0, 5_000_000);
        if (/<(?:urlset|sitemapindex)\b/i.test(body)) {
          for (const u of parseSitemap(body, sitemapUrl)) if (siteHostMatches(site, u)) queue.push(u);
        } else if (/\.xml(?:$|\?)/i.test(sitemapUrl)) {
          // A nonstandard sitemap may still contain <loc> entries.
          for (const u of parseSitemap(body, sitemapUrl)) if (siteHostMatches(site, u)) queue.push(u);
        }
      } catch (e) { console.log('Sitemap ignoré:', e.message); }
    }
    if (!queue.length) queue.push(site.origin + '/');
    const seen = new Set();
    const maxPages = 100;
    while (queue.length && job.crawled < maxPages) {
      const raw = queue.shift();
      let u;
      try { u = new URL(raw); u.hash = ''; } catch { continue; }
      if (!siteHostMatches(site, u.href) || seen.has(u.href)) continue;
      seen.add(u.href);
      if (!robotsAllows(u.href, robots)) {
        upsertPage(siteId, { url: u.href, status: 'blocked_robots', httpStatus: null, title: '', description: '', text: '', canonical: '', error: 'Interdit par robots.txt' });
        continue;
      }
      try {
        const res = await safeFetch(u.href, { accept: 'text/html,application/xhtml+xml,*/*;q=0.5', timeout: 10000 });
        const type = res.headers.get('content-type') || '';
        if (!res.ok) {
          upsertPage(siteId, { url: u.href, status: 'error', httpStatus: res.status, title: '', description: '', text: '', canonical: '', error: `HTTP ${res.status}` });
          job.errors++; continue;
        }
        if (!/text\/html|application\/xhtml\+xml/i.test(type)) continue;
        const length = Number(res.headers.get('content-length') || 0);
        if (length > 2_000_000) throw new Error('Page trop volumineuse (>2 Mo).');
        const html = (await res.text()).slice(0, 2_000_000);
        const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
        const title = titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, '').trim()).slice(0, 300) : '';
        const description = getTag(html, 'meta', 'content'); // fallback below picks description accurately
        const metaDescription = (() => {
          const tags = html.match(/<meta\b[^>]*>/gi) || [];
          for (const tag of tags) {
            if (/name\s*=\s*["']description["']/i.test(tag)) {
              const m = tag.match(/content\s*=\s*["']([^"']*)["']/i);
              if (m) return decodeEntities(m[1]).slice(0, 500);
            }
          }
          return '';
        })();
        const canonicalMatch = html.match(/<link\b[^>]*rel\s*=\s*["'][^"']*canonical[^"']*["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/i)
          || html.match(/<link\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["'][^"']*canonical[^"']*["'][^>]*>/i);
        let canonical = '';
        try { if (canonicalMatch) canonical = new URL(decodeEntities(canonicalMatch[1]), u.href).href; } catch {}
        const text = stripHtml(html);
        upsertPage(siteId, { url: u.href, status: 'indexed', httpStatus: res.status, title, description: metaDescription || '', text, canonical, error: '' });
        job.crawled++;
        if (seen.size < maxPages) {
          for (const link of extractLinks(html, u.href)) {
            if (siteHostMatches(site, link) && !seen.has(link) && queue.length < 1000) queue.push(link);
          }
        }
        saveDb();
        await new Promise(r => setTimeout(r, 350));
      } catch (e) {
        upsertPage(siteId, { url: u.href, status: 'error', httpStatus: null, title: '', description: '', text: '', canonical: '', error: e.message.slice(0, 300) });
        job.errors++;
      }
      saveDb();
    }
    job.status = 'completed';
    job.finishedAt = new Date().toISOString();
    site.lastCrawlAt = job.finishedAt;
    saveDb();
  } catch (e) {
    job.status = 'failed'; job.error = e.message; job.finishedAt = new Date().toISOString(); saveDb();
    throw e;
  } finally { activeCrawls.delete(siteId); }
}
function asyncRoute(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'Nexora Indexation', version: '2.0.0', sitesCount: db.sites.length, indexedCount: db.pages.filter(p => p.status === 'indexed').length, jobsCount: db.jobs.length }));

app.get('/api/sites', (_req, res) => {
  res.json(db.sites.map(s => ({
    id: s.id, origin: s.origin, verified: s.verified, verificationToken: s.verificationToken,
    verificationMethod: s.verificationMethod || 'meta', createdAt: s.createdAt, lastCrawlAt: s.lastCrawlAt || null,
    pageCount: db.pages.filter(p => p.siteId === s.id && p.status === 'indexed').length
  })));
});

app.post('/api/sites', (req, res, next) => {
  try {
    const origin = normalizeSite(req.body.url);
    const existing = db.sites.find(s => s.origin === origin);
    if (existing) return res.status(409).json({ error: 'Ce site est déjà enregistré.', siteId: existing.id });
    const site = {
      id: id(), origin, verified: false,
      verificationToken: 'nexora-' + require('node:crypto').randomBytes(18).toString('hex'),
      verificationMethod: ['meta', 'file', 'dns'].includes(req.body.method) ? req.body.method : 'meta',
      createdAt: new Date().toISOString()
    };
    db.sites.push(site); saveDb();
    res.status(201).json(site);
  } catch (e) { next(e); }
});

app.post('/api/sites/:id/verify', asyncRoute(async (req, res) => {
  const site = db.sites.find(s => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: 'Site introuvable.' });
  if (site.verified) return res.json({ ok: true, verified: true, message: 'Site déjà vérifié.' });
  const method = req.body.method || site.verificationMethod || 'meta';
  try {
    if (method === 'meta') {
      const r = await safeFetch(site.origin + '/', { accept: 'text/html,*/*;q=0.5' });
      if (!r.ok) throw new Error(`La page d'accueil répond HTTP ${r.status}.`);
      const html = (await r.text()).slice(0, 2_000_000);
      const token = site.verificationToken;
      const metaOk = new RegExp("<meta\\b(?=[^>]*name\\s*=\\s*[\"']nexora-site-verification[\"'])(?=[^>]*content\\s*=\\s*[\"']" + token + "[\"'])[^>]*>", "i").test(html);
      if (!metaOk) throw new Error('Balise META introuvable. Ajoute la balise indiquée dans le tableau de bord.');
    } else if (method === 'file') {
      const r = await safeFetch(site.origin + '/.well-known/nexora-verification.txt', { accept: 'text/plain,*/*;q=0.5' });
      if (!r.ok || !(await r.text()).trim().split(/\r?\n/).includes(site.verificationToken)) {
        throw new Error('Fichier de vérification introuvable ou jeton incorrect.');
      }
    } else if (method === 'dns') {
      const records = await dns.resolveTxt('_nexora-verification.' + new URL(site.origin).hostname);
      const flattened = records.map(parts => parts.join(''));
      if (!flattened.some(v => safeEqual(v, site.verificationToken))) throw new Error('Enregistrement TXT DNS non trouvé.');
    } else {
      throw new Error('Méthode de vérification inconnue.');
    }
    site.verified = true; site.verifiedAt = new Date().toISOString(); site.verificationMethod = method;
    saveDb();
    res.json({ ok: true, verified: true, message: 'Propriété vérifiée.' });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));

app.post('/api/sites/:id/sitemap', asyncRoute(async (req, res) => {
  const site = db.sites.find(s => s.id === req.params.id);
  if (!site || !site.verified) return res.status(403).json({ error: 'Vérifie d’abord la propriété du site.' });
  const raw = String(req.body.url || (site.origin + '/sitemap.xml')).trim();
  let sitemapUrl;
  try { sitemapUrl = new URL(raw, site.origin).href; } catch { return res.status(400).json({ error: 'URL de sitemap invalide.' }); }
  if (!siteHostMatches(site, sitemapUrl)) return res.status(400).json({ error: 'Le sitemap doit appartenir au domaine vérifié.' });
  const r = await safeFetch(sitemapUrl, { accept: 'application/xml,text/xml,text/plain,*/*;q=0.5' });
  if (!r.ok) return res.status(400).json({ error: `Le sitemap répond HTTP ${r.status}.` });
  const xml = (await r.text()).slice(0, 5_000_000);
  if (!/<(?:urlset|sitemapindex)\b/i.test(xml) || !/<loc\b/i.test(xml)) return res.status(400).json({ error: 'Le document ne semble pas être un sitemap XML valide.' });
  const urls = parseSitemap(xml, sitemapUrl).filter(u => siteHostMatches(site, u));
  if (!urls.length) return res.status(400).json({ error: 'Aucune URL du domaine vérifié trouvée dans ce sitemap.' });
  site.sitemaps = [...new Set([...(site.sitemaps || []), sitemapUrl])];
  site.lastSubmittedSitemap = sitemapUrl; saveDb();
  res.json({ ok: true, sitemap: sitemapUrl, discoveredUrls: urls.length, message: `${urls.length} URL découvertes. Lance une exploration pour les indexer.` });
}));

app.post('/api/sites/:id/crawl', asyncRoute(async (req, res) => {
  const site = db.sites.find(s => s.id === req.params.id);
  if (!site || !site.verified) return res.status(403).json({ error: 'Vérifie d’abord la propriété du site.' });
  if (activeCrawls.has(site.id)) return res.status(409).json({ error: 'Une exploration est déjà en cours pour ce site.' });
  const sitemap = String(req.body.sitemap || site.lastSubmittedSitemap || site.origin + '/sitemap.xml');
  // Respond immediately; crawling runs in background.
  res.status(202).json({ ok: true, message: 'Exploration lancée. Actualise le tableau de bord pour suivre les résultats.' });
  crawlSite(site.id, [sitemap]).catch(e => console.error('Crawler:', e.message));
}));

app.get('/api/sites/:id/pages', (req, res) => {
  const site = db.sites.find(s => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: 'Site introuvable.' });
  const pages = db.pages.filter(p => p.siteId === site.id).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  res.json(pages.map(p => ({ id: p.id, url: p.url, title: p.title, description: p.description, status: p.status, httpStatus: p.httpStatus, canonical: p.canonical, error: p.error, updatedAt: p.updatedAt })));
});

app.get('/api/jobs', (_req, res) => res.json(db.jobs.slice(0, 30)));

app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (q.length < 2) return res.json({ query: q, results: [] });
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const results = db.pages.filter(p => p.status === 'indexed').map(p => {
    const site = db.sites.find(s => s.id === p.siteId);
    if (!site || !site.verified) return null;
    const hay = `${p.title} ${p.description} ${p.text} ${p.url}`.toLowerCase();
    const score = terms.reduce((n, term) => n + (hay.includes(term) ? 1 : 0), 0);
    return score ? { url: p.canonical || p.url, title: p.title || p.url, description: p.description || (p.text || '').slice(0, 220), score } : null;
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 50);
  res.json({ query: q, results });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'Erreur inattendue.' });
});

app.listen(PORT, HOST, () => {
  console.log(`Nexora Indexation démarré : http://${HOST}:${PORT}`);
});
