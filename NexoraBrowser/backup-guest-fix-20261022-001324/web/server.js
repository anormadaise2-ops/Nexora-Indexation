"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const dns = require("node:dns").promises;
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);

const HOST = "127.0.0.1";
const PORT = 3081;
const WEB_ROOT = __dirname;
const MAX_BODY = 128 * 1024;
const MAX_RESPONSE = 3 * 1024 * 1024;
const MAX_PAGES_PER_JOB = 250;
const USER_AGENT = "NexoraBot/1.0 (+Nexora Browser local indexer)";
const COOKIE_NAME = "nexora_session";

let server = null;
let startPromise = null;
let dataDirectory = null;
let logsDirectory = null;
let configPath = null;
let databasePath = null;
let config = {};
let database = { users: [], sessions: [], pages: [], jobs: [], events: [] };
let saveQueue = Promise.resolve();

const pendingRegistrations = new Map();
const pendingResets = new Map();
const otpCooldowns = new Map();
const loginFailures = new Map();
const dnsCache = new Map();

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function timingSafeString(a, b) {
  const first = Buffer.from(String(a || ""));
  const second = Buffer.from(String(b || ""));

  if (first.length !== second.length) return false;
  return crypto.timingSafeEqual(first, second);
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    });
}

function json(res, status, payload) {
  if (res.headersSent) return;

  const output = Buffer.from(JSON.stringify(payload), "utf8");

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": output.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Nexora-Portal": "1"
  });

  res.end(output);
}

function ok(res, payload = {}) {
  json(res, 200, { ok: true, ...payload });
}

function fail(res, status, message) {
  json(res, status, { ok: false, error: String(message) });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > MAX_BODY) {
      const error = new Error("Requête trop volumineuse.");
      error.statusCode = 413;
      throw error;
    }

    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (_) {
    const error = new Error("Le corps de la requête doit être un JSON valide.");
    error.statusCode = 400;
    throw error;
  }
}

function writeDefaultConfig() {
  const setupKey = crypto.randomBytes(32).toString("hex");

  const contents = [
    "# Configuration locale de Nexora Browser.",
    "# Ne partage jamais ce fichier : il peut contenir le jeton de ton bot.",
    "DISCORD_BOT_TOKEN=",
    "NEXORA_INDEXATION_URL=http://127.0.0.1:3080",
    "ADMIN_SETUP_KEY=" + setupKey,
    ""
  ].join("\n");

  fs.writeFileSync(configPath, contents, { encoding: "utf8", mode: 0o600 });
}

function loadConfig() {
  if (!fs.existsSync(configPath)) writeDefaultConfig();

  const values = {};

  for (const line of fs.readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index <= 0) continue;

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();

    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
       (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  config = {
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || values.DISCORD_BOT_TOKEN || "",
    NEXORA_INDEXATION_URL:
      process.env.NEXORA_INDEXATION_URL ||
      values.NEXORA_INDEXATION_URL ||
      "http://127.0.0.1:3080",
    ADMIN_SETUP_KEY: values.ADMIN_SETUP_KEY || ""
  };

  if (!config.ADMIN_SETUP_KEY) {
    config.ADMIN_SETUP_KEY = crypto.randomBytes(32).toString("hex");
    fs.appendFileSync(configPath, "\nADMIN_SETUP_KEY=" + config.ADMIN_SETUP_KEY + "\n", "utf8");
  }
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    discordId: user.discordId || "",
    role: user.role,
    banned: Boolean(user.banned),
    banReason: user.banReason || "",
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null
  };
}

async function persist() {
  const snapshot = JSON.stringify(database, null, 2);
  const tempPath = databasePath + ".tmp-" + process.pid;

  saveQueue = saveQueue.catch(() => {}).then(async () => {
    await fsp.writeFile(tempPath, snapshot, "utf8");
    await fsp.rename(tempPath, databasePath);
  });

  return saveQueue;
}

async function audit(action, user, message, details = {}) {
  const event = {
    time: new Date().toISOString(),
    action: String(action),
    actor: user ? user.username : "system",
    actorId: user ? user.id : null,
    message: String(message).slice(0, 600),
    details
  };

  database.events.push(event);

  if (database.events.length > 2000) {
    database.events = database.events.slice(-2000);
  }

  try {
    await fsp.appendFile(
      path.join(logsDirectory, "audit.log"),
      JSON.stringify(event) + "\n",
      "utf8"
    );
  } catch (error) {
    console.error("Impossible d'écrire le journal Nexora :", error.message);
  }

  await persist();
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const key = await scrypt(password, salt, 64);
  return { salt, hash: key.toString("hex") };
}

async function passwordMatches(password, user) {
  const key = await scrypt(String(password), user.passwordSalt, 64);
  return timingSafeString(key.toString("hex"), user.passwordHash);
}

function validPassword(password) {
  return typeof password === "string" && password.length >= 10 && password.length <= 128;
}

function validUsername(username) {
  return /^[a-z0-9_.-]{3,24}$/.test(normalizeUsername(username));
}

function validDiscordId(id) {
  return /^\d{17,20}$/.test(String(id || "").trim());
}

function validateRegistration(username, password, discordId) {
  if (!validUsername(username)) {
    throw new Error("Nom d'utilisateur invalide : 3 à 24 caractères, lettres, chiffres, point, tiret ou underscore.");
  }

  if (!validPassword(password)) {
    throw new Error("Le mot de passe doit contenir entre 10 et 128 caractères.");
  }

  if (!validDiscordId(discordId)) {
    throw new Error("L'identifiant Discord doit être un ID numérique valide. Il ne s'agit pas du nom d'utilisateur Discord.");
  }
}

