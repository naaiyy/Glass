import { KeyboardProvider } from "react-native-keyboard-controller";

import { RootNavigator } from "./navigation/RootNavigator.tsx";
import { ProductCloudProvider } from "./product-cloud/ProductCloudProvider.tsx";

export const App = () => (
  <KeyboardProvider>
    <ProductCloudProvider>
      <RootNavigator />
    </ProductCloudProvider>
  </KeyboardProvider>
);
