const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  Menu,
  shell,
  dialog
} = require("electron");

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const APP_ID = "com.nexora.browser";
const SEARCH_RESULTS_FILE = path.join(__dirname, "search-results.html");
const DOWNLOADS_FILE = path.join(__dirname, "downloads.html");

let downloadsWindow = null;
let downloadSequence = 0;
const activeDownloads = new Map();

let shieldsEnabled = true;
let blockedTrackerCount = 0;

const TRACKER_DOMAINS = [
  "doubleclick.net",
  "googlesyndication.com",
  "google-analytics.com",
  "googletagmanager.com",
  "connect.facebook.net",
  "facebook.net",
  "hotjar.com",
  "clarity.ms",
  "segment.io",
  "mixpanel.com",
  "amplitude.com",
  "fullstory.com",
  "scorecardresearch.com",
  "adservice.google.com",
  "taboola.com",
  "outbrain.com",
  "criteo.com",
  "adroll.com",
  "adsrvr.org",
  "quantserve.com",
  "moatads.com",
  "app-measurement.com",
  "bat.bing.com"
];
const TOOLBAR_HEIGHT = 126;
const HOME_BASE = pathToFileURL(path.join(__dirname, "home.html")).href;

const SEARCH_ENGINES = {
  Nexora: q => "nexora-search://search?q=" + encodeURIComponent(q),
  Brave: q => "https://search.brave.com/search?q=" + encodeURIComponent(q),
  Google: q => "https://www.google.com/search?q=" + encodeURIComponent(q),
  Bing: q => "https://www.bing.com/search?q=" + encodeURIComponent(q),
  DuckDuckGo: q => "https://duckduckgo.com/?q=" + encodeURIComponent(q),
  Ecosia: q => "https://www.ecosia.org/search?q=" + encodeURIComponent(q),
  Qwant: q => "https://www.qwant.com/?q=" + encodeURIComponent(q),
  Yahoo: q => "https://search.yahoo.com/search?p=" + encodeURIComponent(q),
  Startpage: q => "https://www.startpage.com/sp/search?query=" + encodeURIComponent(q)
};

let mainWindow = null;
let browserSession = null;
let tabCounter = 0;
let activeTabId = null;
const tabs = new Map();

let store = {
  defaultEngine: "Nexora",
  bookmarks: [],
  history: [],
  shieldsEnabled: true,
  extensionPaths: []
};

function dataFile() {
  return path.join(app.getPath("userData"), "nexora-data.json");
}

function loadStore() {
  try {
    const file = dataFile();

    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));

      store = {
        defaultEngine: SEARCH_ENGINES[saved.defaultEngine]
          ? saved.defaultEngine
          : "Nexora",
        bookmarks: Array.isArray(saved.bookmarks) ? saved.bookmarks : [],
        history: Array.isArray(saved.history) ? saved.history : [],
        shieldsEnabled: saved.shieldsEnabled !== false,
        extensionPaths: Array.isArray(saved.extensionPaths) ? saved.extensionPaths : []
      };

      shieldsEnabled = store.shieldsEnabled;
    }
  } catch (error) {
    console.error("Impossible de lire les donnÃ©es Nexora :", error);
  }
}

function saveStore() {
  try {
    fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
    fs.writeFileSync(dataFile(), JSON.stringify(store, null, 2), "utf8");
  } catch (error) {
    console.error("Impossible de sauvegarder les donnÃ©es Nexora :", error);
  }
}

function makeHomeURL() {
  return HOME_BASE + "?engine=" + encodeURIComponent(store.defaultEngine);
}

function isHomeURL(url) {
  return typeof url === "string" &&
    url.split("?")[0].split("#")[0] === HOME_BASE;
}

function getActiveTab() {
  return tabs.get(activeTabId) || null;
}

function getTabState(tab) {
  const wc = tab.view.webContents;
  const url = tab.displayUrl || wc.getURL() || tab.lastUrl || makeHomeURL();

  return {
    id: tab.id,
    title: wc.getTitle() || "Nouvel onglet",
    url,
    loading: Boolean(tab.loading),
    canGoBack: canGoBack(wc),
    canGoForward: canGoForward(wc),
    isHome: isHomeURL(url)
  };
}

function getState() {
  return {
    tabs: Array.from(tabs.values()).map(getTabState),
    activeId: activeTabId,
    defaultEngine: store.defaultEngine,
    bookmarks: store.bookmarks,
    history: store.history.slice(0, 100)
  };
}

