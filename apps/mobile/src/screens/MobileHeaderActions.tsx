import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Pressable, Text, View } from "react-native";
import { useCSSVariable } from "uniwind";

import { useEnvironmentDirectory } from "../execution/EnvironmentDirectoryProvider.tsx";
import type { RootStack } from "../navigation/routes.ts";
import { useMobileCloud } from "../product-cloud/ProductCloudProvider.tsx";

export const MobileHeaderActions = () => {
  const directory = useEnvironmentDirectory();
  const { signOut } = useMobileCloud();
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  const resolvedForeground = useCSSVariable("--color-foreground");
  const iconColor = typeof resolvedForeground === "string" ? resolvedForeground : "#18181b";
  const active = directory.environments.filter((environment) => environment.revokedAt === null);
  const online = active.filter(
    (environment) => directory.presence[environment.id]?.status === "online",
  ).length;
  const status = active.length === 0 ? "No computers" : online > 0 ? `${online} online` : "Offline";
  return (
    <View className="flex-row items-center gap-3">
      <Pressable
        accessibilityRole="button"
        className="flex-row items-center gap-1.5"
        onPress={() => navigation.navigate("Environments")}
      >
        <View
          className={
            online > 0
              ? "size-2 rounded-full bg-emerald-500"
              : "size-2 rounded-full bg-muted-foreground"
          }
        />
        <Text className="text-xs font-medium text-foreground">{status}</Text>
      </Pressable>
      <Pressable
        accessibilityLabel="Settings"
        accessibilityRole="button"
        className="p-1"
        onPress={() => navigation.navigate("Environments")}
      >
        <HugeiconsIcon color={iconColor} icon={Settings01Icon} size={17} strokeWidth={2} />
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => void signOut()}>
        <Text className="text-xs font-medium text-foreground">Sign out</Text>
      </Pressable>
    </View>
  );
};
