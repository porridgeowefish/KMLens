const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const SUPPORTED_EXTENSIONS = new Set([".kml", ".gpx"]);
let mainWindow = null;
let pendingPaths = [];

function geoFilePaths(args) {
  return args
    .map((arg) => String(arg).replace(/^"(.*)"$/, "$1"))
    .filter((arg) => SUPPORTED_EXTENSIONS.has(path.extname(arg).toLowerCase()))
    .filter((arg) => {
      try {
        return fs.statSync(arg).isFile();
      } catch {
        return false;
      }
    });
}

function readGeoFiles(paths) {
  return paths.flatMap((filePath) => {
    try {
      const stat = fs.statSync(filePath);
      return [{
        name: path.basename(filePath),
        size: stat.size,
        text: fs.readFileSync(filePath, "utf8"),
      }];
    } catch {
      return [];
    }
  });
}

function sendFiles(paths) {
  const files = readGeoFiles(paths);
  if (files.length && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("fieldnote:open-files", files);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

const initialPaths = geoFilePaths(process.argv.slice(1));
pendingPaths.push(...initialPaths);

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    const paths = geoFilePaths(commandLine);
    if (paths.length) sendFiles(paths);
    else if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    if (mainWindow) sendFiles([filePath]);
    else pendingPaths.push(filePath);
  });

  app.whenReady().then(() => {
    app.setAppUserModelId("io.github.porridgeowefish.kmlens");
    Menu.setApplicationMenu(null);

    ipcMain.handle("fieldnote:pick-files", async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: "打开 KML / GPX 文件",
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "地理文件", extensions: ["kml", "gpx"] },
          { name: "KML 文件", extensions: ["kml"] },
          { name: "GPX 文件", extensions: ["gpx"] },
        ],
      });
      return result.canceled ? [] : readGeoFiles(result.filePaths);
    });

    ipcMain.handle("fieldnote:consume-pending-files", () => {
      const files = readGeoFiles(pendingPaths);
      pendingPaths = [];
      return files;
    });

    mainWindow = new BrowserWindow({
      width: 1360,
      height: 860,
      minWidth: 900,
      minHeight: 620,
      backgroundColor: "#f7f4ec",
      show: false,
      autoHideMenuBar: true,
      icon: path.join(__dirname, "..", "build-resources", "icon.ico"),
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    mainWindow.once("ready-to-show", () => mainWindow.show());
    mainWindow.loadFile(path.join(__dirname, "..", "desktop-dist", "index.html"));

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://") || url.startsWith("http://")) shell.openExternal(url);
      return { action: "deny" };
    });

    mainWindow.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith("file://")) event.preventDefault();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