function pushState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  try {
    mainWindow.webContents.send("browser:state", getState());
    const tab = getActiveTab();

    if (tab) {
      mainWindow.setTitle(
        (tab.view.webContents.getTitle() || "Nouvel onglet") +
        " â€” Nexora Browser"
      );
    }
  } catch (error) {
    console.error("Erreur d'actualisation de l'interface :", error);
  }
}

function notify(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("browser:notice", String(message));
  }
}

function layoutTabs() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const [width, height] = mainWindow.getContentSize();

  for (const tab of tabs.values()) {
    const active = tab.id === activeTabId;

    tab.view.setBounds({
      x: 0,
      y: TOOLBAR_HEIGHT,
      width: active ? Math.max(0, width) : 0,
      height: active ? Math.max(0, height - TOOLBAR_HEIGHT) : 0
    });
  }
}

function recordHistory(url, title) {
  if (!/^https?:\/\//i.test(url)) return;

  const now = Date.now();
  const previous = store.history[0];

  if (previous && previous.url === url && now - previous.time < 2000) {
    previous.title = title || previous.title || url;
    previous.time = now;
    saveStore();
    return;
  }

  store.history.unshift({
    title: title || url,
    url,
    time: now
  });

  store.history = store.history.slice(0, 1000);
  saveStore();
}

function searchURL(query, engine = store.defaultEngine) {
  const provider = SEARCH_ENGINES[engine] || SEARCH_ENGINES.Brave;
  return provider(query);
}

function resolveInput(input) {
  const value = String(input || "").trim();

  if (!value) return makeHomeURL();

  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);

      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.href;
      }
    } catch (_) {}
  }

  if (/^(javascript|data|vbscript|file):/i.test(value)) {
    return searchURL(value);
  }

  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(value)) {
    return "http://" + value;
  }

  const domainPattern =
    /^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?::\d+)?(?:\/.*)?$/;

  if (!/\s/.test(value) && domainPattern.test(value)) {
    return "https://" + value;
  }

  return searchURL(value);
}

function safeExternalURL(rawURL) {
  try {
    const url = new URL(rawURL);

    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.href;
    }
  } catch (_) {}

  return null;
}

function switchTab(id) {
  if (!tabs.has(id)) return;

  activeTabId = id;
  layoutTabs();
  pushState();
}

