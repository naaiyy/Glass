import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceProductScreen } from "../product-cloud/ProductScreens.tsx";

export const Route = createFileRoute("/workspace/")({
  component: WorkspaceProductScreen,
});
