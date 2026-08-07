import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useCSSVariable, useUniwind } from "uniwind";

import { resolveMobileRouteSet } from "../navigation.ts";
import { useProductCloudState } from "../product-cloud/ProductCloudProvider.tsx";
import { AuthRouteScreen, BootstrapRouteScreen } from "../screens/AccessScreens.tsx";
import { NoteScreen } from "../screens/NoteScreen.tsx";
import { ProjectScreen } from "../screens/ProjectScreen.tsx";
import { ArtifactScreen, ThreadScreen } from "../screens/ReadOnlyEntityScreens.tsx";
import { WorkspaceScreen } from "../screens/WorkspaceScreen.tsx";
import { mobileLinking, type RootStack } from "./routes.ts";

const Stack = createNativeStackNavigator<RootStack>();

export const RootNavigator = () => {
  const cloud = useProductCloudState();
  const { theme } = useUniwind();
  const resolvedBackground = useCSSVariable("--color-background");
  const resolvedForeground = useCSSVariable("--color-foreground");
  const backgroundColor = typeof resolvedBackground === "string" ? resolvedBackground : "#ffffff";
  const foregroundColor = typeof resolvedForeground === "string" ? resolvedForeground : "#18181b";
  const routeSet = resolveMobileRouteSet({
    authenticated: cloud.view.authenticatedUserId !== null,
    organizationSelected: cloud.view.scope !== null,
    phase: cloud.view.phase,
  });
  return (
    <NavigationContainer
      linking={mobileLinking}
      theme={theme === "dark" ? DarkTheme : DefaultTheme}
    >
      <Stack.Navigator
        screenOptions={{
          contentStyle: { backgroundColor },
          headerTintColor: foregroundColor,
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
        ) : (
          <Stack.Group navigationKey="product">
            <Stack.Screen
              component={WorkspaceScreen}
              name="Workspace"
              options={{ headerTransparent: true, title: "Workspace" }}
            />
            <Stack.Screen
              component={ProjectScreen}
              name="Project"
              options={{ headerTransparent: true }}
            />
            <Stack.Screen component={ThreadScreen} name="Thread" />
            <Stack.Screen component={ArtifactScreen} name="Artifact" />
            <Stack.Screen
              component={NoteScreen}
              name="Note"
              options={{ headerBackButtonMenuEnabled: false, headerTransparent: true }}
            />
          </Stack.Group>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
};
