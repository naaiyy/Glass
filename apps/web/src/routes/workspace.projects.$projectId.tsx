import { createFileRoute } from "@tanstack/react-router";

import { ProjectProductScreen } from "../product-cloud/ProductScreens.tsx";

export const Route = createFileRoute("/workspace/projects/$projectId")({
  component: ProjectProductScreen,
});
