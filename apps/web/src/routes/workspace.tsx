import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceProductLayout } from "../product-cloud/ProductScreens.tsx";

export const Route = createFileRoute("/workspace")({
  component: WorkspaceProductLayout,
});
