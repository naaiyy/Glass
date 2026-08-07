import { useState } from "react";
import { GithubIcon } from "@hugeicons/core-free-icons";
import { ScrollView, Text, View } from "react-native";

import { errorMessage } from "../lib/errors.ts";
import { useMobileCloud } from "../product-cloud/ProductCloudProvider.tsx";
import { ActionButton, CenteredLoadingState, StateCard } from "../ui/primitives.tsx";

export const AuthRouteScreen = () => {
  const cloud = useMobileCloud();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="flex-grow justify-center px-5 pb-16"
    >
      <View className="w-full max-w-sm self-center">
        <Text className="text-2xl font-semibold tracking-tight text-foreground">
          Welcome to Glass
        </Text>
        <ActionButton
          disabled={pending}
          icon={GithubIcon}
          label={pending ? "Opening GitHub…" : "Continue with GitHub"}
          onPress={() => {
            setPending(true);
            setError(null);
            void cloud
              .signIn()
              .catch((cause: unknown) => setError(errorMessage(cause)))
              .finally(() => setPending(false));
          }}
        />
        {error === null ? null : <Text className="mt-3 text-sm text-destructive">{error}</Text>}
      </View>
    </ScrollView>
  );
};

export const BootstrapRouteScreen = () => {
  const { retry, view } = useMobileCloud();
  if (view.phase === "checking-session") {
    return <CenteredLoadingState label="Opening your workspace…" />;
  }
  const title =
    view.phase === "configuration-required"
      ? "Cloud configuration required"
      : view.phase === "offline"
        ? "Glass Cloud is unavailable"
        : "Opening your workspace";
  return (
    <View className="flex-1 bg-background px-5 pt-6">
      <StateCard title={title}>
        {view.error === null ? null : (
          <Text className="text-[15px] leading-6 text-foreground">{view.error}</Text>
        )}
        {view.phase === "configuration-required" ? (
          <Text className="text-sm leading-5 text-muted-foreground">
            Set EXPO_PUBLIC_GLASS_API_URL to the Glass Cloud API origin.
          </Text>
        ) : null}
        {view.phase === "offline" ? <ActionButton label="Reconnect" onPress={retry} /> : null}
      </StateCard>
    </View>
  );
};
