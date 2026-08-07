import { RootNavigator } from "./navigation/RootNavigator.tsx";
import { KeyboardContextProvider } from "./providers/KeyboardContextProvider.tsx";
import { ProductCloudProvider } from "./product-cloud/ProductCloudProvider.tsx";

export const App = () => (
  <KeyboardContextProvider>
    <ProductCloudProvider>
      <RootNavigator />
    </ProductCloudProvider>
  </KeyboardContextProvider>
);
