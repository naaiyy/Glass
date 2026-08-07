import type { ReactNode } from "react";

import { EnvironmentDirectoryProvider } from "../execution/EnvironmentDirectoryProvider.tsx";
import { useProductCloudState } from "../product-cloud/ProductCloudProvider.tsx";

export const EnvironmentScopeProvider = ({ children }: Readonly<{ children: ReactNode }>) => {
  const cloud = useProductCloudState();
  return (
    <EnvironmentDirectoryProvider organizationId={cloud.view.scope?.organizationId ?? null}>
      {children}
    </EnvironmentDirectoryProvider>
  );
};
