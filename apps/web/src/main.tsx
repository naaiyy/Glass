import { initialConnectionState } from "@glass/client-runtime/connections";
import { FoundationShell } from "@glass/ui-web/foundation-shell";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");

if (root === null) {
  throw new Error("Glass renderer root is missing");
}

const connections = initialConnectionState();
const surface = window.glassDesktop === undefined ? "web" : "desktop";

createRoot(root).render(
  <StrictMode>
    <FoundationShell surface={surface}>
      <section className="connection-card" aria-label="Foundation connection boundaries">
        <div>
          <span>Product connection</span>
          <strong>{connections.product.status}</strong>
        </div>
        <div>
          <span>Execution connection</span>
          <strong>{connections.execution.status}</strong>
        </div>
      </section>
    </FoundationShell>
  </StrictMode>,
);
