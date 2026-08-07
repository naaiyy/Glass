import { createFileRoute } from "@tanstack/react-router";

import { EnvironmentSettingsScreen } from "../product-cloud/ProductScreens.tsx";

export const Route = createFileRoute("/workspace/settings/environments")({
  component: EnvironmentSettingsScreen,
});
