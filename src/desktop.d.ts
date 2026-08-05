export {};

declare global {
  interface FieldnoteFile {
    name: string;
    size: number;
    text: string;
  }

  interface FieldnoteUpdateStatus {
    state: "available" | "current" | "disabled" | "error";
    currentVersion: string;
    latestVersion?: string;
    notes?: string;
    message?: string;
  }

  interface Window {
    fieldnote?: {
      isDesktop: true;
      pickGeoFiles: () => Promise<FieldnoteFile[]>;
      onOpenFiles: (callback: (files: FieldnoteFile[]) => void) => () => void;
      appVersion?: () => Promise<string>;
      checkForUpdates?: (manual: boolean) => Promise<FieldnoteUpdateStatus>;
      installUpdate?: () => Promise<void>;
      onUpdateStatus?: (callback: (status: FieldnoteUpdateStatus) => void) => () => void;
    };
    go?: {
      main?: {
        App?: {
          PickGeoFiles: () => Promise<FieldnoteFile[]>;
          ConsumePendingFiles: () => Promise<FieldnoteFile[]>;
          AppVersion: () => Promise<string>;
          CheckForUpdates: (manual: boolean) => Promise<FieldnoteUpdateStatus>;
          InstallUpdate: () => Promise<void>;
        };
      };
    };
    runtime?: {
      EventsOn?: (eventName: string, callback: (...data: unknown[]) => void) => () => void;
    };
  }
}