function sessionToken(req) {
  const cookies = String(req.headers.cookie || "").split(";");

  for (const cookie of cookies) {
    const index = cookie.indexOf("=");
    if (index < 0) continue;

    if (cookie.slice(0, index).trim() === COOKIE_NAME) {
      return decodeURIComponent(cookie.slice(index + 1).trim());
    }
  }

  return "";
}

async function currentUser(req) {
  const token = sessionToken(req);
  if (!token) return null;

  const hash = sha256(token);
  const found = database.sessions.find(
    session => session.tokenHash === hash && session.expiresAt > Date.now()
  );

  if (!found) return null;

  const user = database.users.find(item => item.id === found.userId);

  if (!user || user.banned) return null;

  return user;
}

async function createSession(res, user) {
  const token = crypto.randomBytes(32).toString("hex");

  database.sessions = database.sessions.filter(
    session => session.expiresAt > Date.now()
  );

  database.sessions.push({
    tokenHash: sha256(token),
    userId: user.id,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
  });

  user.lastLoginAt = new Date().toISOString();

  res.setHeader(
    "Set-Cookie",
    COOKIE_NAME + "=" + token +
      "; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800"
  );

  await persist();
}

async function sendDiscordCode(discordId, purpose, rateKey) {
  const last = otpCooldowns.get(rateKey) || 0;
  const remaining = 45_000 - (Date.now() - last);

  if (remaining > 0) {
    throw new Error("Patiente " + Math.ceil(remaining / 1000) + " seconde(s) avant de demander un nouveau code.");
  }

  if (!config.DISCORD_BOT_TOKEN) {
    throw new Error(
      "Le bot Discord n'est pas configuré. Ouvre le fichier portal-config.env indiqué dans le tableau de bord et renseigne DISCORD_BOT_TOKEN."
    );
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const auth = "Bot " + config.DISCORD_BOT_TOKEN;
  const headers = {
    Authorization: auth,
    "Content-Type": "application/json"
  };

  const dmResponse = await fetch("https://discord.com/api/v10/users/@me/channels", {
    method: "POST",
    headers,
    body: JSON.stringify({ recipient_id: String(discordId) }),
    signal: AbortSignal.timeout(10000)
  });

  const dmData = await dmResponse.json().catch(() => ({}));

  if (!dmResponse.ok || !dmData.id) {
    throw new Error(
      "Discord n'a pas pu ouvrir un message privé. Vérifie l'ID Discord, le jeton du bot et les autorisations de messagerie privée."
    );
  }

  const purposeText = purpose === "register"
    ? "Vérification de création de compte"
    : "Réinitialisation du mot de passe";

  const message =
    "🔐 **Nexora — Code de sécurité**\n\n" +
    "Action : " + purposeText + "\n" +
    "Code : **" + code + "**\n\n" +
    "Expiration : 10 minutes. Ne communique jamais ce code à quelqu'un d'autre. " +
    "Si tu n'as pas demandé cette opération, ignore ce message.";

  const msgResponse = await fetch(
    "https://discord.com/api/v10/channels/" + encodeURIComponent(dmData.id) + "/messages",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ content: message }),
      signal: AbortSignal.timeout(10000)
    }
  );

  if (!msgResponse.ok) {
    throw new Error("Discord n'a pas pu envoyer le code. Vérifie que le bot peut envoyer des messages à cet utilisateur.");
  }

  otpCooldowns.set(rateKey, Date.now());

  return {
    codeHash: sha256(rateKey + ":" + code),
    expiresAt: Date.now() + 10 * 60 * 1000
  };
}

function cookieClear(res) {
  res.setHeader(
    "Set-Cookie",
    COOKIE_NAME + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
  );
}

function isLoopbackOrigin(origin) {
  if (!origin) return true;

  try {
    const parsed = new URL(origin);

    return (
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      parsed.port === String(PORT) &&
      parsed.protocol === "http:"
    );
  } catch (_) {
    return false;
  }
}

function ipIsPublic(address) {
  const family = net.isIP(address);
  const ip = String(address).toLowerCase().split("%")[0];

  if (family === 4) {
    const p = ip.split(".").map(Number);
    const [a, b, c] = p;

    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;

    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    if (a === 255) return false;

    return true;
  }

  if (family === 6) {
    if (
      ip === "::" ||
      ip === "::1" ||
      ip.startsWith("fc") ||
      ip.startsWith("fd") ||
      ip.startsWith("fe8") ||
      ip.startsWith("fe9") ||
      ip.startsWith("fea") ||
      ip.startsWith("feb") ||
      ip.startsWith("ff") ||
      ip.startsWith("2001:db8")
    ) return false;

    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return ipIsPublic(mapped[1]);

    return true;
  }

  return false;
}

async function safePublicURL(raw) {
  let url;

  try {
    url = new URL(String(raw || ""));
  } catch (_) {
    throw new Error("Adresse URL invalide.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Seules les URL HTTP et HTTPS sont acceptées.");
  }

  if (url.username || url.password) {
    throw new Error("Les URL contenant des identifiants ne sont pas autorisées.");
  }

  const host = url.hostname.toLowerCase();

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".")
  ) {
    throw new Error("Cette adresse ne correspond pas à un domaine public autorisé.");
  }

  const family = net.isIP(host);

  if (family) {
    if (!ipIsPublic(host)) throw new Error("Les adresses IP privées ou réservées ne peuvent pas être indexées.");
    return url;
  }

  const cached = dnsCache.get(host);

  if (cached && cached.expiresAt > Date.now()) {
    if (!cached.public) throw new Error("Ce domaine ne pointe pas vers une adresse publique.");
    return url;
  }

  const addresses = await dns.lookup(host, { all: true, verbatim: true });

  if (!addresses.length || addresses.some(entry => !ipIsPublic(entry.address))) {
    dnsCache.set(host, { public: false, expiresAt: Date.now() + 30_000 });
    throw new Error("Le domaine résout vers une adresse privée ou réservée.");
  }

  dnsCache.set(host, { public: true, expiresAt: Date.now() + 30_000 });

  return url;
}