function openTab(initialURL, activate = true, focusAddress = false) {
  if (!mainWindow || !browserSession) return null;

  const id = ++tabCounter;

  const view = new WebContentsView({
    webPreferences: {
      session: browserSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  const tab = {
    id,
    view,
    loading: true,
    lastUrl: makeHomeURL(),
    displayUrl: null,
    searchDisplayUrl: null,
    lastSearchQuery: ""
  };

  tabs.set(id, tab);
  mainWindow.contentView.addChildView(view);

  if (activate) activeTabId = id;

  const wc = view.webContents;

  try {
    const userAgent = wc.getUserAgent().replace(/\sElectron\/[^\s]+/g, "");
    wc.setUserAgent(userAgent);
  } catch (_) {}

  wc.setWindowOpenHandler(({ url }) => {
    const safeURL = safeExternalURL(url);

    if (safeURL) {
      setTimeout(() => openTab(safeURL, true, false), 0);
    }

    return { action: "deny" };
  });

  wc.on("will-navigate", (event, url) => {
    if (/^nexora-search:/i.test(url)) {
      event.preventDefault();

      try {
        const parsed = new URL(url);
        void loadNexoraSearch(tab, parsed.searchParams.get("q") || "");
      } catch (error) {
        console.error("Recherche Nexora impossible :", error);
        notify("Impossible de lancer la recherche Nexora.");
      }

      return;
    }

    if (/^(javascript|data|vbscript):/i.test(url)) {
      event.preventDefault();
      return;
    }

    if (url.startsWith("file:") && !isHomeURL(url) && !url.includes("search-results.html")) {
      event.preventDefault();
    }
  });

  wc.on("did-start-loading", () => {
    tab.loading = true;
    pushState();
  });

  wc.on("did-stop-loading", () => {
    tab.loading = false;
    tab.lastUrl = wc.getURL() || tab.lastUrl;
    pushState();
  });

  wc.on("did-navigate", (_event, url) => {
    tab.loading = false;
    tab.lastUrl = url;

    if (/^https?:\/\//i.test(url)) {
      tab.displayUrl = null;
      tab.searchDisplayUrl = null;
      recordHistory(url, wc.getTitle());
    } else if (url.includes("search-results.html")) {
      try {
        const parsed = new URL(url);
        const query = parsed.searchParams.get("q") || tab.lastSearchQuery || "";
        tab.searchDisplayUrl = "nexora://search?q=" + encodeURIComponent(query);
        tab.displayUrl = tab.searchDisplayUrl;
      } catch (_) {}
    } else {
      tab.displayUrl = null;
    }

    pushState();
  });

  wc.on("did-navigate-in-page", (_event, url) => {
    tab.lastUrl = url;
    pushState();
  });

  wc.on("page-title-updated", () => {
    pushState();
  });

  wc.on("render-process-gone", () => {
    tab.loading = false;
    pushState();
    notify("Un onglet a rencontrÃ© une erreur de rendu.");
  });

  wc.on("context-menu", (_event, params) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const menuItems = [
      {
        label: "Retour",
        enabled: canGoBack(wc),
        click: () => canGoBack(wc) && goBack(wc)
      },
      {
        label: "Suivant",
        enabled: canGoForward(wc),
        click: () => canGoForward(wc) && goForward(wc)
      },
      {
        label: "Actualiser",
        click: () => wc.reload()
      },
      { type: "separator" }
    ];

    if (params.linkURL && safeExternalURL(params.linkURL)) {
      menuItems.push({
        label: "Ouvrir le lien dans un nouvel onglet",
        click: () => openTab(safeExternalURL(params.linkURL), true, false)
      });
    }

    if (params.selectionText) {
      menuItems.push({
        label: "Rechercher la sÃ©lection avec " + store.defaultEngine,
        click: () => openTab(
          searchURL(params.selectionText),
          true,
          false
        )
      });
    }

    menuItems.push(
      { type: "separator" },
      { label: "Copier", role: "copy" },
      { label: "Tout sÃ©lectionner", role: "selectAll" }
    );

    Menu.buildFromTemplate(menuItems).popup({ window: mainWindow });
  });

  layoutTabs();
  pushState();

  const target = initialURL && (
    isHomeURL(initialURL) || safeExternalURL(initialURL)
  ) ? initialURL : makeHomeURL();

  wc.loadURL(target).catch(error => {
    console.error("Erreur de navigation :", error);
    tab.loading = false;
    pushState();
    notify("Impossible de charger cette page.");
  });

  if (focusAddress) {
    setTimeout(() => focusAddressBar(), 250);
  }

  return id;
}

function focusAddressBar() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.focus();
  mainWindow.webContents.send("browser:focus-address");
}

function closeTab(id = activeTabId) {
  const tab = tabs.get(id);
  if (!tab) return;

  if (tabs.size <= 1) {
    tab.view.webContents.loadURL(makeHomeURL()).catch(() => {});
    return;
  }

  const allIds = Array.from(tabs.keys());
  const oldIndex = allIds.indexOf(id);

  mainWindow.contentView.removeChildView(tab.view);

  try {
    tab.view.webContents.destroy();
  } catch (_) {}

  tabs.delete(id);

  if (activeTabId === id) {
    const remaining = Array.from(tabs.keys());
    activeTabId = remaining[Math.max(0, Math.min(oldIndex, remaining.length - 1))];
  }

  layoutTabs();
  pushState();
}

function canGoBack(wc) {
  try {
    return wc.navigationHistory
      ? wc.navigationHistory.canGoBack()
      : wc.canGoBack();
  } catch (_) {
    return false;
  }
}

function canGoForward(wc) {
  try {
    return wc.navigationHistory
      ? wc.navigationHistory.canGoForward()
      : wc.canGoForward();
  } catch (_) {
    return false;
  }
}

function goBack(wc) {
  try {
    if (wc.navigationHistory) return wc.navigationHistory.goBack();
    return wc.goBack();
  } catch (_) {}
}

function goForward(wc) {
  try {
    if (wc.navigationHistory) return wc.navigationHistory.goForward();
    return wc.goForward();
  } catch (_) {}
}

function findResultArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;

  for (const key of [
    "results", "items", "urls", "pages", "documents",
    "hits", "searchResults", "entries"
  ]) {
    if (Array.isArray(payload[key])) return payload[key];
  }

  for (const key of ["data", "result", "search", "payload"]) {
    const nested = findResultArray(payload[key]);
    if (nested !== null) return nested;
  }

  return null;
}

