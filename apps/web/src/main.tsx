import { FoundationShell } from "@glass/ui-web/foundation-shell";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ProductCore } from "./product-cloud/ProductCore.tsx";
import "@openeditor/ui/styles.css";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");

if (root === null) {
  throw new Error("Glass renderer root is missing");
}

const surface = window.glassDesktop === undefined ? "web" : "desktop";

createRoot(root).render(
  <StrictMode>
    <FoundationShell surface={surface}>
      <ProductCore />
    </FoundationShell>
  </StrictMode>,
);
