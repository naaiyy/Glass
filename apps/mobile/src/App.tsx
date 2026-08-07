import { RootNavigator } from "./navigation/RootNavigator.tsx";
import { ProductCloudProvider } from "./product-cloud/ProductCloudProvider.tsx";

export const App = () => (
  <ProductCloudProvider>
    <RootNavigator />
  </ProductCloudProvider>
);
