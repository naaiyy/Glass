import { createFileRoute } from "@tanstack/react-router";

import { OrganizationsProductScreen } from "../product-cloud/ProductScreens.tsx";

export const Route = createFileRoute("/organizations")({
  component: OrganizationsProductScreen,
});
