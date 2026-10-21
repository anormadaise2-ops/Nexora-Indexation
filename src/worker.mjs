const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const iso = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const rows = async (stmt) => (await stmt.all()).results || [];
const first = async (stmt) => await stmt.first();

function adminGuard(request, env) {
  if (!env.NEXORA_ADMIN_KEY) return json({ error: "ClÃ© admin non configurÃ©e. Ajoute le secret NEXORA_ADMIN_KEY dans Cloudflare." }, 503);
  if (request.headers.get("x-admin-key") !== env.NEXORA_ADMIN_KEY) return json({ error: "ClÃ© administrateur requise ou incorrecte." }, 401);
  return null;
}
async function bodyJson(request) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > 100000) throw new Error("Corps de requÃªte trop volumineux.");
  try { return await request.json(); } catch { throw new Error("JSON invalide."); }
}
function normalizeSite(raw) {
  let u; try { u = new URL(String(raw || "").trim()); } catch { throw new Error("URL invalide. Exemple : https://monsite.fr"); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Seules les URL HTTP et HTTPS sont acceptÃ©es.");
  if (u.username || u.password) throw new Error("Les URL contenant des identifiants sont interdites.");
  if (u.port && !["80", "443"].includes(u.port)) throw new Error("Les ports personnalisÃ©s ne sont pas acceptÃ©s.");
  u.hash = ""; u.search = ""; u.pathname = "/"; return u.origin;
}
function isPrivateHost(host) {
  host = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".test")) return true;
  if (host === "::" || host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("ff") || host.startsWith("::ffff:127.") || host.startsWith("::ffff:10.") || host.startsWith("::ffff:192.168.")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const p = host.split(".").map(Number);
    if (p.some(n => n < 0 || n > 255)) return true;
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
  }
  return false;
}
function publicUrl(raw) {
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new Error("URL HTTP/HTTPS publique requise.");
  if (isPrivateHost(u.hostname)) throw new Error("Les hÃ´tes locaux ou les adresses IP privÃ©es sont interdits.");
  return u;
}
async function safeFetch(raw, accept = "text/html,application/xml,text/plain,*/*;q=0.3", timeoutMs = 3500) {
  let current = raw;
  for (let hop = 0; hop <= 3; hop++) {
    const u = publicUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let r;
    try { r = await fetch(u.href, { redirect: "manual", signal: controller.signal, headers: { "User-Agent": "NexoraBot/1.0 (+https://nexora.example/bot)", "Accept": accept } }); }
    finally { clearTimeout(timer); }
    if ([301,302,303,307,308].includes(r.status)) {
      const loc = r.headers.get("location");
      if (!loc) return r;
      if (hop === 3) throw new Error("Trop de redirections.");
      current = new URL(loc, u).href; continue;
    }
    return r;
  }
  throw new Error("Trop de redirections.");
}
async function assetAwareFetch(env, workerOrigin, raw, accept, timeoutMs = 3500) {
  const u = new URL(raw);
  if (u.origin === workerOrigin && env.ASSETS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await env.ASSETS.fetch(
        new Request(u.href, {
          headers: { "Accept": accept },
          signal: controller.signal
        })
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return safeFetch(raw, accept, timeoutMs);
}
function decodeEntities(s) {
  return String(s).replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&quot;/gi,'"').replace(/&#39;/gi,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Math.min(Number(n)||32,0x10ffff)));
}
function siteMatches(origin, raw) { try { return new URL(raw).origin === origin; } catch { return false; } }
function parseSitemap(xml, base) {
  const out = []; const re = /<loc\b[^>]*>\s*([\s\S]*?)\s*<\/loc>/gi; let m;
  while ((m = re.exec(xml)) && out.length < 500) { try { const u = new URL(decodeEntities(m[1].trim()), base); if (["http:","https:"].includes(u.protocol)) out.push(u.href); } catch {} }
  return [...new Set(out)];
}
function decodeHtmlText(html) {
  return decodeEntities(String(html).replace(/<!--[^]*?-->/g," ").replace(/<(script|style|noscript|svg|template)\b[^>]*>[^]*?<\/\1\s*>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim()).slice(0, 30000);
}
function getMetaDescription(html) {
  for (const tag of (html.match(/<meta\b[^>]*>/gi) || [])) {
    if (/\bname\s*=\s*(["'])description\1/i.test(tag)) {
      const m = tag.match(/\bcontent\s*=\s*(["'])(.*?)\1/i); if (m) return decodeEntities(m[2]).slice(0, 500);
    }
  }
  return "";
}
function robotsRules(text) {
  const disallow = []; let applies = false;
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":"); if (i < 0) continue;
    const k = line.slice(0,i).trim().toLowerCase(), v = line.slice(i+1).trim();
    if (k === "user-agent") applies = v === "*" || /nexorabot/i.test(v);
    if (k === "disallow" && applies && v) disallow.push(v);
  }
  return disallow;
}
function robotsAllows(url, rules) { const path = new URL(url).pathname + new URL(url).search; return !rules.some(p => p === "/" || path.startsWith(p)); }

async function crawlSite(env, siteId, jobId, requestedSitemap, workerOrigin) {
  const DB = env.DB;
  try {
    const site = await first(DB.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId));
    if (!site || !site.verified) throw new Error("Site introuvable ou non vÃ©rifiÃ©.");
    const candidates = [];
    let sitemapUrl = requestedSitemap || site.last_submitted_sitemap || site.origin + "/sitemap.xml";
    try { const su = new URL(sitemapUrl, site.origin); if (su.origin === site.origin) candidates.push(su.href); } catch {}
    const robotResponse = await assetAwareFetch(env, workerOrigin, site.origin + "/robots.txt", "text/plain,*/*;q=0.2", 2000).catch(() => null);
    const robotsText = robotResponse && robotResponse.ok ? (await robotResponse.text()).slice(0,50000) : "";
    const disallow = robotsRules(robotsText);
    let queue = [];
    for (const candidate of candidates) {
      try {
        const r = await assetAwareFetch(env, workerOrigin, candidate, "application/xml,text/xml,text/plain,*/*;q=0.2", 2500);
        if (r.ok) { const xml = (await r.text()).slice(0, 500000); queue.push(...parseSitemap(xml,candidate).filter(u => siteMatches(site.origin,u))); }
      } catch {}
    }
    if (!queue.length) queue = [site.origin + "/"];
    queue = [...new Set(queue)].slice(0, 3);
    let crawled = 0, errors = 0;
    for (const raw of queue) {
      let u; try { u = publicUrl(raw); } catch { continue; }
      if (u.origin !== site.origin) continue;
      if (!robotsAllows(u.href, disallow)) {
        await DB.prepare("INSERT INTO pages (id,site_id,url,status,http_status,title,description,text_content,canonical,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(site_id,url) DO UPDATE SET status=excluded.status,error=excluded.error,updated_at=excluded.updated_at")
          .bind(id(),siteId,u.href,"blocked_robots",null,"","","","","Interdit par robots.txt",iso(),iso()).run();
        continue;
      }
      try {
        const r = await assetAwareFetch(env, workerOrigin, u.href,"text/html,application/xhtml+xml,*/*;q=0.2",3000);
        const type = r.headers.get("content-type") || "";
        if (!r.ok) { errors++; await DB.prepare("INSERT INTO pages (id,site_id,url,status,http_status,title,description,text_content,canonical,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(site_id,url) DO UPDATE SET status=excluded.status,http_status=excluded.http_status,error=excluded.error,updated_at=excluded.updated_at")
          .bind(id(),siteId,u.href,"error",r.status,"","","","",`HTTP ${r.status}`,iso(),iso()).run(); continue; }
        if (!/text\/html|application\/xhtml\+xml/i.test(type)) continue;
        const pageLength = Number(r.headers.get("content-length") || 0);
        if (pageLength > 150000) { errors++; continue; }
        const html = (await r.text()).slice(0, 120000);
        const tm = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
        const title = tm ? decodeEntities(tm[1].replace(/<[^>]+>/g,"").trim()).slice(0,300) : "";
        const description = getMetaDescription(html);
        const cm = html.match(/<link\b[^>]*rel\s*=\s*["'][^"']*canonical[^"']*["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/i) || html.match(/<link\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["'][^"']*canonical[^"']*["'][^>]*>/i);
        let canonical = ""; try { if (cm) canonical = new URL(decodeEntities(cm[1]),u.href).href; } catch {}
        const text = decodeHtmlText(html);
        await DB.prepare("INSERT INTO pages (id,site_id,url,status,http_status,title,description,text_content,canonical,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(site_id,url) DO UPDATE SET status=excluded.status,http_status=excluded.http_status,title=excluded.title,description=excluded.description,text_content=excluded.text_content,canonical=excluded.canonical,error='',updated_at=excluded.updated_at")
          .bind(id(),siteId,u.href,"indexed",r.status,title,description,text,canonical,"",iso(),iso()).run();
        crawled++;
      } catch (e) { errors++; }
    }
    await DB.prepare("UPDATE jobs SET status='completed',finished_at=?,crawled=?,errors=? WHERE id=?").bind(iso(),crawled,errors,jobId).run();
    await DB.prepare("UPDATE sites SET last_crawl_at=? WHERE id=?").bind(iso(),siteId).run();
  } catch (e) {
    await DB.prepare("UPDATE jobs SET status='failed',finished_at=?,error=? WHERE id=?").bind(iso(),String(e.message || e).slice(0,300),jobId).run().catch(()=>{});
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,x-admin-key" } });
    try {
      if (url.pathname.startsWith("/api/")) {
        if (url.pathname === "/api/health" && request.method === "GET") {
          const sites = await first(env.DB.prepare("SELECT COUNT(*) AS n FROM sites"));
          const pages = await first(env.DB.prepare("SELECT COUNT(*) AS n FROM pages WHERE status='indexed'"));
          const jobs = await first(env.DB.prepare("SELECT COUNT(*) AS n FROM jobs"));
          return json({ ok:true, name:"Nexora Indexation", version:"3.0.0-cloudflare", sitesCount:sites?.n||0, indexedCount:pages?.n||0, jobsCount:jobs?.n||0 });
        }
        if (url.pathname === "/api/search" && request.method === "GET") {
          const q = String(url.searchParams.get("q") || "").trim().slice(0,200);
          if (q.length < 2) return json({ query:q, results:[] });
          const terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0,8);
          const searchRows = await rows(env.DB.prepare("SELECT p.url,p.title,p.description,p.text_content,p.canonical,s.origin FROM pages p JOIN sites s ON s.id=p.site_id WHERE p.status='indexed' AND s.verified=1 ORDER BY p.updated_at DESC LIMIT 500").bind());
          const results = searchRows.map(p => { const hay = `${p.title||''} ${p.description||''} ${p.text_content||''} ${p.url}`.toLowerCase(); const score = terms.reduce((n,t)=>n+(hay.includes(t)?1:0),0); return score ? {url:p.canonical||p.url,title:p.title||p.url,description:p.description||(p.text_content||'').slice(0,220),score} : null; }).filter(Boolean).sort((a,b)=>b.score-a.score).slice(0,50);
          return json({ query:q, results });
        }
        if (url.pathname === "/api/sites" || url.pathname === "/api/jobs" || /^\/api\/sites\//.test(url.pathname)) {
          const denied = adminGuard(request, env); if (denied) return denied;
        }
        if (url.pathname === "/api/sites" && request.method === "GET") {
          const list = await rows(env.DB.prepare("SELECT s.*, (SELECT COUNT(*) FROM pages p WHERE p.site_id=s.id AND p.status='indexed') AS page_count FROM sites s ORDER BY s.created_at DESC"));
          return json(list.map(s=>({id:s.id,origin:s.origin,verified:!!s.verified,verificationToken:s.verification_token,verificationMethod:s.verification_method||"meta",createdAt:s.created_at,lastCrawlAt:s.last_crawl_at||null,lastSubmittedSitemap:s.last_submitted_sitemap||null,pageCount:s.page_count||0})));
        }
        if (url.pathname === "/api/sites" && request.method === "POST") {
          const b = await bodyJson(request); const origin = normalizeSite(b.url);
          if (await first(env.DB.prepare("SELECT id FROM sites WHERE origin=?").bind(origin))) return json({error:"Ce site est dÃ©jÃ  enregistrÃ©."},409);
          const siteId=id(), token="nexora-"+crypto.randomUUID().replace(/-/g,""); const method=["meta","file","dns"].includes(b.method)?b.method:"meta";
          await env.DB.prepare("INSERT INTO sites (id,origin,verified,verification_token,verification_method,created_at,sitemaps_json) VALUES (?,?,0,?,?,?,'[]')").bind(siteId,origin,token,method,iso()).run();
          return json({id:siteId,origin,verified:false,verificationToken:token,verificationMethod:method,createdAt:iso(),pageCount:0},201);
        }
        let m = url.pathname.match(/^\/api\/sites\/([^/]+)\/verify$/);
        if (m && request.method === "POST") {
          const sid=m[1], site=await first(env.DB.prepare("SELECT * FROM sites WHERE id=?").bind(sid)); if(!site)return json({error:"Site introuvable."},404);
          const b=await bodyJson(request), method=b.method||site.verification_method||"meta";
          if(method==="dns") return json({error:"La vÃ©rification DNS TXT n'est pas encore prise en charge sur Cloudflare. Utilise META ou fichier."},400);
          try {
            if(method==="meta") { const r=await assetAwareFetch(env,new URL(request.url).origin,site.origin+"/","text/html,*/*;q=0.2",3500); if(!r.ok)throw new Error(`La page rÃ©pond HTTP ${r.status}.`); const html=(await r.text()).slice(0,500000); const token=site.verification_token; const re=new RegExp("<meta\\b(?=[^>]*name\\s*=\\s*[\\\"']nexora-site-verification[\\\"'])(?=[^>]*content\\s*=\\s*[\\\"']"+token+"[\\\"'])[^>]*>","i"); if(!re.test(html))throw new Error("Balise META Nexora introuvable."); }
            else if(method==="file") { const r=await safeFetch(site.origin+"/.well-known/nexora-verification.txt","text/plain,*/*;q=0.2",3500); if(!r.ok || !(await r.text()).trim().split(/\r?\n/).includes(site.verification_token))throw new Error("Fichier de vÃ©rification introuvable ou jeton incorrect."); }
            else throw new Error("MÃ©thode de vÃ©rification inconnue.");
            await env.DB.prepare("UPDATE sites SET verified=1,verified_at=?,verification_method=? WHERE id=?").bind(iso(),method,sid).run(); return json({ok:true,verified:true,message:"PropriÃ©tÃ© vÃ©rifiÃ©e."});
          } catch(e) { return json({error:String(e.message||e)},400); }
        }
        m = url.pathname.match(/^\/api\/sites\/([^/]+)\/sitemap$/);
        if (m && request.method === "POST") {
          const sid=m[1], site=await first(env.DB.prepare("SELECT * FROM sites WHERE id=?").bind(sid)); if(!site||!site.verified)return json({error:"VÃ©rifie dâ€™abord la propriÃ©tÃ© du site."},403);
          const b=await bodyJson(request); let sitemapUrl; try { sitemapUrl=new URL(String(b.url||site.origin+"/sitemap.xml"),site.origin).href; if(!siteMatches(site.origin,sitemapUrl))throw new Error(); publicUrl(sitemapUrl); } catch { return json({error:"Le sitemap doit Ãªtre une URL publique du domaine vÃ©rifiÃ©."},400); }
          const r=await assetAwareFetch(env,new URL(request.url).origin,sitemapUrl,"application/xml,text/xml,text/plain,*/*;q=0.2",3500); if(!r.ok)return json({error:`Le sitemap rÃ©pond HTTP ${r.status}.`},400);
          const xml=(await r.text()).slice(0,500000); const urls=parseSitemap(xml,sitemapUrl).filter(u=>siteMatches(site.origin,u)); if(!urls.length)return json({error:"Sitemap XML invalide ou aucune URL du domaine trouvÃ©e."},400);
          await env.DB.prepare("UPDATE sites SET last_submitted_sitemap=? WHERE id=?").bind(sitemapUrl,sid).run(); return json({ok:true,sitemap:sitemapUrl,discoveredUrls:urls.length,message:`${urls.length} URL dÃ©couvertes. Lance le crawler pour indexer jusquâ€™Ã  3 petites pages par tÃ¢che.`});
        }
        m = url.pathname.match(/^\/api\/sites\/([^/]+)\/crawl$/);
        if (m && request.method === "POST") {
          const sid=m[1], site=await first(env.DB.prepare("SELECT * FROM sites WHERE id=?").bind(sid)); if(!site||!site.verified)return json({error:"VÃ©rifie dâ€™abord la propriÃ©tÃ© du site."},403);
          const running=await first(env.DB.prepare("SELECT id FROM jobs WHERE site_id=? AND status='running' LIMIT 1").bind(sid)); if(running)return json({error:"Une exploration est dÃ©jÃ  en cours."},409);
          const b=await bodyJson(request), jobId=id(); await env.DB.prepare("INSERT INTO jobs (id,site_id,status,started_at,crawled,errors) VALUES (?,?,'running',?,0,0)").bind(jobId,sid,iso()).run();
          ctx.waitUntil(crawlSite(env,sid,jobId,String(b.sitemap||site.last_submitted_sitemap||site.origin+"/sitemap.xml"),url.origin));
          return json({ok:true,message:"Exploration lancÃ©e. Cette tÃ¢che explore au maximum 3 petites pages pour respecter les limites gratuites de Workers."},202);
        }
        m = url.pathname.match(/^\/api\/sites\/([^/]+)\/pages$/);
        if (m && request.method === "GET") {
          const found=await first(env.DB.prepare("SELECT id FROM sites WHERE id=?").bind(m[1])); if(!found)return json({error:"Site introuvable."},404);
          const pages=await rows(env.DB.prepare("SELECT id,url,title,description,status,http_status,canonical,error,updated_at FROM pages WHERE site_id=? ORDER BY updated_at DESC LIMIT 1000").bind(m[1]));
          return json(pages.map(p=>({id:p.id,url:p.url,title:p.title,description:p.description,status:p.status,httpStatus:p.http_status,canonical:p.canonical,error:p.error,updatedAt:p.updated_at})));
        }
        if (url.pathname === "/api/jobs" && request.method === "GET") {
          const jobs=await rows(env.DB.prepare("SELECT id,site_id,status,started_at,finished_at,crawled,errors,error FROM jobs ORDER BY started_at DESC LIMIT 30"));
          return json(jobs.map(j=>({id:j.id,siteId:j.site_id,status:j.status,startedAt:j.started_at,finishedAt:j.finished_at,crawled:j.crawled,errors:j.errors,error:j.error})));
        }
        return json({error:"Route API inconnue.",path:url.pathname},404);
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({error:String(e?.message || e || "Erreur serveur").slice(0,500)},500);
    }
  }
};
