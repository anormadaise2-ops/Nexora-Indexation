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
const nexoraPortal = require("./web/server.js");
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
let indexerWindow = null;
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
    console.error("Impossible de lire les donnÃƒÆ’Ã‚Â©es Nexora :", error);
  }
}

function saveStore() {
  try {
    fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
    fs.writeFileSync(dataFile(), JSON.stringify(store, null, 2), "utf8");
  } catch (error) {
    console.error("Impossible de sauvegarder les donnÃƒÆ’Ã‚Â©es Nexora :", error);
  }
}

function isHomeURL(rawURL) {
  try {
    const candidate = new URL(String(rawURL || ""));
    const expected = new URL(HOME_BASE);

    if (candidate.protocol !== "file:" || expected.protocol !== "file:") {
      return false;
    }

    const normalizePath = value =>
      decodeURIComponent(value)
        .replace(/^\/([A-Za-z]:)/, "$1")
        .toLowerCase();

    return normalizePath(candidate.pathname) === normalizePath(expected.pathname);
  } catch (_) {
    return false;
  }
}
function makeHomeURL() { return HOME_BASE; }

function getActiveTab() {
  return tabs.get(activeTabId) || null;
}

function loadTabURL(tab, target) {
  const wc = tab.view.webContents;
  const rawURL = String(target || "");

  if (isHomeURL(rawURL)) {
    return wc.loadFile(path.join(__dirname, "home.html"), {
      query: {
        engine: String(store.defaultEngine || "Nexora")
      }
    });
  }

  if (/^nexora-search:/i.test(rawURL)) {
    const parsed = new URL(rawURL);
    return loadNexoraSearch(tab, parsed.searchParams.get("q") || "");
  }

  const safeURL = safeExternalURL(rawURL);

  if (safeURL) {
    return wc.loadURL(safeURL);
  }

  return Promise.reject(new Error("Adresse non autorisée par Nexora Browser."));
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
    shieldsEnabled,
    blockedTrackerCount,
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
        " ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Nexora Browser"
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

    if (url.startsWith("file:") &&
        !isHomeURL(url) &&
        !url.includes("search-results.html")) {
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
    notify("Un onglet a rencontrÃƒÆ’Ã‚Â© une erreur de rendu.");
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
        label: "Rechercher la sÃƒÆ’Ã‚Â©lection avec " + store.defaultEngine,
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
      { label: "Tout sÃƒÆ’Ã‚Â©lectionner", role: "selectAll" }
    );

    Menu.buildFromTemplate(menuItems).popup({ window: mainWindow });
  });

  layoutTabs();
  pushState();

  const target = initialURL && (
    isHomeURL(initialURL) || safeExternalURL(initialURL)
  ) ? initialURL : makeHomeURL();

  loadTabURL(tab, target).catch(error => {
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
    loadTabURL(tab, makeHomeURL()).catch(() => {});
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
  try {
    const endpoint = "https://nexora-indexation.anormadaise2.workers.dev/api/search?q=" + encodeURIComponent(query);
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) throw new Error("API Nexora indisponible.");

    const data = await response.json();

    return {
      ok: data.ok !== false,
      results: Array.isArray(data.results) ? data.results : [],
      endpoint,
      error: data.message || data.error || ""
    };
  } catch (error) {
    return {
      ok: false,
      results: [],
      error: "Nexora Indexation est indisponible. Ouvre d'abord le tableau de bord Indexation."
    };
  }
}
async function loadNexoraSearch(tab, query) {
  if (!tab || !tabs.has(tab.id)) return;

  query = String(query || "").trim();

  if (!query) {
    tab.displayUrl = null;
    loadTabURL(tab, makeHomeURL()).catch(() => {});
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
    console.error("Erreur de chargement des rÃƒÂ©sultats Nexora :", error);
    notify("Impossible d'afficher les rÃƒÂ©sultats Nexora.");
    pushState();
  }
}
function navigateCurrent(input) {
  const tab = getActiveTab();
  if (!tab) return;

  const target = resolveInput(input);

  tab.loading = true;
  loadTabURL(tab, target).catch(error => {
    tab.loading = false;
    console.error("Navigation impossible :", error);
    pushState();
    notify("La navigation a ÃƒÆ’Ã‚Â©chouÃƒÆ’Ã‚Â©.");
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
      loadTabURL(tab, makeHomeURL()).catch(() => {});
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
    notify("La page d'accueil locale ne peut pas ÃƒÆ’Ã‚Âªtre ajoutÃƒÆ’Ã‚Â©e aux favoris.");
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
  notify("Page ajoutÃƒÆ’Ã‚Â©e aux favoris.");

  return true;
}

function setEngine(engine) {
  if (!Object.prototype.hasOwnProperty.call(SEARCH_ENGINES, engine)) return;

  store.defaultEngine = engine;
  saveStore();

  const tab = getActiveTab();

  if (tab && isHomeURL(tab.view.webContents.getURL())) {
    loadTabURL(tab, makeHomeURL()).catch(() => {});
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
    items.push({ label: "Aucun favori enregistrÃƒÆ’Ã‚Â©", enabled: false });
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
    items.push({ label: "Aucune page visitÃƒÆ’Ã‚Â©e", enabled: false });
  } else {
    store.history.slice(0, 30).forEach(entry => {
      const when = new Date(entry.time).toLocaleString("fr-FR");

      items.push({
        label: String(entry.title || entry.url).slice(0, 70) + " ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â " + when,
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
  notify("Historique effacÃƒÆ’Ã‚Â©.");
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
      label: "Moteur de recherche par dÃƒÆ’Ã‚Â©faut",
      submenu: engineItems
    },
    { type: "separator" },
    { label: "Ouvrir l'accueil Nexora", click: () => performAction("home") },
    { label: "Effacer l'historique", click: () => clearHistory() },
    { label: "Ouvrir le dossier des tÃƒÆ’Ã‚Â©lÃƒÆ’Ã‚Â©chargements", click: () => openDownloads() },
    { type: "separator" },
    { label: "Zoom avant", click: () => performAction("zoom-in") },
    { label: "Zoom arriÃƒÆ’Ã‚Â¨re", click: () => performAction("zoom-out") },
    { label: "RÃƒÆ’Ã‚Â©initialiser le zoom", click: () => performAction("zoom-reset") },
    { type: "separator" },
    { label: "ÃƒÆ’Ã¢â€šÂ¬ propos de Nexora Browser", click: () => showAbout() }
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
    title: "TÃƒÂ©lÃƒÂ©chargements Ã¢â‚¬â€ Nexora Browser",
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
    return { ok: false, message: "La session du navigateur n'est pas prÃƒÂªte." };
  }

  const dialogOptions = {
    title: "Choisir un dossier d'extension Chrome dÃƒÂ©compressÃƒÂ©e",
    properties: ["openDirectory"]
  };

  const selection = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showOpenDialog(mainWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (selection.canceled || !selection.filePaths.length) {
    return { ok: false, message: "Aucun dossier sÃƒÂ©lectionnÃƒÂ©." };
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

    const extension = browserSession.extensions.loadExtension(extensionPath, { allowFileAccess: false }).catch(error => console.warn("Extension ignorée :", extensionPath, error.message));

    if (!store.extensionPaths.includes(extensionPath)) {
      store.extensionPaths.push(extensionPath);
    }

    saveStore();

    return {
      ok: true,
      message: "Extension chargÃƒÂ©e : " + (extension.name || manifest.name || path.basename(extensionPath))
    };
  } catch (error) {
    console.error("Chargement d'extension impossible :", error);

    return {
      ok: false,
      message: "Cette extension n'est pas compatible ou ne peut pas ÃƒÂªtre chargÃƒÂ©e : " + error.message
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
    title: "ÃƒÆ’Ã¢â€šÂ¬ propos de Nexora Browser",
    message: "Nexora Browser 2.0.0",
    detail: "Un navigateur de bureau construit avec Electron et Chromium.\n\nLes cookies et sessions sont conservÃƒÆ’Ã‚Â©s localement. Les favoris et l'historique sont enregistrÃƒÆ’Ã‚Â©s dans le dossier de donnÃƒÆ’Ã‚Â©es de Nexora."
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
      label: "ÃƒÆ’Ã¢â‚¬Â°dition",
      submenu: [
        { role: "undo", label: "Annuler" },
        { role: "redo", label: "RÃƒÆ’Ã‚Â©tablir" },
        { type: "separator" },
        { role: "cut", label: "Couper" },
        { role: "copy", label: "Copier" },
        { role: "paste", label: "Coller" },
        { role: "selectAll", label: "Tout sÃƒÆ’Ã‚Â©lectionner" }
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
        { label: "Afficher les pages visitÃƒÆ’Ã‚Â©es", click: () => showHistoryMenu() },
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
        { label: "Zoom arriÃƒÆ’Ã‚Â¨re", accelerator: "Ctrl+-", click: () => performAction("zoom-out") },
        { label: "Zoom normal", accelerator: "Ctrl+0", click: () => performAction("zoom-reset") },
        { type: "separator" },
        { role: "togglefullscreen", label: "Plein ÃƒÆ’Ã‚Â©cran" }
      ]
    },
    {
      label: "Outils",
      submenu: [
        { label: "TÃƒÆ’Ã‚Â©lÃƒÆ’Ã‚Â©chargements", accelerator: "Ctrl+J", click: () => openDownloads() },
        { label: "ParamÃƒÆ’Ã‚Â¨tres", click: () => showSettingsMenu() }
      ]
    },
    {
      label: "Aide",
      submenu: [
        { label: "ÃƒÆ’Ã¢â€šÂ¬ propos de Nexora Browser", click: () => showAbout() }
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

function nxRouteConfig() {
  try {
    const f = path.join(__dirname, "web", "server-routes.json");
    const data = JSON.parse(fs.readFileSync(f, "utf8"));

    return {
      sourceFound: Boolean(data.sourceFound),
      routes: Array.isArray(data.routes) ? data.routes : []
    };
  } catch (_) {
    return { sourceFound: false, routes: [] };
  }
}

function nxNormalizeBase(rawBase) {
  const value = String(
    rawBase || process.env.NEXORA_INDEXATION_URL || "http://127.0.0.1:3080"
  ).trim();

  try {
    const parsed = new URL(value);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, message: "L'adresse du serveur doit utiliser HTTP ou HTTPS." };
    }

    return {
      ok: true,
      base: parsed.href.replace(/\/+$/, "")
    };
  } catch (_) {
    return { ok: false, message: "Adresse du serveur Nexora invalide." };
  }
}

function nxRoutePaths(method, pattern, fallbacks) {
  const config = nxRouteConfig();

  const discovered = config.routes
    .filter(route =>
      route.method === method &&
      typeof route.path === "string" &&
      route.path.startsWith("/") &&
      !route.path.includes(":") &&
      pattern.test(route.path)
    )
    .map(route => route.path);

  return Array.from(new Set([...discovered, ...fallbacks])).slice(0, 35);
}

async function nxReadResponse(response) {
  const text = await response.text();

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (_) {
    return { rawText: text.slice(0, 1500) };
  }
}

function nxFindArray(payload, depth = 0) {
  if (Array.isArray(payload)) return payload;

  if (!payload || typeof payload !== "object" || depth > 5) {
    return null;
  }

  const keys = [
    "results", "items", "urls", "pages", "documents",
    "sites", "indexedUrls", "indexed_urls", "records",
    "entries", "hits", "data", "result", "indexed",
    "searchResults", "search_results"
  ];

  for (const key of keys) {
    if (payload[key] !== undefined) {
      const found = nxFindArray(payload[key], depth + 1);
      if (found !== null) return found;
    }
  }

  return null;
}

function nxNormalizeItems(items) {
  if (!Array.isArray(items)) return null;

  return items.map(item => {
    if (typeof item === "string") {
      const url = safeExternalURL(item);

      return url
        ? { url, title: url, snippet: "" }
        : null;
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

    if (/^www\./i.test(rawURL)) rawURL = "https://" + rawURL;

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
  }).filter(Boolean).slice(0, 100);
}

async function nxIndexerStatus(rawBase) {
  const normalized = nxNormalizeBase(rawBase);

  if (!normalized.ok) {
    return { ok: false, online: false, message: normalized.message };
  }

  const paths = nxRoutePaths(
    "GET",
    /health|status|stats|ping|version/i,
    ["/api/health", "/health", "/api/status", "/api/stats", "/"]
  );

  for (const route of paths) {
    try {
      const response = await fetch(normalized.base + route, {
        headers: { Accept: "application/json, text/plain, text/html" },
        signal: AbortSignal.timeout(2500)
      });

      if (response.status === 404 || response.status === 405) continue;

      return {
        ok: response.status < 500,
        online: response.status < 500,
        status: response.status,
        baseUrl: normalized.base,
        endpoint: normalized.base + route,
        routeCount: nxRouteConfig().routes.length,
        sourceFound: nxRouteConfig().sourceFound,
        routes: nxRouteConfig().routes.slice(0, 100),
        message: response.status < 500
          ? "Le serveur Nexora rÃ©pond."
          : "Le serveur rÃ©pond, mais signale une erreur HTTP."
      };
    } catch (_) {}
  }

  return {
    ok: false,
    online: false,
    baseUrl: normalized.base,
    routeCount: nxRouteConfig().routes.length,
    sourceFound: nxRouteConfig().sourceFound,
    routes: nxRouteConfig().routes.slice(0, 100),
    message: "Serveur indisponible. VÃ©rifie que Nexora Indexation fonctionne sur le port 3080."
  };
}

async function nxIndexerAddURL(rawBase, rawURL) {
  const normalized = nxNormalizeBase(rawBase);

  if (!normalized.ok) return { ok: false, message: normalized.message };

  const url = safeExternalURL(String(rawURL || "").trim());

  if (!url) {
    return {
      ok: false,
      message: "Entre une adresse HTTP ou HTTPS valide."
    };
  }

  const routes = nxRoutePaths(
    "POST",
    /index|crawl|submit|queue|ingest|url|page/i,
    [
      "/api/index",
      "/api/index-url",
      "/api/crawl",
      "/api/crawl-url",
      "/api/submit-url",
      "/api/indexed-url",
      "/api/urls",
      "/api/submit",
      "/api/ingest",
      "/api/indexing/add",
      "/api/pages"
    ]
  ).filter(route => !/search|delete|remove|stats|status|health/i.test(route));

  const payloads = [
    { url },
    { targetUrl: url },
    { urls: [url] },
    { url, source: "Nexora Browser" }
  ];

  let lastError = "Aucune route d'indexation compatible n'a rÃ©pondu.";
  let lastEndpoint = "";

  for (const route of routes) {
    const endpoint = normalized.base + route;
    lastEndpoint = endpoint;

    for (const payload of payloads) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/plain"
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(7000)
        });

        const data = await nxReadResponse(response);

        if (response.status === 404 || response.status === 405) {
          break;
        }

        if (response.status === 400 || response.status === 422) {
          lastError = String(
            data && (data.error || data.message)
              ? data.error || data.message
              : "Cette route a rejetÃ© le format envoyÃ©."
          );
          continue;
        }

        if (response.status === 401 || response.status === 403) {
          return {
            ok: false,
            endpoint,
            message: "La route d'indexation exige une authentification ou des droits supplÃ©mentaires."
          };
        }

        if (response.ok) {
          if (data && (data.ok === false || data.success === false)) {
            lastError = String(data.message || data.error || "Le serveur a refusÃ© cette URL.");
            break;
          }

          return {
            ok: true,
            endpoint,
            url,
            message: String(
              data && (data.message || data.status)
                ? data.message || data.status
                : "Le serveur a acceptÃ© la demande. VÃ©rifie ensuite la liste des URL indexÃ©es."
            ),
            response: data
          };
        }

        lastError = "RÃ©ponse HTTP " + response.status + " depuis " + route;
        break;
      } catch (error) {
        lastError = error.message || lastError;
      }
    }
  }

  return {
    ok: false,
    endpoint: lastEndpoint,
    message:
      "Aucune route POST compatible n'a confirmÃ© l'indexation. " +
      lastError +
      " Consulte les routes dÃ©tectÃ©es dans le tableau de bord Nexora."
  };
}

async function nxIndexerList(rawBase) {
  const normalized = nxNormalizeBase(rawBase);

  if (!normalized.ok) return { ok: false, items: [], message: normalized.message };

  const routes = nxRoutePaths(
    "GET",
    /indexed|pages|urls|documents|sites|index|crawl/i,
    [
      "/api/indexed",
      "/api/urls",
      "/api/pages",
      "/api/indexed-urls",
      "/api/indexed-pages",
      "/api/documents",
      "/api/sites",
      "/api/index"
    ]
  ).filter(route => !/search|stats|health|status|config/i.test(route));

  for (const route of routes) {
    try {
      const response = await fetch(normalized.base + route, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(4500)
      });

      if (!response.ok) continue;

      const payload = await nxReadResponse(response);
      const array = nxFindArray(payload);

      if (array !== null) {
        return {
          ok: true,
          items: nxNormalizeItems(array) || [],
          endpoint: normalized.base + route,
          message: "Liste reÃ§ue du serveur."
        };
      }
    } catch (_) {}
  }

  return {
    ok: false,
    items: [],
    message:
      "Aucune route de liste reconnue n'a renvoyÃ© de tableau JSON. " +
      "VÃ©rifie les routes du serveur dans web/server-routes.json."
  };
}

async function nxIndexerSearch(rawBase, query) {
  const normalized = nxNormalizeBase(rawBase);

  if (!normalized.ok) {
    return { ok: false, results: [], message: normalized.message };
  }

  query = String(query || "").trim();

  if (!query) return { ok: true, results: [], message: "Entre un terme de recherche." };

  const routes = nxRoutePaths(
    "GET",
    /search|query|lookup/i,
    [
      "/api/search",
      "/search",
      "/api/index/search",
      "/api/indexed-search",
      "/api/indexed/search",
      "/api/v1/search"
    ]
  );

  for (const route of routes) {
    for (const key of ["q", "query"]) {
      try {
        const separator = route.includes("?") ? "&" : "?";
        const endpoint =
          normalized.base + route + separator +
          encodeURIComponent(key) + "=" + encodeURIComponent(query);

        const response = await fetch(endpoint, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(6000)
        });

        if (response.status === 404 || response.status === 405) break;
        if (!response.ok) continue;

        const payload = await nxReadResponse(response);
        const array = nxFindArray(payload);

        if (array !== null) {
          return {
            ok: true,
            results: nxNormalizeItems(array) || [],
            endpoint,
            message: "Recherche effectuÃ©e."
          };
        }
      } catch (_) {}
    }
  }

  return {
    ok: false,
    results: [],
    message:
      "L'API de recherche n'a pas renvoyÃ© de liste de rÃ©sultats JSON. " +
      "VÃ©rifie la route de recherche dÃ©finie dans ton serveur."
  };
}

function nxOpenIndexerWindow() {
  if (indexerWindow && !indexerWindow.isDestroyed()) {
    indexerWindow.show();
    indexerWindow.focus();
    return;
  }

  indexerWindow = new BrowserWindow({
    width: 1300,
    height: 900,
    minWidth: 900,
    minHeight: 650,
    title: "Nexora Indexation",
    backgroundColor: "#09101d",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      partition: "persist:nexora-profile",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  indexerWindow.loadURL("http://127.0.0.1:3081/")
    .catch(error => {
      console.error("Impossible d'ouvrir le portail Nexora :", error);
    });

  indexerWindow.on("closed", () => {
    indexerWindow = null;
  });
}

ipcMain.handle("indexer:open-window", () => {
  nxOpenIndexerWindow();
  return true;
});

ipcMain.handle("indexer:status", (_event, base) => nxIndexerStatus(base));

ipcMain.handle("indexer:add-url", (_event, base, url) => {
  return nxIndexerAddURL(base, url);
});

ipcMain.handle("indexer:list", (_event, base) => nxIndexerList(base));

ipcMain.handle("indexer:search", (_event, base, query) => {
  return nxIndexerSearch(base, query);
});

ipcMain.handle("indexer:open-url", async (_event, rawURL) => {
  const url = safeExternalURL(String(rawURL || ""));

  if (!url) return { ok: false, message: "Adresse invalide." };

  if (mainWindow && !mainWindow.isDestroyed() && typeof openTab === "function") {
    openTab(url, true, false);
    mainWindow.focus();
    return { ok: true };
  }

  await shell.openExternal(url);
  return { ok: true };
});

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
          notify("TÃƒÆ’Ã‚Â©lÃƒÆ’Ã‚Â©chargement presque terminÃƒÆ’Ã‚Â© : " + filename);
        }
      }
    });

    item.once("done", (_event, state) => {
      if (state === "completed") {
        notify("TÃƒÆ’Ã‚Â©lÃƒÆ’Ã‚Â©chargement terminÃƒÆ’Ã‚Â© : " + filename);
      } else {
        notify("TÃƒÆ’Ã‚Â©lÃƒÆ’Ã‚Â©chargement interrompu : " + filename);
      }
    });
  });

  shieldsEnabled = store.shieldsEnabled !== false;
  applyShields();

  for (const extensionPath of store.extensionPaths || []) {
    try {
      if (fs.existsSync(path.join(extensionPath, "manifest.json"))) {
        browserSession.extensions.loadExtension(extensionPath, { allowFileAccess: false }).catch(error => console.warn("Extension ignorée :", extensionPath, error.message));
      }
    } catch (error) {
      console.warn("Extension ignorÃƒÂ©e au dÃƒÂ©marrage :", extensionPath, error.message);
    }
  }

  await nexoraPortal.start({
    dataDir: app.getPath("userData"),
    dev: !app.isPackaged,
    projectDir: __dirname
  });
  createWindow();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    shieldsEnabled = store.shieldsEnabled !== false;
  applyShields();

  for (const extensionPath of store.extensionPaths || []) {
    try {
      if (fs.existsSync(path.join(extensionPath, "manifest.json"))) {
        browserSession.extensions.loadExtension(extensionPath, { allowFileAccess: false }).catch(error => console.warn("Extension ignorée :", extensionPath, error.message));
      }
    } catch (error) {
      console.warn("Extension ignorÃƒÂ©e au dÃƒÂ©marrage :", extensionPath, error.message);
    }
  }

  createWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});