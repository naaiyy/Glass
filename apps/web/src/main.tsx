import { FoundationShell } from "@glass/ui-web/foundation-shell";
import { createHashHistory, createBrowserHistory, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { continueDesktopAuthentication } from "./auth-client.ts";
import { getRouter } from "./router.ts";
import "@openeditor/ui/styles.css";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");

if (root === null) {
  throw new Error("Glass renderer root is missing");
}

continueDesktopAuthentication();

const history = window.glassDesktop === undefined ? createBrowserHistory() : createHashHistory();
const router = getRouter(history);

createRoot(root).render(
  <StrictMode>
    <FoundationShell>
      <RouterProvider router={router} />
    </FoundationShell>
  </StrictMode>,
);
