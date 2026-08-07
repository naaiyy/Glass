import { Outlet, createRootRoute } from "@tanstack/react-router";

import { ProductCloudProvider } from "../product-cloud/ProductCloudProvider.tsx";
import { ProductRouteCoordinator } from "../product-cloud/ProductScreens.tsx";

const RootRoute = () => (
  <ProductCloudProvider>
    <ProductRouteCoordinator />
    <Outlet />
  </ProductCloudProvider>
);

export const Route = createRootRoute({
  component: RootRoute,
});
