import { app, BrowserWindow } from "electron";
import path from "node:path";

const desktopDirectory = __dirname;
const sharedRendererProject = "../../web/dist/index.html";
const isSmokeTest = process.argv.includes("--glass-smoke-test");

const createWindow = async (): Promise<BrowserWindow> => {
  const window = new BrowserWindow({
    height: 820,
    minHeight: 600,
    minWidth: 800,
    show: false,
    title: "Glass",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(desktopDirectory, "preload.cjs"),
      sandbox: true,
    },
    width: 1280,
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  if (!isSmokeTest) {
    window.once("ready-to-show", () => window.show());
  }

  const developmentUrl = process.env.GLASS_WEB_DEV_SERVER_URL;
  if (developmentUrl === undefined) {
    const rendererPath = path.resolve(desktopDirectory, sharedRendererProject);
    await window.loadFile(rendererPath);
  } else {
    await window.loadURL(developmentUrl);
  }

  return window;
};

const run = async (): Promise<void> => {
  await app.whenReady();
  const initialWindow = await createWindow();

  if (isSmokeTest) {
    const bridgeAvailable = await initialWindow.webContents.executeJavaScript(
      "Boolean(window.glassDesktop)",
    );
    const rendererContentAvailable = await initialWindow.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const hasContent = () => document.body.textContent?.includes(
          "Your product stays available when execution disconnects.",
        ) === true;
        if (hasContent()) {
          resolve(true);
          return;
        }
        const observer = new MutationObserver(() => {
          if (hasContent()) {
            observer.disconnect();
            resolve(true);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => {
          observer.disconnect();
          resolve(false);
        }, 5_000);
      })
    `);
    process.stdout.write(
      `${JSON.stringify({
        bridgeAvailable,
        rendererContentAvailable,
        rendererUrl: initialWindow.webContents.getURL(),
        status: "ready",
        windows: BrowserWindow.getAllWindows().length,
      })}\n`,
    );
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
};

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
