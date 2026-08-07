import { RootNavigator } from "./navigation/RootNavigator.tsx";
import { KeyboardContextProvider } from "./providers/KeyboardContextProvider.tsx";
import { ProductCloudProvider } from "./product-cloud/ProductCloudProvider.tsx";
import { EnvironmentScopeProvider } from "./providers/EnvironmentScopeProvider.tsx";

export const App = () => (
  <KeyboardContextProvider>
    <ProductCloudProvider>
      <EnvironmentScopeProvider>
        <RootNavigator />
      </EnvironmentScopeProvider>
    </ProductCloudProvider>
  </KeyboardContextProvider>
);
