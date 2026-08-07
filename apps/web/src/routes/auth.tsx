import { createFileRoute } from "@tanstack/react-router";

import { AuthProductScreen } from "../product-cloud/ProductScreens.tsx";

export const Route = createFileRoute("/auth")({
  component: AuthProductScreen,
});
