import React from "react";
import ReactDOM from "react-dom/client";
import Home from "../app/page";
import "../app/globals.css";

const wailsApp = window.go?.main?.App;
if (!window.fieldnote && wailsApp) {
  window.fieldnote = {
    isDesktop: true,
    pickGeoFiles: () => wailsApp.PickGeoFiles(),
    onOpenFiles: (callback) => {
      const cancel = window.runtime?.EventsOn?.("fieldnote:open-files", (...data) => {
        const files = data[0] as FieldnoteFile[] | undefined;
        if (files?.length) callback(files);
      }) ?? (() => undefined);
      wailsApp.ConsumePendingFiles().then((files) => {
        if (files?.length) callback(files);
      });
      return cancel;
    },
    appVersion: () => wailsApp.AppVersion(),
    checkForUpdates: (manual) => wailsApp.CheckForUpdates(manual),
    installUpdate: () => wailsApp.InstallUpdate(),
    onUpdateStatus: (callback) => (
      window.runtime?.EventsOn?.("fieldnote:update-status", (...data) => {
        const status = data[0] as FieldnoteUpdateStatus | undefined;
        if (status) callback(status);
      }) ?? (() => undefined)
    ),
  };
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Home />
  </React.StrictMode>,
);
