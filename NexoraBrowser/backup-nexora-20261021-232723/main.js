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
const TOOLBAR_HEIGHT = 126;
const HOME_BASE = pathToFileURL(path.join(__dirname, "home.html")).href;

const SEARCH_ENGINES = {
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
  defaultEngine: "Brave",
  bookmarks: [],
  history: []
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
          : "Brave",
        bookmarks: Array.isArray(saved.bookmarks) ? saved.bookmarks : [],
        history: Array.isArray(saved.history) ? saved.history : []
      };
    }
  } catch (error) {
    console.error("Impossible de lire les données Nexora :", error);
  }
}

function saveStore() {
  try {
    fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
    fs.writeFileSync(dataFile(), JSON.stringify(store, null, 2), "utf8");
  } catch (error) {
    console.error("Impossible de sauvegarder les données Nexora :", error);
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
  const url = wc.getURL() || tab.lastUrl || makeHomeURL();

  return {
    id: tab.id,
    title: wc.getTitle() || "Nouvel onglet",
    url,
    loading: Boolean(tab.loading),
    canGoBack: wc.canGoBack(),
    canGoForward: wc.canGoForward(),
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
        " — Nexora Browser"
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
    lastUrl: makeHomeURL()
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
    if (/^(javascript|data|vbscript):/i.test(url)) {
      event.preventDefault();
      return;
    }

    if (url.startsWith("file:") && !isHomeURL(url)) {
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
    recordHistory(url, wc.getTitle());
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
    notify("Un onglet a rencontré une erreur de rendu.");
  });

  wc.on("context-menu", (_event, params) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const menuItems = [
      {
        label: "Retour",
        enabled: wc.canGoBack(),
        click: () => wc.canGoBack() && wc.goBack()
      },
      {
        label: "Suivant",
        enabled: wc.canGoForward(),
        click: () => wc.canGoForward() && wc.goForward()
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
        label: "Rechercher la sélection avec " + store.defaultEngine,
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
      { label: "Tout sélectionner", role: "selectAll" }
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

function navigateCurrent(input) {
  const tab = getActiveTab();
  if (!tab) return;

  const target = resolveInput(input);

  tab.loading = true;
  tab.view.webContents.loadURL(target).catch(error => {
    tab.loading = false;
    console.error("Navigation impossible :", error);
    pushState();
    notify("La navigation a échoué.");
  });

  pushState();
}

function performAction(action) {
  const tab = getActiveTab();
  if (!tab) return;

  const wc = tab.view.webContents;

  switch (action) {
    case "back":
      if (wc.canGoBack()) wc.goBack();
      break;
    case "forward":
      if (wc.canGoForward()) wc.goForward();
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
    notify("La page d'accueil locale ne peut pas être ajoutée aux favoris.");
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
  notify("Page ajoutée aux favoris.");

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
    items.push({ label: "Aucun favori enregistré", enabled: false });
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
    items.push({ label: "Aucune page visitée", enabled: false });
  } else {
    store.history.slice(0, 30).forEach(entry => {
      const when = new Date(entry.time).toLocaleString("fr-FR");

      items.push({
        label: String(entry.title || entry.url).slice(0, 70) + " — " + when,
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
  notify("Historique effacé.");
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
      label: "Moteur de recherche par défaut",
      submenu: engineItems
    },
    { type: "separator" },
    { label: "Ouvrir l'accueil Nexora", click: () => performAction("home") },
    { label: "Effacer l'historique", click: () => clearHistory() },
    { label: "Ouvrir le dossier des téléchargements", click: () => openDownloads() },
    { type: "separator" },
    { label: "Zoom avant", click: () => performAction("zoom-in") },
    { label: "Zoom arrière", click: () => performAction("zoom-out") },
    { label: "Réinitialiser le zoom", click: () => performAction("zoom-reset") },
    { type: "separator" },
    { label: "À propos de Nexora Browser", click: () => showAbout() }
  ]).popup({ window: mainWindow });
}

function openDownloads() {
  shell.openPath(app.getPath("downloads")).then(errorMessage => {
    if (errorMessage) notify(errorMessage);
  });
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "À propos de Nexora Browser",
    message: "Nexora Browser 2.0.0",
    detail: "Un navigateur de bureau construit avec Electron et Chromium.\n\nLes cookies et sessions sont conservés localement. Les favoris et l'historique sont enregistrés dans le dossier de données de Nexora."
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
      label: "Édition",
      submenu: [
        { role: "undo", label: "Annuler" },
        { role: "redo", label: "Rétablir" },
        { type: "separator" },
        { role: "cut", label: "Couper" },
        { role: "copy", label: "Copier" },
        { role: "paste", label: "Coller" },
        { role: "selectAll", label: "Tout sélectionner" }
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
        { label: "Afficher les pages visitées", click: () => showHistoryMenu() },
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
        { label: "Zoom arrière", accelerator: "Ctrl+-", click: () => performAction("zoom-out") },
        { label: "Zoom normal", accelerator: "Ctrl+0", click: () => performAction("zoom-reset") },
        { type: "separator" },
        { role: "togglefullscreen", label: "Plein écran" }
      ]
    },
    {
      label: "Outils",
      submenu: [
        { label: "Téléchargements", accelerator: "Ctrl+J", click: () => openDownloads() },
        { label: "Paramètres", click: () => showSettingsMenu() }
      ]
    },
    {
      label: "Aide",
      submenu: [
        { label: "À propos de Nexora Browser", click: () => showAbout() }
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

ipcMain.handle("browser:set-engine", (_event, engine) => {
  setEngine(engine);
});

ipcMain.on("browser:show-bookmarks", () => showBookmarksMenu());
ipcMain.on("browser:show-history", () => showHistoryMenu());
ipcMain.on("browser:show-settings", () => showSettingsMenu());
ipcMain.on("browser:open-downloads", () => openDownloads());

app.whenReady().then(() => {
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
          notify("Téléchargement presque terminé : " + filename);
        }
      }
    });

    item.once("done", (_event, state) => {
      if (state === "completed") {
        notify("Téléchargement terminé : " + filename);
      } else {
        notify("Téléchargement interrompu : " + filename);
      }
    });
  });

  createWindow();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});