async function readLimited(response, maximum = MAX_RESPONSE) {
  if (!response.body) return "";

  const announced = Number(response.headers.get("content-length") || 0);

  if (announced > maximum) {
    throw new Error("La réponse dépasse la taille maximale autorisée.");
  }

  const chunks = [];
  let total = 0;

  for await (const part of response.body) {
    const chunk = Buffer.from(part);
    total += chunk.length;

    if (total > maximum) {
      throw new Error("La réponse dépasse la taille maximale autorisée.");
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function fetchPublic(rawURL, maximum = MAX_RESPONSE) {
  let url = await safePublicURL(rawURL);

  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url.href, {
      redirect: "manual",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml,text/xml,text/plain,*/*;q=0.5"
      },
      signal: AbortSignal.timeout(12000)
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");

      if (!location) throw new Error("Redirection sans destination.");

      url = await safePublicURL(new URL(location, url).href);
      continue;
    }

    const body = await readLimited(response, maximum);

    return {
      response,
      url: url.href,
      text: body,
      contentType: response.headers.get("content-type") || ""
    };
  }

  throw new Error("Trop de redirections.");
}

function decodeXML(value) {
  return decodeEntities(String(value || ""))
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .trim();
}

function extractLocations(xml) {
  const results = [];
  const pattern = /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi;
  let match;

  while ((match = pattern.exec(xml)) !== null && results.length < 1000) {
    const value = decodeXML(match[1]);

    if (/^https?:\/\//i.test(value)) results.push(value);
  }

  return results;
}

async function readRobots(origin) {
  try {
    const response = await fetchPublic(new URL("/robots.txt", origin).href, 256 * 1024);
    const rules = [];
    const sitemaps = [];

    let active = false;

    for (const line of response.text.split(/\r?\n/)) {
      const trimmed = line.split("#")[0].trim();
      const separator = trimmed.indexOf(":");

      if (separator <= 0) continue;

      const key = trimmed.slice(0, separator).trim().toLowerCase();
      const value = trimmed.slice(separator + 1).trim();

      if (key === "user-agent") {
        active = value === "*";
      } else if (active && key === "disallow" && value) {
        rules.push(value);
      } else if (key === "sitemap" && value) {
        sitemaps.push(value);
      }
    }

    return { rules, sitemaps };
  } catch (_) {
    return { rules: [], sitemaps: [] };
  }
}

function robotsAllowed(rawURL, rules) {
  let url;

  try {
    url = new URL(rawURL);
  } catch (_) {
    return false;
  }

  const target = url.pathname + url.search;

  return !(rules || []).some(rule => target.startsWith(rule));
}

async function expandSitemap(rawURL, rootHost, depth, seen, output) {
  if (depth > 3 || seen.size > 15 || output.length >= 1000) return;

  let url;

  try {
    url = await safePublicURL(rawURL);
  } catch (_) {
    return;
  }

  if (url.hostname.toLowerCase() !== rootHost.toLowerCase()) return;
  if (seen.has(url.href)) return;

  seen.add(url.href);

  let response;

  try {
    response = await fetchPublic(url.href, MAX_RESPONSE);
  } catch (_) {
    return;
  }

  if (!response.response.ok) return;

  const xml = response.text;

  if (!/<(?:urlset|sitemapindex)\b/i.test(xml)) return;

  const locations = extractLocations(xml);

  if (/<sitemapindex\b/i.test(xml)) {
    for (const location of locations.slice(0, 30)) {
      await expandSitemap(location, rootHost, depth + 1, seen, output);
    }
  } else {
    for (const location of locations) {
      if (output.length >= 1000) break;

      try {
        const candidate = new URL(location);

        if (candidate.hostname.toLowerCase() !== rootHost.toLowerCase()) continue;

        candidate.hash = "";
        output.push(candidate.href);
      } catch (_) {}
    }
  }
}

function cleanHTML(raw) {
  return normalizeWhitespace(
    String(raw || "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#(\d+);/g, (_, n) => {
        const code = Number(n);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      })
  );
}

function htmlTitle(html, url) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);

  return normalizeWhitespace(
    match ? cleanHTML(match[1]).slice(0, 300) : new URL(url).hostname
  );
}

function htmlDescription(html) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    if (!/name\s*=\s*["']description["']/i.test(tag)) continue;

    const match = /content\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (match) return normalizeWhitespace(decodeEntities(match[1])).slice(0, 1200);
  }

  return "";
}

function extractLinks(html, baseURL, rootHost) {
  const output = [];
  const pattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  const skipExtensions = /\.(?:pdf|zip|rar|7z|png|jpg|jpeg|gif|webp|svg|mp4|mp3|exe|dmg|iso)(?:$|\?)/i;

  let match;

  while ((match = pattern.exec(html)) !== null && output.length < 500) {
    try {
      const href = match[1].trim();

      if (!href || /^(?:javascript|mailto|tel|data):/i.test(href)) continue;

      const url = new URL(href, baseURL);

      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (url.hostname.toLowerCase() !== rootHost.toLowerCase()) continue;
      if (url.pathname.length > 400) continue;
      if (skipExtensions.test(url.pathname)) continue;

      url.hash = "";
      url.search = "";

      output.push(url.href);
    } catch (_) {}
  }

  return output;
}

async function saveIndexedPage(job, url, title, description, text) {
  const now = new Date().toISOString();
  const content = String(text || "").slice(0, 40000);
  const snippet = description || content.slice(0, 450);
  const existing = database.pages.find(page => page.url === url);

  const page = {
    id: existing ? existing.id : crypto.randomUUID(),
    url,
    title: String(title || url).slice(0, 300),
    description: String(description || "").slice(0, 1200),
    snippet: String(snippet || "").slice(0, 600),
    text: content,
    domain: new URL(url).hostname,
    indexedAt: now,
    updatedAt: now,
    indexedBy: job.username
  };

  if (existing) Object.assign(existing, page);
  else database.pages.push(page);

  if (database.pages.length > 20000) {
    database.pages.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    database.pages.length = 20000;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runCrawlJob(jobId) {
  const job = database.jobs.find(item => item.id === jobId);
  if (!job) return;

  job.status = "running";
  job.message = "Préparation de l'indexation.";
  job.updatedAt = new Date().toISOString();
  await persist();

  let pagesProcessed = 0;
  let errors = 0;

  try {
    const startURL = await safePublicURL(job.input);
    const rootHost = startURL.hostname.toLowerCase();
    const origin = startURL.origin;
    const robots = await readRobots(origin);

    let queue = [];
    const seenSitemaps = new Set();
    const sitemapPages = [];

    if (job.type === "sitemap") {
      await expandSitemap(startURL.href, rootHost, 0, seenSitemaps, sitemapPages);
      queue.push(...sitemapPages);
    } else {
      if (!robotsAllowed(startURL.href, robots.rules)) {
        throw new Error("robots.txt indique que cette page ne doit pas être parcourue.");
      }

      queue.push(startURL.href);

      const commonSitemaps = [
        ...robots.sitemaps,
        new URL("/sitemap.xml", origin).href,
        new URL("/sitemap_index.xml", origin).href
      ];

      for (const sitemap of [...new Set(commonSitemaps)].slice(0, 10)) {
        await expandSitemap(sitemap, rootHost, 0, seenSitemaps, sitemapPages);

        if (sitemapPages.length >= 500) break;
      }

      queue.push(...sitemapPages);
    }

    const visited = new Set();

    while (queue.length && pagesProcessed < MAX_PAGES_PER_JOB) {
      const raw = queue.shift();

      let url;

      try {
        url = await safePublicURL(raw);
      } catch (_) {
        errors++;
        continue;
      }

      if (url.hostname.toLowerCase() !== rootHost) continue;

      url.hash = "";
      const canonical = url.href;

      if (visited.has(canonical)) continue;
      visited.add(canonical);

      if (!robotsAllowed(canonical, robots.rules)) continue;

      try {
        const result = await fetchPublic(canonical);

        if (!result.response.ok) {
          errors++;
          continue;
        }

        const xmlPage =
          /(?:xml|rss|atom)/i.test(result.contentType) ||
          /<(?:urlset|sitemapindex)\b/i.test(result.text);

        if (xmlPage) {
          const before = queue.length;
          const nested = [];

          await expandSitemap(result.url, rootHost, 0, seenSitemaps, nested);

          for (const item of nested) {
            if (!visited.has(item) && queue.length < 1200) queue.push(item);
          }

          if (queue.length === before) errors++;
        } else if (
          /text\/html|application\/xhtml/i.test(result.contentType) ||
          /<html\b/i.test(result.text)
        ) {
          const title = htmlTitle(result.text, result.url);
          const description = htmlDescription(result.text);
          const text = cleanHTML(result.text);

          await saveIndexedPage(job, result.url, title, description, text);
          pagesProcessed++;

          const discovered = extractLinks(result.text, result.url, rootHost);

          for (const link of discovered) {
            if (!visited.has(link) && queue.length < 1200) queue.push(link);
          }
        } else {
          continue;
        }
      } catch (error) {
        errors++;
        console.warn("[NexoraCrawler] Page ignorée :", canonical, error.message);
      }

      job.done = pagesProcessed;
      job.errors = errors;
      job.total = Math.max(job.total || 0, queue.length + pagesProcessed);
      job.message = "Indexation en cours.";
      job.updatedAt = new Date().toISOString();

      await persist();
      await sleep(100);
    }

    job.status = "completed";
    job.done = pagesProcessed;
    job.errors = errors;
    job.message = pagesProcessed
      ? pagesProcessed + " page(s) indexée(s)."
      : "Aucune page HTML indexée. Vérifie le sitemap, le robots.txt ou les réponses du site.";

    await audit(
      "index_job_completed",
      { id: job.userId, username: job.username },
      "Indexation terminée : " + pagesProcessed + " page(s).",
      { jobId: job.id, errors }
    );
  } catch (error) {
    job.status = "failed";
    job.message = String(error.message || "Erreur d'indexation").slice(0, 500);

    await audit(
      "index_job_failed",
      { id: job.userId, username: job.username },
      "Une tâche d'indexation a échoué.",
      { jobId: job.id }
    );
  }

  job.updatedAt = new Date().toISOString();
  await persist();
}

function requireAdmin(user) {
  return Boolean(user && user.role === "admin" && !user.banned);
}

function findArray(payload, depth = 0) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object" || depth > 5) return null;

  for (const key of [
    "results","items","urls","pages","documents","hits",
    "entries","data","result","searchResults","search_results"
  ]) {
    if (payload[key] !== undefined) {
      const value = findArray(payload[key], depth + 1);
      if (value !== null) return value;
    }
  }

  return null;
}

function normalizeSearchItems(items) {
  if (!Array.isArray(items)) return [];

  return items.map(item => {
    if (typeof item === "string") {
      try {
        const url = new URL(item);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        return { url: url.href, title: url.href, snippet: "" };
      } catch (_) { return null; }
    }

    if (!item || typeof item !== "object") return null;
    if (item.indexed === false || item.isIndexed === false || item.is_indexed === false) return null;

    const raw = item.url || item.href || item.link || item.canonicalUrl || item.canonical_url || "";

    try {
      const url = new URL(String(raw));
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;

      return {
        url: url.href,
        title: String(item.title || item.name || url.hostname),
        snippet: String(item.snippet || item.description || item.content || item.excerpt || "").slice(0, 800)
      };
    } catch (_) { return null; }
  }).filter(Boolean).slice(0, 50);
}

async function upstreamSearch(query) {
  const rawBase = config.NEXORA_INDEXATION_URL;

  if (!rawBase) return [];

  let base;

  try {
    const parsed = new URL(rawBase);
    if (!["http:", "https:"].includes(parsed.protocol)) return [];
    base = parsed.href.replace(/\/+$/, "");
  } catch (_) {
    return [];
  }

  const routes = [
    "/api/search?q=",
    "/search?q=",
    "/api/index/search?q=",
    "/api/indexed-search?q="
  ];

  for (const route of routes) {
    try {
      const response = await fetch(
        base + route + encodeURIComponent(query),
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(1100)
        }
      );

      if (!response.ok) continue;

      const data = await response.json();
      const array = findArray(data);

      if (array !== null) {
        return normalizeSearchItems(array);
      }
    } catch (_) {}
  }

  return [];
}

function searchLocal(query) {
  const tokens = normalizeText(query).split(/[^a-z0-9]+/).filter(x => x.length > 1).slice(0, 12);
  if (!tokens.length) return [];

  return database.pages.map(page => {
    const title = normalizeText(page.title);
    const description = normalizeText(page.description);
    const text = normalizeText(page.text);
    const domain = normalizeText(page.domain);
    let score = 0;

    for (const token of tokens) {
      if (title.includes(token)) score += 8;
      if (description.includes(token)) score += 4;
      if (domain.includes(token)) score += 3;
      if (text.includes(token)) score += 1;
    }

    return { page, score };
  })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50)
    .map(({ page }) => ({
      url: page.url,
      title: page.title,
      snippet: page.snippet,
      indexedAt: page.indexedAt,
      domain: page.domain
    }));
}

function setPublicUserSession(user) {
  return {
    user: publicUser(user)
  };
}

async function routeApi(req, res, url) {
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/health") {
    return ok(res, {
      service: "Nexora Indexation",
      version: "3.0.0",
      port: PORT,
      pages: database.pages.length,
      jobs: database.jobs.length
    });
  }

  if (req.method === "GET" && pathname === "/api/setup") {
    const admins = database.users.filter(user => user.role === "admin" && !user.banned).length;

    return ok(res, {
      bootstrapNeeded: admins === 0,
      discordConfigured: Boolean(config.DISCORD_BOT_TOKEN),
      configPath,
      logsPath: logsDirectory,
      indexerUpstream: config.NEXORA_INDEXATION_URL,
      serviceUrl: "http://" + HOST + ":" + PORT
    });
  }

  if (req.method === "GET" && pathname === "/api/search") {
    const query = String(url.searchParams.get("q") || "").trim().slice(0, 180);

    if (!query) return ok(res, { query, count: 0, results: [], message: "Entre un terme de recherche." });

    let results = searchLocal(query);
    let source = "Nexora Indexation";

    if (!results.length) {
      results = await upstreamSearch(query);
      if (results.length) source = "Serveur Nexora Indexation connecté";
    }

    return ok(res, {
      query,
      count: results.length,
      results,
      source,
      message: results.length ? "Recherche terminée." : "Aucun résultat correspondant dans l'index."
    });
  }

  if (req.method === "GET" && pathname === "/api/me") {
    const user = await currentUser(req);
    if (!user) return fail(res, 401, "Connecte-toi pour accéder à ton compte.");
    return ok(res, setPublicUserSession(user));
  }

  if (req.method === "POST" && !isLoopbackOrigin(req.headers.origin)) {
    return fail(res, 403, "Origine non autorisée.");
  }

  if (req.method === "POST" && pathname === "/api/auth/register") {
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const usernameKey = normalizeUsername(username);
    const discordId = String(body.discordId || "").trim();
    const password = String(body.password || "");

    validateRegistration(username, password, discordId);

    if (database.users.some(user => user.usernameKey === usernameKey)) {
      return fail(res, 409, "Ce nom d'utilisateur existe déjà.");
    }

    if (pendingRegistrations.has(usernameKey)) {
      return fail(res, 409, "Une vérification est déjà en attente pour cet utilisateur.");
    }

    const passwordData = await hashPassword(password);
    const otp = await sendDiscordCode(discordId, "register", "register:" + usernameKey);

    pendingRegistrations.set(usernameKey, {
      username,
      usernameKey,
      discordId,
      passwordSalt: passwordData.salt,
      passwordHash: passwordData.hash,
      codeHash: otp.codeHash,
      expiresAt: otp.expiresAt,
      attempts: 0
    });

    return ok(res, {
      username,
      message: "Code envoyé en message privé Discord. Il expire dans 10 minutes."
    });
  }

  if (req.method === "POST" && pathname === "/api/auth/verify") {
    const body = await readBody(req);
    const usernameKey = normalizeUsername(body.username);
    const code = String(body.code || "").trim();
    const pending = pendingRegistrations.get(usernameKey);

    if (!pending || pending.expiresAt < Date.now()) {
      pendingRegistrations.delete(usernameKey);
      return fail(res, 400, "Code absent ou expiré. Demande un nouveau code.");
    }

    pending.attempts++;

    if (pending.attempts > 5) {
      pendingRegistrations.delete(usernameKey);
      return fail(res, 429, "Trop de tentatives. Recommence la création du compte.");
    }

    if (!timingSafeString(sha256("register:" + usernameKey + ":" + code), pending.codeHash)) {
      return fail(res, 400, "Code de vérification incorrect.");
    }

    if (database.users.some(user => user.usernameKey === usernameKey)) {
      pendingRegistrations.delete(usernameKey);
      return fail(res, 409, "Ce compte existe déjà.");
    }

    const user = {
      id: crypto.randomUUID(),
      username: pending.username,
      usernameKey,
      passwordSalt: pending.passwordSalt,
      passwordHash: pending.passwordHash,
      discordId: pending.discordId,
      discordVerified: true,
      role: "user",
      banned: false,
      banReason: "",
      createdAt: new Date().toISOString(),
      lastLoginAt: null
    };

    database.users.push(user);
    pendingRegistrations.delete(usernameKey);

    await createSession(res, user);
    await audit("account_created", user, "Création de compte confirmée par Discord.");

    return ok(res, setPublicUserSession(user));
  }

  if (req.method === "POST" && pathname === "/api/auth/login") {
    const body = await readBody(req);
    const usernameKey = normalizeUsername(body.username);
    const password = String(body.password || "");
    const lock = loginFailures.get(usernameKey);

    if (lock && lock.lockedUntil > Date.now()) {
      return fail(res, 429, "Trop de tentatives. Attends quelques minutes avant de réessayer.");
    }

    const user = database.users.find(item => item.usernameKey === usernameKey);

    if (!user || !(await passwordMatches(password, user))) {
      const old = loginFailures.get(usernameKey) || { count: 0, start: Date.now(), lockedUntil: 0 };
      if (Date.now() - old.start > 10 * 60 * 1000) {
        old.count = 0;
        old.start = Date.now();
      }

      old.count++;

      if (old.count >= 8) old.lockedUntil = Date.now() + 10 * 60 * 1000;

      loginFailures.set(usernameKey, old);
      await audit("login_failed", null, "Tentative de connexion échouée.");
      return fail(res, 401, "Nom d'utilisateur ou mot de passe incorrect.");
    }

    if (user.banned) {
      await audit("login_banned", user, "Tentative de connexion d'un compte banni.");
      return fail(res, 403, "Ce compte est suspendu. Motif : " + (user.banReason || "non indiqué"));
    }

    loginFailures.delete(usernameKey);

    await createSession(res, user);
    await audit("login_success", user, "Connexion réussie.");

    return ok(res, setPublicUserSession(user));
  }

  if (req.method === "POST" && pathname === "/api/auth/logout") {
    const token = sessionToken(req);
    const hash = token ? sha256(token) : "";

    database.sessions = database.sessions.filter(item => item.tokenHash !== hash);

    await persist();
    cookieClear(res);

    return ok(res);
  }

  if (req.method === "POST" && pathname === "/api/auth/forgot") {
    const body = await readBody(req);
    const usernameKey = normalizeUsername(body.username);
    const user = database.users.find(item => item.usernameKey === usernameKey);

    if (!user || user.banned || !user.discordId) {
      return ok(res, {
        message: "Si ce compte existe et possède un Discord valide, un code de récupération sera envoyé."
      });
    }

    try {
      const otp = await sendDiscordCode(user.discordId, "reset", "reset:" + user.id);

      pendingResets.set(user.id, {
        codeHash: otp.codeHash,
        expiresAt: otp.expiresAt,
        attempts: 0
      });
    } catch (error) {
      return fail(res, 400, error.message);
    }

    return ok(res, {
      message: "Si ce compte existe, un code de récupération vient d'être envoyé à son Discord."
    });
  }

  if (req.method === "POST" && pathname === "/api/auth/reset") {
    const body = await readBody(req);
    const usernameKey = normalizeUsername(body.username);
    const code = String(body.code || "").trim();
    const password = String(body.password || "");

    if (!validPassword(password)) {
      return fail(res, 400, "Le nouveau mot de passe doit contenir entre 10 et 128 caractères.");
    }

    const user = database.users.find(item => item.usernameKey === usernameKey);
    if (!user) return fail(res, 400, "Impossible de valider cette demande.");

    const pending = pendingResets.get(user.id);

    if (!pending || pending.expiresAt < Date.now()) {
      pendingResets.delete(user.id);
      return fail(res, 400, "Code absent ou expiré. Demande un nouveau code.");
    }

    pending.attempts++;

    if (pending.attempts > 5) {
      pendingResets.delete(user.id);
      return fail(res, 429, "Trop de tentatives. Demande un nouveau code.");
    }

    if (!timingSafeString(sha256("reset:" + user.id + ":" + code), pending.codeHash)) {
      return fail(res, 400, "Code incorrect.");
    }

    const data = await hashPassword(password);
    user.passwordSalt = data.salt;
    user.passwordHash = data.hash;

    database.sessions = database.sessions.filter(session => session.userId !== user.id);
    pendingResets.delete(user.id);

    cookieClear(res);

    await audit("password_reset", user, "Mot de passe modifié via le code Discord.");

    return ok(res, { message: "Mot de passe changé. Connecte-toi avec le nouveau mot de passe." });
  }

  if (req.method === "POST" && pathname === "/api/admin/bootstrap") {
    const body = await readBody(req);

    if (database.users.some(user => user.role === "admin" && !user.banned)) {
      return fail(res, 409, "Un administrateur existe déjà. Utilise la page de connexion.");
    }

    if (!config.ADMIN_SETUP_KEY || !timingSafeString(body.setupKey, config.ADMIN_SETUP_KEY)) {
      return fail(res, 403, "Clé initiale d'administration incorrecte. Lis ADMIN_SETUP_KEY dans le fichier de configuration local.");
    }

    const username = String(body.username || "").trim();
    const usernameKey = normalizeUsername(username);
    const password = String(body.password || "");
    const discordId = String(body.discordId || "").trim();

    validateRegistration(username, password, discordId);

    if (database.users.some(user => user.usernameKey === usernameKey)) {
      return fail(res, 409, "Ce nom d'utilisateur existe déjà.");
    }

    const passwordData = await hashPassword(password);

    const admin = {
      id: crypto.randomUUID(),
      username,
      usernameKey,
      passwordSalt: passwordData.salt,
      passwordHash: passwordData.hash,
      discordId,
      discordVerified: false,
      role: "admin",
      banned: false,
      banReason: "",
      createdAt: new Date().toISOString(),
      lastLoginAt: null
    };

    database.users.push(admin);

    await createSession(res, admin);
    await audit("initial_admin_created", admin, "Compte administrateur initial créé.");

    return ok(res, {
      ...setPublicUserSession(admin),
      message: "Administrateur initial créé. Configure le jeton du bot Discord avant d'utiliser les vérifications."
    });
  }

  if (req.method === "GET" && pathname === "/api/indexed") {
    const user = await currentUser(req);
    if (!user) return fail(res, 401, "Connecte-toi pour consulter les pages indexées.");

    const pages = database.pages
      .slice()
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 1500)
      .map(({ id, url, title, snippet, domain, indexedAt, updatedAt, indexedBy }) => ({
        id, url, title, snippet, domain, indexedAt, updatedAt, indexedBy
      }));

    return ok(res, { count: database.pages.length, pages });
  }

  if (req.method === "GET" && pathname === "/api/jobs") {
    const user = await currentUser(req);
    if (!user) return fail(res, 401, "Connecte-toi pour consulter tes tâches.");

    const jobs = database.jobs
      .filter(job => user.role === "admin" || job.userId === user.id)
      .slice()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 100);

    return ok(res, { jobs });
  }

  if (req.method === "POST" && (pathname === "/api/index" || pathname === "/api/index/sitemap")) {
    const user = await currentUser(req);
    if (!user) return fail(res, 401, "Connecte-toi pour indexer des pages.");

    const body = await readBody(req);
    const type = pathname.endsWith("/sitemap") || body.type === "sitemap" ? "sitemap" : "url";
    const rawURL = String(type === "sitemap" ? body.sitemap || body.url || "" : body.url || "").trim();

    let url;

    try {
      url = await safePublicURL(rawURL);
    } catch (error) {
      return fail(res, 400, error.message);
    }

    const job = {
      id: crypto.randomUUID(),
      userId: user.id,
      username: user.username,
      input: url.href,
      type,
      status: "queued",
      done: 0,
      total: 0,
      errors: 0,
      message: "Tâche ajoutée à la file.",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    database.jobs.push(job);

    if (database.jobs.length > 500) {
      database.jobs = database.jobs.slice(-500);
    }

    await persist();

    setImmediate(() => {
      runCrawlJob(job.id).catch(error => {
        console.error("Tâche d'indexation interrompue :", error.message);
      });
    });

    await audit("index_job_created", user, "Nouvelle tâche d'indexation.", {
      jobId: job.id,
      type
    });

    return json(res, 202, { ok: true, job });
  }

  if (req.method === "GET" && pathname === "/api/admin/users") {
    const user = await currentUser(req);
    if (!requireAdmin(user)) return fail(res, 403, "Accès administrateur requis.");

    return ok(res, {
      users: database.users
        .slice()
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .map(publicUser)
    });
  }

  if (req.method === "POST" && pathname === "/api/admin/ban") {
    const user = await currentUser(req);
    if (!requireAdmin(user)) return fail(res, 403, "Accès administrateur requis.");

    const body = await readBody(req);
    const target = database.users.find(item => item.id === String(body.userId || ""));

    if (!target) return fail(res, 404, "Utilisateur introuvable.");
    if (target.id === user.id) return fail(res, 400, "Tu ne peux pas bannir ton propre compte.");
    if (target.role === "admin") return fail(res, 403, "Un administrateur ne peut pas être banni depuis cette interface.");

    target.banned = true;
    target.banReason = String(body.reason || "Aucun motif indiqué").slice(0, 250);
    target.bannedAt = new Date().toISOString();

    database.sessions = database.sessions.filter(session => session.userId !== target.id);

    await audit("user_banned", user, "Compte suspendu : " + target.username, {
      targetId: target.id,
      reason: target.banReason
    });

    return ok(res, { user: publicUser(target) });
  }

  if (req.method === "POST" && pathname === "/api/admin/unban") {
    const user = await currentUser(req);
    if (!requireAdmin(user)) return fail(res, 403, "Accès administrateur requis.");

    const body = await readBody(req);
    const target = database.users.find(item => item.id === String(body.userId || ""));

    if (!target) return fail(res, 404, "Utilisateur introuvable.");

    target.banned = false;
    target.banReason = "";
    delete target.bannedAt;

    await audit("user_unbanned", user, "Compte réactivé : " + target.username, {
      targetId: target.id
    });

    return ok(res, { user: publicUser(target) });
  }

  if (req.method === "GET" && pathname === "/api/admin/logs") {
    const user = await currentUser(req);
    if (!requireAdmin(user)) return fail(res, 403, "Accès administrateur requis.");

    return ok(res, {
      logFile: path.join(logsDirectory, "audit.log"),
      events: database.events.slice(-250).reverse()
    });
  }

  if (req.method === "GET" && pathname.startsWith("/api/")) {
    return fail(res, 404, "Route API inconnue.");
  }

  return null;
}

function contentType(filename) {
  const ext = path.extname(filename).toLowerCase();

  return ({
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon"
  })[ext] || "application/octet-stream";
}

async function serveStatic(req, res, pathname) {
  let decoded;

  try {
    decoded = decodeURIComponent(pathname);
  } catch (_) {
    return fail(res, 400, "Chemin invalide.");
  }

  if (decoded === "/") decoded = "/index.html";

  const file = path.resolve(WEB_ROOT, "." + decoded);

  if (!file.startsWith(WEB_ROOT + path.sep)) {
    return fail(res, 403, "Chemin interdit.");
  }

  try {
    const info = await fsp.stat(file);
    if (!info.isFile()) return fail(res, 404, "Fichier introuvable.");

    const data = await fsp.readFile(file);

    res.writeHead(200, {
      "Content-Type": contentType(file),
      "Content-Length": data.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; " +
        "connect-src 'self' http://127.0.0.1:3080 http://localhost:3080 https://discord.com; " +
        "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
      "X-Nexora-Portal": "1"
    });

    res.end(data);
  } catch (_) {
    fail(res, 404, "Fichier introuvable.");
  }
}

async function handleRequest(req, res) {
  let url;

  try {
    url = new URL(req.url, "http://" + HOST + ":" + PORT);
  } catch (_) {
    return fail(res, 400, "URL invalide.");
  }

  try {
    if (req.method === "GET" && url.pathname.startsWith("/api/")) {
      const response = await routeApi(req, res, url);
      if (response !== null) return;
    } else if (req.method !== "GET" && req.method !== "POST") {
      return fail(res, 405, "Méthode HTTP non prise en charge.");
    } else if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      return await serveStatic(req, res, url.pathname);
    } else {
      const response = await routeApi(req, res, url);
      if (response !== null) return;
    }

    if (!res.headersSent) fail(res, 404, "Route introuvable.");
  } catch (error) {
    console.error("[NexoraPortal]", error.message);
    fail(res, error.statusCode || 500, error.statusCode ? error.message : "Erreur interne du serveur Nexora.");
  }
}

async function start(options = {}) {
  if (server && server.listening) return "http://" + HOST + ":" + PORT;
  if (startPromise) return startPromise;

  startPromise = (async () => {
    dataDirectory = options.dataDir || path.join(__dirname, "data");
    const projectDirectory = options.projectDir || path.resolve(__dirname, "..");

    logsDirectory = options.dev
      ? path.join(projectDirectory, "logs")
      : path.join(dataDirectory, "logs");

    configPath = path.join(dataDirectory, "portal-config.env");
    databasePath = path.join(dataDirectory, "nexora-portal.json");

    await fsp.mkdir(dataDirectory, { recursive: true });
    await fsp.mkdir(logsDirectory, { recursive: true });

    loadConfig();

    try {
      const raw = await fsp.readFile(databasePath, "utf8");
      const saved = JSON.parse(raw);

      database = {
        users: Array.isArray(saved.users) ? saved.users : [],
        sessions: Array.isArray(saved.sessions) ? saved.sessions : [],
        pages: Array.isArray(saved.pages) ? saved.pages : [],
        jobs: Array.isArray(saved.jobs) ? saved.jobs : [],
        events: Array.isArray(saved.events) ? saved.events : []
      };
    } catch (_) {
      await persist();
    }

    server = http.createServer(handleRequest);

    await new Promise((resolve, reject) => {
      const onError = error => {
        server.removeListener("listening", onListening);
        reject(error);
      };

      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(PORT, HOST);
    }).catch(async error => {
      if (error.code !== "EADDRINUSE") throw error;

      try {
        const response = await fetch("http://" + HOST + ":" + PORT + "/api/health", {
          signal: AbortSignal.timeout(1200)
        });

        if (response.headers.get("x-nexora-portal") === "1") return;

        throw new Error("Le port 3081 est déjà utilisé par un autre service.");
      } catch (_) {
        throw new Error("Le port 3081 est occupé. Ferme l'ancienne instance de Nexora Browser et réessaie.");
      }
    });

    console.log("[NexoraPortal] Site local : http://" + HOST + ":" + PORT);
    console.log("[NexoraPortal] Configuration : " + configPath);
    console.log("[NexoraPortal] Journaux : " + logsDirectory);

    return "http://" + HOST + ":" + PORT;
  })();

  try {
    return await startPromise;
  } finally {
    startPromise = null;
  }
}

module.exports = { start };