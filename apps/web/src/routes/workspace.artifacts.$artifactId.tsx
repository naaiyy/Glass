import { createFileRoute } from "@tanstack/react-router";

import { ArtifactProductScreen } from "../product-cloud/ProductScreens.tsx";

export const Route = createFileRoute("/workspace/artifacts/$artifactId")({
  component: ArtifactProductScreen,
});