function normalizeNexoraResults(payload) {
  const items = findResultArray(payload);
  if (items === null) return null;

  return items.map(item => {
    if (typeof item === "string") {
      return { url: item, title: item, snippet: "" };
    }

    if (!item || typeof item !== "object") return null;

    if (
      item.indexed === false ||
      item.isIndexed === false ||
      item.is_indexed === false
    ) return null;

    let rawURL =
      item.url ||
      item.href ||
      item.link ||
      item.canonicalUrl ||
      item.canonical_url ||
      item.address ||
      "";

    if (typeof rawURL !== "string") return null;

    rawURL = rawURL.trim();

    if (/^(www\.)/i.test(rawURL)) rawURL = "https://" + rawURL;

    const url = safeExternalURL(rawURL);
    if (!url) return null;

    return {
      url,
      title: String(item.title || item.name || item.label || url),
      snippet: String(
        item.snippet ||
        item.description ||
        item.content ||
        item.excerpt ||
        ""
      )
    };
  }).filter(Boolean).slice(0, 40);
}

async function requestNexoraResults(query) {
  const encoded = encodeURIComponent(query);

  const candidates = [
    "http://127.0.0.1:3080/api/search?q=" + encoded,
    "http://localhost:3080/api/search?q=" + encoded,
    "http://127.0.0.1:3080/api/search?query=" + encoded,
    "http://localhost:3080/api/search?query=" + encoded,
    "http://127.0.0.1:3080/search?q=" + encoded,
    "http://localhost:3080/search?q=" + encoded,
    "http://127.0.0.1:3080/search?query=" + encoded,
    "http://127.0.0.1:3080/api/index/search?q=" + encoded,
    "http://127.0.0.1:3080/api/indexed-search?q=" + encoded,
    "http://127.0.0.1:3080/api/indexed/search?q=" + encoded,
    "http://127.0.0.1:3080/api/v1/search?q=" + encoded
  ];

  if (process.env.NEXORA_SEARCH_API) {
    const base = process.env.NEXORA_SEARCH_API;

    candidates.unshift(
      base + (base.includes("?") ? "&" : "?") + "q=" + encoded
    );
  }

  const attempts = await Promise.all(candidates.map(async url => {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(2500)
      });

      if (!response.ok) return null;

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("json")) return null;

      const payload = await response.json();
      const results = normalizeNexoraResults(payload);

      if (results !== null) return { results, endpoint: url };
    } catch (_) {}

    return null;
  }));

  const match = attempts.find(Boolean);

  if (match) return { ok: true, results: match.results, endpoint: match.endpoint };

  return {
    ok: false,
    results: [],
    error:
      "L'API de recherche Nexora Indexation n'a pas répondu avec des résultats JSON. " +
      "Vérifie que le serveur tourne sur le port 3080 et que son endpoint de recherche est disponible."
  };
}

async function loadNexoraSearch(tab, query) {
  if (!tab || !tabs.has(tab.id)) return;

  query = String(query || "").trim();

  if (!query) {
    tab.displayUrl = null;
    tab.view.webContents.loadURL(makeHomeURL()).catch(() => {});
    return;
  }

  tab.lastSearchQuery = query;
  tab.searchDisplayUrl = "nexora://search?q=" + encodeURIComponent(query);
  tab.displayUrl = tab.searchDisplayUrl;
  tab.loading = true;
  pushState();

  const response = await requestNexoraResults(query);

  if (!tabs.has(tab.id)) return;

  const webContents = tab.view.webContents;

  try {
    await webContents.loadFile(SEARCH_RESULTS_FILE, {
      query: {
        q: query,
        data: Buffer.from(JSON.stringify(response.results)).toString("base64"),
        error: response.ok ? "" : response.error,
        endpoint: response.endpoint || ""
      }
    });

    tab.loading = false;
    tab.displayUrl = tab.searchDisplayUrl;
    tab.lastUrl = tab.displayUrl;
    pushState();
  } catch (error) {
    tab.loading = false;
    console.error("Erreur de chargement des résultats Nexora :", error);
    notify("Impossible d'afficher les résultats Nexora.");
    pushState();
  }
}
function navigateCurrent(input) {
  const tab = getActiveTab();
  if (!tab) return;

  const target = resolveInput(input);

  tab.loading = true;
  tab.view.webContents.loadURL(target).catch(error => {
    tab.loading = false;
    console.error("Navigation impossible :", error);
    pushState();
    notify("La navigation a Ã©chouÃ©.");
  });

  pushState();
}

