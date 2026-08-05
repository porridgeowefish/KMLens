const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fieldnote", {
  isDesktop: true,
  pickGeoFiles: () => ipcRenderer.invoke("fieldnote:pick-files"),
  onOpenFiles: (callback) => {
    const listener = (_event, files) => callback(files);
    ipcRenderer.on("fieldnote:open-files", listener);
    ipcRenderer.invoke("fieldnote:consume-pending-files").then((files) => {
      if (files?.length) callback(files);
    });
    return () => ipcRenderer.removeListener("fieldnote:open-files", listener);
  },
});
