const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1450,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Nexora Browser",
    backgroundColor: "#0b1020",
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.loadFile(path.join(__dirname, "index.html"));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "Nexora",
      submenu: [
        { label: "Recharger l'interface", role: "reload" },
        { type: "separator" },
        { label: "Quitter", role: "quit" }
      ]
    },
    {
      label: "Navigation",
      submenu: [
        { label: "Nouvel onglet", accelerator: "Ctrl+T",
          click: () => win.webContents.send("new-tab") },
        { label: "Fermer l'onglet", accelerator: "Ctrl+W",
          click: () => win.webContents.send("close-tab") },
        { label: "Plein écran", role: "togglefullscreen" }
      ]
    },
    {
      label: "Affichage",
      submenu: [
        { label: "Zoom avant", role: "zoomIn" },
        { label: "Zoom arrière", role: "zoomOut" },
        { label: "Zoom normal", role: "resetZoom" },
        { label: "Outils de développement", role: "toggleDevTools" }
      ]
    }
  ]));

  win.on("closed", () => { win = null; });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