function performAction(action) {
  const tab = getActiveTab();
  if (!tab) return;

  const wc = tab.view.webContents;

  switch (action) {
    case "back":
      if (canGoBack(wc)) goBack(wc);
      break;
    case "forward":
      if (canGoForward(wc)) goForward(wc);
      break;
    case "reload":
      if (wc.isLoading()) wc.stop();
      else wc.reload();
      break;
    case "home":
      wc.loadURL(makeHomeURL()).catch(() => {});
      break;
    case "zoom-in":
      wc.setZoomLevel(wc.getZoomLevel() + 0.5);
      break;
    case "zoom-out":
      wc.setZoomLevel(wc.getZoomLevel() - 0.5);
      break;
    case "zoom-reset":
      wc.setZoomLevel(0);
      break;
  }

  pushState();
}

function addBookmark() {
  const tab = getActiveTab();

  if (!tab) return false;

  const wc = tab.view.webContents;
  const url = wc.getURL();

  if (!/^https?:\/\//i.test(url)) {
    notify("La page d'accueil locale ne peut pas Ãªtre ajoutÃ©e aux favoris.");
    return false;
  }

  const existing = store.bookmarks.findIndex(item => item.url === url);

  if (existing >= 0) {
    store.bookmarks.splice(existing, 1);
  }

  store.bookmarks.unshift({
    title: wc.getTitle() || url,
    url
  });

  store.bookmarks = store.bookmarks.slice(0, 500);
  saveStore();
  pushState();
  notify("Page ajoutÃ©e aux favoris.");

  return true;
}

function setEngine(engine) {
  if (!Object.prototype.hasOwnProperty.call(SEARCH_ENGINES, engine)) return;

  store.defaultEngine = engine;
  saveStore();

  const tab = getActiveTab();

  if (tab && isHomeURL(tab.view.webContents.getURL())) {
    tab.view.webContents.loadURL(makeHomeURL()).catch(() => {});
  }

  pushState();
  notify("Moteur de recherche : " + engine);
}

function showBookmarksMenu() {
  const items = [
    {
      label: "Ajouter la page actuelle aux favoris",
      click: () => addBookmark()
    },
    { type: "separator" }
  ];

  if (store.bookmarks.length === 0) {
    items.push({ label: "Aucun favori enregistrÃ©", enabled: false });
  } else {
    store.bookmarks.slice(0, 40).forEach(bookmark => {
      items.push({
        label: String(bookmark.title || bookmark.url).slice(0, 90),
        click: () => navigateCurrent(bookmark.url)
      });
    });
  }

  Menu.buildFromTemplate(items).popup({ window: mainWindow });
}

function showHistoryMenu() {
  const items = [
    {
      label: "Effacer l'historique",
      click: () => clearHistory()
    },
    { type: "separator" }
  ];

  if (store.history.length === 0) {
    items.push({ label: "Aucune page visitÃ©e", enabled: false });
  } else {
    store.history.slice(0, 30).forEach(entry => {
      const when = new Date(entry.time).toLocaleString("fr-FR");

      items.push({
        label: String(entry.title || entry.url).slice(0, 70) + " â€” " + when,
        click: () => navigateCurrent(entry.url)
      });
    });
  }

  Menu.buildFromTemplate(items).popup({ window: mainWindow });
}

function clearHistory() {
  store.history = [];
  saveStore();
  pushState();
  notify("Historique effacÃ©.");
}

function showSettingsMenu() {
  const engineItems = Object.keys(SEARCH_ENGINES).map(engine => ({
    label: engine,
    type: "radio",
    checked: store.defaultEngine === engine,
    click: () => setEngine(engine)
  }));

  Menu.buildFromTemplate([
    {
      label: "Moteur de recherche par dÃ©faut",
      submenu: engineItems
    },
    { type: "separator" },
    { label: "Ouvrir l'accueil Nexora", click: () => performAction("home") },
    { label: "Effacer l'historique", click: () => clearHistory() },
    { label: "Ouvrir le dossier des tÃ©lÃ©chargements", click: () => openDownloads() },
    { type: "separator" },
    { label: "Zoom avant", click: () => performAction("zoom-in") },
    { label: "Zoom arriÃ¨re", click: () => performAction("zoom-out") },
    { label: "RÃ©initialiser le zoom", click: () => performAction("zoom-reset") },
    { type: "separator" },
    { label: "Ã€ propos de Nexora Browser", click: () => showAbout() }
  ]).popup({ window: mainWindow });
}

