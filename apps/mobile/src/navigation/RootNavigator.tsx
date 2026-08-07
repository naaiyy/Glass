import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import { resolveMobileRouteSet } from "../navigation.ts";
import { useProductCloudState } from "../product-cloud/ProductCloudProvider.tsx";
import {
  AuthRouteScreen,
  BootstrapRouteScreen,
  OrganizationsRouteScreen,
} from "../screens/AccessScreens.tsx";
import { NoteScreen } from "../screens/NoteScreen.tsx";
import { ProjectScreen } from "../screens/ProjectScreen.tsx";
import { ArtifactScreen, ThreadScreen } from "../screens/ReadOnlyEntityScreens.tsx";
import { WorkspaceScreen } from "../screens/WorkspaceScreen.tsx";
import { styles } from "../ui/styles.ts";
import { mobileLinking, type RootStack } from "./routes.ts";

const Stack = createNativeStackNavigator<RootStack>();

export const RootNavigator = () => {
  const cloud = useProductCloudState();
  const routeSet = resolveMobileRouteSet({
    authenticated: cloud.view.authenticatedUserId !== null,
    organizationSelected: cloud.view.scope !== null,
    phase: cloud.view.phase,
  });
  return (
    <NavigationContainer linking={mobileLinking}>
      <Stack.Navigator
        screenOptions={{
          contentStyle: styles.navigation,
          headerStyle: styles.navigation,
          headerTintColor: "#fafafa",
        }}
      >
        {routeSet === "bootstrap" ? (
          <Stack.Screen
            component={BootstrapRouteScreen}
            name="Bootstrap"
            options={{ headerShown: false }}
          />
        ) : routeSet === "auth" ? (
          <Stack.Screen component={AuthRouteScreen} name="Auth" options={{ headerShown: false }} />
        ) : routeSet === "organizations" ? (
          <Stack.Screen
            component={OrganizationsRouteScreen}
            name="Organizations"
            options={{ headerShown: false }}
          />
        ) : (
          <Stack.Group navigationKey="product">
            <Stack.Screen
              component={WorkspaceScreen}
              name="Workspace"
              options={{ headerShown: false }}
            />
            <Stack.Screen component={ProjectScreen} name="Project" />
            <Stack.Screen component={ThreadScreen} name="Thread" />
            <Stack.Screen component={ArtifactScreen} name="Artifact" />
            <Stack.Screen component={NoteScreen} name="Note" />
          </Stack.Group>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
};
