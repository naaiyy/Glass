import type { BrowserWindow } from "electron";

export type DesktopAuthMainClient = Readonly<{
  getCookie: () => string;
  setupMain: (
    input: Readonly<{
      bridges: boolean;
      csp: boolean;
      getWindow: () => BrowserWindow | null;
      scheme: boolean;
    }>,
  ) => void;
}>;

export const setupDesktopAuthMain = (
  client: DesktopAuthMainClient,
  getWindow: () => BrowserWindow | null,
): void => {
  // Better Auth 1.6 treats a provided setup object as an explicit feature allowlist.
  // Passing getWindow alone therefore omits the IPC handlers used by the preload bridge.
  client.setupMain({ bridges: true, csp: true, getWindow, scheme: true });
};