function getDownloadsState() {
  return Array.from(activeDownloads.values()).map(entry => {
    const item = entry.item;

    let received = entry.receivedBytes || 0;
    let total = entry.totalBytes || 0;
    let percent = entry.percent || 0;
    let speed = 0;
    let state = entry.state || "progressing";

    try {
      received = item.getReceivedBytes();
      total = item.getTotalBytes();
      percent = total > 0 ? Math.round(received / total * 100) : 0;
      speed = item.getCurrentBytesPerSecond();
    } catch (_) {}

    if (state === "completed") percent = 100;

    return {
      id: entry.id,
      filename: entry.filename,
      url: entry.url,
      path: entry.path,
      receivedBytes: received,
      totalBytes: total,
      percent: Math.max(0, Math.min(100, percent)),
      speed,
      state
    };
  }).sort((a, b) => b.id - a.id);
}

function publishDownloads() {
  if (downloadsWindow && !downloadsWindow.isDestroyed()) {
    downloadsWindow.webContents.send("browser:downloads", getDownloadsState());
  }
}

function openDownloadsManager() {
  if (downloadsWindow && !downloadsWindow.isDestroyed()) {
    downloadsWindow.show();
    downloadsWindow.focus();
    publishDownloads();
    return;
  }

  downloadsWindow = new BrowserWindow({
    width: 760,
    height: 700,
    minWidth: 560,
    minHeight: 480,
    title: "Téléchargements — Nexora Browser",
    backgroundColor: "#0b1020",
    autoHideMenuBar: true,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  downloadsWindow.loadFile(DOWNLOADS_FILE);

  downloadsWindow.once("ready-to-show", () => {
    if (downloadsWindow && !downloadsWindow.isDestroyed()) {
      downloadsWindow.show();
      publishDownloads();
    }
  });

  downloadsWindow.on("closed", () => {
    downloadsWindow = null;
  });
}

function isTrackerHost(hostname) {
  const host = String(hostname || "").toLowerCase();

  return TRACKER_DOMAINS.some(domain =>
    host === domain || host.endsWith("." + domain)
  );
}

function isSameSiteHost(firstHost, secondHost) {
  if (!firstHost || !secondHost) return false;

  const first = firstHost.toLowerCase();
  const second = secondHost.toLowerCase();

  return first === second ||
    first.endsWith("." + second) ||
    second.endsWith("." + first);
}

function applyShields() {
  if (!browserSession) return;

  browserSession.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"] },
    (details, callback) => {
      if (!shieldsEnabled) {
        callback({});
        return;
      }

      try {
        const requestURL = new URL(details.url);

        if (!/^https?:$/.test(requestURL.protocol)) {
          callback({});
          return;
        }

        if (details.resourceType === "mainFrame") {
          callback({});
          return;
        }

        const initiator = details.initiatorOrigin || details.initiator || details.referrer || "";
        let sourceHost = "";

        try {
          sourceHost = new URL(initiator).hostname;
        } catch (_) {}

        const thirdParty = sourceHost &&
          !isSameSiteHost(sourceHost, requestURL.hostname);

        if (thirdParty && isTrackerHost(requestURL.hostname)) {
          blockedTrackerCount++;

          if (blockedTrackerCount % 10 === 0) {
            pushState();
          }

          callback({ cancel: true });
          return;
        }
      } catch (_) {}

      callback({});
    }
  );
}

async function chooseAndLoadExtension() {
  if (!browserSession) {
    return { ok: false, message: "La session du navigateur n'est pas prête." };
  }

  const dialogOptions = {
    title: "Choisir un dossier d'extension Chrome décompressée",
    properties: ["openDirectory"]
  };

  const selection = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showOpenDialog(mainWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (selection.canceled || !selection.filePaths.length) {
    return { ok: false, message: "Aucun dossier sélectionné." };
  }

  const extensionPath = selection.filePaths[0];
  const manifestPath = path.join(extensionPath, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    return {
      ok: false,
      message: "Ce dossier ne contient pas de manifest.json."
    };
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    const extension = await browserSession.extensions.loadExtension(
      extensionPath,
      { allowFileAccess: false }
    );

    if (!store.extensionPaths.includes(extensionPath)) {
      store.extensionPaths.push(extensionPath);
    }

    saveStore();

    return {
      ok: true,
      message: "Extension chargée : " + (extension.name || manifest.name || path.basename(extensionPath))
    };
  } catch (error) {
    console.error("Chargement d'extension impossible :", error);

    return {
      ok: false,
      message: "Cette extension n'est pas compatible ou ne peut pas être chargée : " + error.message
    };
  }
}
function openDownloads() {
  shell.openPath(app.getPath("downloads")).then(errorMessage => {
    if (errorMessage) notify(errorMessage);
  });
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "Ã€ propos de Nexora Browser",
    message: "Nexora Browser 2.0.0",
    detail: "Un navigateur de bureau construit avec Electron et Chromium.\n\nLes cookies et sessions sont conservÃ©s localement. Les favoris et l'historique sont enregistrÃ©s dans le dossier de donnÃ©es de Nexora."
  });
}

