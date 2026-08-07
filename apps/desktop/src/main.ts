import { electronClient } from "@better-auth/electron/client";
import type { DesktopProductRequest } from "@glass/contracts/architecture";
import type { BetterAuthClientOptions } from "better-auth";
import { createAuthClient } from "better-auth/client";
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";

import glassCloudConfig from "../../../config/glass-cloud.json" with { type: "json" };
import { createDesktopAuthStorage } from "./auth-storage.ts";
import { setupDesktopAuthMain, type DesktopAuthMainClient } from "./auth-main.ts";

const desktopDirectory = __dirname;
const sharedRendererProject = "../../web/dist/index.html";
const isSmokeTest = process.argv.includes("--glass-smoke-test");
const defaultProductCloudOrigin = glassCloudConfig.origins.production;

const resolveProductCloudOrigin = (input: string | undefined): string => {
  const value = input?.trim() || defaultProductCloudOrigin;
  const url = new URL(value);
  const localDevelopment =
    url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !localDevelopment) ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("GLASS_CLOUD_ORIGIN must be an HTTPS origin or a local development origin.");
  }
  return url.origin;
};

const productCloudOrigin = resolveProductCloudOrigin(process.env.GLASS_CLOUD_ORIGIN);
process.env.GLASS_CLOUD_ORIGIN = productCloudOrigin;

const electronAuthPlugin = electronClient({
  clientID: "glass-desktop",
  protocol: { scheme: "dev.glass.desktop" },
  signInURL: `${productCloudOrigin}/`,
  storage: createDesktopAuthStorage(),
});

// The integration's runtime and Better Auth versions are pinned together. Their published
// RequestCache declarations differ under Electron's DOM library, so the cast is isolated here.
const authClient = createAuthClient({
  baseURL: productCloudOrigin,
  plugins: [electronAuthPlugin] as unknown as BetterAuthClientOptions["plugins"],
}) as unknown as DesktopAuthMainClient;

let primaryWindow: BrowserWindow | null = null;

setupDesktopAuthMain(authClient, () => primaryWindow);

const maximumDesktopProductBodyBytes = 6 * 1024 * 1024;
const allowedProductRequest = (input: unknown): input is DesktopProductRequest => {
  if (typeof input !== "object" || input === null) return false;
  const value = input as Record<string, unknown>;
  if (
    typeof value.path !== "string" ||
    !value.path.startsWith("/v1/") ||
    value.path.startsWith("//") ||
    !["DELETE", "GET", "POST", "PUT"].includes(String(value.method)) ||
    (value.body !== null && typeof value.body !== "string")
  ) {
    return false;
  }
  const method = value.method;
  const pathname = new URL(value.path, productCloudOrigin).pathname;
  const environmentMethod =
    pathname === "/v1/environment-pairings/approve" ||
    pathname === "/v1/environment-rotations/approve" ||
    pathname.endsWith("/connect-ticket")
      ? "POST"
      : pathname.endsWith("/workspace-catalog")
        ? "GET"
        : pathname.startsWith("/v1/environments/") && !pathname.endsWith("/presence")
          ? "DELETE"
          : pathname === "/v1/environments" || pathname.endsWith("/presence")
            ? "GET"
            : null;
  const executionMethod =
    pathname === "/v1/workspace-bindings"
      ? method === "GET"
        ? "GET"
        : "POST"
      : pathname === "/v1/execution-operations" ||
          pathname.endsWith("/cancel") ||
          pathname.endsWith("/dispatch")
        ? "POST"
        : pathname.startsWith("/v1/execution-operations/")
          ? "GET"
          : null;
  const expectedMethod =
    environmentMethod ??
    executionMethod ??
    (pathname === "/v1/sync/push"
      ? "POST"
      : pathname === "/v1/notes/content" && method === "PUT"
        ? "PUT"
        : "GET");
  return (
    method === expectedMethod &&
    (value.body === null ||
      new TextEncoder().encode(value.body).byteLength <= maximumDesktopProductBodyBytes)
  );
};

ipcMain.handle("glass:product-request", async (event, input: unknown) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow === null || !BrowserWindow.getAllWindows().includes(sourceWindow)) {
    throw new Error("The product request did not come from a Glass renderer.");
  }
  if (!allowedProductRequest(input))
    throw new Error("The product request is outside the desktop allowlist.");
  const response = await fetch(new URL(input.path, productCloudOrigin), {
    body: input.body,
    headers: {
      accept: "application/json",
      cookie: authClient.getCookie(),
      ...(input.body === null ? {} : { "content-type": "application/json" }),
    },
    method: input.method,
  });
  return {
    body: await response.text(),
    contentType: response.headers.get("content-type") ?? "application/json",
    status: response.status,
  };
});

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
  primaryWindow = window;

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
        const hasContent = () =>
          document.body.textContent?.includes("Checking the Glass Cloud session") === true ||
          document.body.textContent?.includes("Continue with GitHub") === true;
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