function uniqueDownloadPath(filename) {
  const directory = app.getPath("downloads");
  const extension = path.extname(filename);
  const base = path.basename(filename, extension);

  let candidate = path.join(directory, filename);
  let index = 1;

  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${base} (${index})${extension}`);
    index++;
  }

  return candidate;
}

function installApplicationMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: "Fichier",
      submenu: [
        {
          label: "Nouvel onglet",
          accelerator: "Ctrl+T",
          click: () => openTab(makeHomeURL(), true, true)
        },
        {
          label: "Fermer l'onglet",
          accelerator: "Ctrl+W",
          click: () => closeTab()
        },
        { type: "separator" },
        { label: "Quitter Nexora", role: "quit" }
      ]
    },
    {
      label: "Ã‰dition",
      submenu: [
        { role: "undo", label: "Annuler" },
        { role: "redo", label: "RÃ©tablir" },
        { type: "separator" },
        { role: "cut", label: "Couper" },
        { role: "copy", label: "Copier" },
        { role: "paste", label: "Coller" },
        { role: "selectAll", label: "Tout sÃ©lectionner" }
      ]
    },
    {
      label: "Navigation",
      submenu: [
        { label: "Retour", accelerator: "Alt+Left", click: () => performAction("back") },
        { label: "Suivant", accelerator: "Alt+Right", click: () => performAction("forward") },
        { label: "Actualiser", accelerator: "Ctrl+R", click: () => performAction("reload") },
        { label: "Accueil", accelerator: "Alt+Home", click: () => performAction("home") },
        { type: "separator" },
        { label: "Barre d'adresse", accelerator: "Ctrl+L", click: () => focusAddressBar() }
      ]
    },
    {
      label: "Historique",
      submenu: [
        { label: "Afficher les pages visitÃ©es", click: () => showHistoryMenu() },
        { label: "Effacer l'historique", click: () => clearHistory() }
      ]
    },
    {
      label: "Favoris",
      submenu: [
        { label: "Ajouter cette page", accelerator: "Ctrl+D", click: () => addBookmark() },
        { label: "Afficher les favoris", click: () => showBookmarksMenu() }
      ]
    },
    {
      label: "Affichage",
      submenu: [
        { label: "Zoom avant", accelerator: "Ctrl+Shift+=", click: () => performAction("zoom-in") },
        { label: "Zoom arriÃ¨re", accelerator: "Ctrl+-", click: () => performAction("zoom-out") },
        { label: "Zoom normal", accelerator: "Ctrl+0", click: () => performAction("zoom-reset") },
        { type: "separator" },
        { role: "togglefullscreen", label: "Plein Ã©cran" }
      ]
    },
    {
      label: "Outils",
      submenu: [
        { label: "TÃ©lÃ©chargements", accelerator: "Ctrl+J", click: () => openDownloads() },
        { label: "ParamÃ¨tres", click: () => showSettingsMenu() }
      ]
    },
    {
      label: "Aide",
      submenu: [
        { label: "Ã€ propos de Nexora Browser", click: () => showAbout() }
      ]
    }
  ]);

  Menu.setApplicationMenu(menu);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: "#0b1020",
    title: "Nexora Browser",
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  installApplicationMenu();

  mainWindow.on("resize", layoutTabs);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    tabs.clear();
    activeTabId = null;
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"))
    .then(() => {
      openTab(makeHomeURL(), true, true);
    })
    .catch(error => {
      dialog.showErrorBox(
        "Erreur Nexora Browser",
        "Impossible d'ouvrir l'interface : " + error.message
      );
    });
}

app.setAppUserModelId(APP_ID);

ipcMain.handle("browser:get-state", () => getState());

ipcMain.handle("browser:new-tab", (_event, url) => {
  return openTab(url ? resolveInput(url) : makeHomeURL(), true, true);
});

ipcMain.handle("browser:switch-tab", (_event, id) => {
  switchTab(Number(id));
});

ipcMain.handle("browser:close-tab", (_event, id) => {
  closeTab(Number(id));
});

ipcMain.handle("browser:navigate", (_event, input) => {
  navigateCurrent(input);
});

ipcMain.handle("browser:action", (_event, action) => {
  performAction(action);
});

ipcMain.handle("browser:add-bookmark", () => addBookmark());

ipcMain.handle("browser:toggle-shields", (_event, enabled) => {
  shieldsEnabled = Boolean(enabled);
  store.shieldsEnabled = shieldsEnabled;
  saveStore();
  pushState();
  return { enabled: shieldsEnabled, blocked: blockedTrackerCount };
});

ipcMain.handle("browser:manage-extensions", () => chooseAndLoadExtension());

ipcMain.handle("browser:get-downloads", () => getDownloadsState());

ipcMain.handle("browser:open-download-file", async (_event, id) => {
  const entry = activeDownloads.get(Number(id));

  if (!entry || entry.state !== "completed" || !fs.existsSync(entry.path)) {
    return { ok: false, message: "Le fichier n'est pas encore disponible." };
  }

  const errorMessage = await shell.openPath(entry.path);

  return errorMessage
    ? { ok: false, message: errorMessage }
    : { ok: true, message: "Fichier ouvert." };
});

ipcMain.handle("browser:cancel-download", (_event, id) => {
  const entry = activeDownloads.get(Number(id));

  if (!entry || entry.state !== "progressing") return false;

  try {
    entry.item.cancel();
    return true;
  } catch (_) {
    return false;
  }
});

ipcMain.on("browser:open-downloads-folder", () => openDownloads());

ipcMain.handle("browser:set-engine", (_event, engine) => {
  setEngine(engine);
});

ipcMain.on("browser:show-bookmarks", () => showBookmarksMenu());
ipcMain.on("browser:show-history", () => showHistoryMenu());
ipcMain.on("browser:show-settings", () => showSettingsMenu());
ipcMain.on("browser:open-downloads", () => openDownloadsManager());

app.whenReady().then(async () => {
  loadStore();

  browserSession = session.fromPartition("persist:nexora-profile");

  browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media" || permission === "notifications");
  });

  browserSession.on("will-download", (_event, item) => {
    const filename = item.getFilename();
    const savePath = uniqueDownloadPath(filename);

    item.setSavePath(savePath);

    item.on("updated", () => {
      if (item.getTotalBytes() > 0) {
        const progress = Math.round(
          item.getReceivedBytes() / item.getTotalBytes() * 100
        );

        if (progress === 100) {
          notify("TÃ©lÃ©chargement presque terminÃ© : " + filename);
        }
      }
    });

    item.once("done", (_event, state) => {
      if (state === "completed") {
        notify("TÃ©lÃ©chargement terminÃ© : " + filename);
      } else {
        notify("TÃ©lÃ©chargement interrompu : " + filename);
      }
    });
  });

  shieldsEnabled = store.shieldsEnabled !== false;
  applyShields();

  for (const extensionPath of store.extensionPaths || []) {
    try {
      if (fs.existsSync(path.join(extensionPath, "manifest.json"))) {
        await browserSession.extensions.loadExtension(extensionPath, {
          allowFileAccess: false
        });
      }
    } catch (error) {
      console.warn("Extension ignorée au démarrage :", extensionPath, error.message);
    }
  }

  createWindow();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    shieldsEnabled = store.shieldsEnabled !== false;
  applyShields();

  for (const extensionPath of store.extensionPaths || []) {
    try {
      if (fs.existsSync(path.join(extensionPath, "manifest.json"))) {
        await browserSession.extensions.loadExtension(extensionPath, {
          allowFileAccess: false
        });
      }
    } catch (error) {
      console.warn("Extension ignorée au démarrage :", extensionPath, error.message);
    }
  }

  createWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});