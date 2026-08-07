import { useState } from "react";
import { GithubIcon } from "@hugeicons/core-free-icons";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";

import { errorMessage } from "../lib/errors.ts";
import { useMobileCloud } from "../product-cloud/ProductCloudProvider.tsx";
import { ActionButton, AppInput, StateCard } from "../ui/primitives.tsx";

export const AuthRouteScreen = () => {
  const cloud = useMobileCloud();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="flex-grow justify-center px-5 pb-16"
    >
      <View className="rounded-xl border border-border bg-card p-5">
        <Text className="text-2xl font-semibold tracking-tight text-foreground">
          Welcome to Glass
        </Text>
        <Text className="mt-2 text-[15px] leading-6 text-muted-foreground">
          Sign in to continue to your organizations and cloud workspace.
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

export const OrganizationsRouteScreen = () => {
  const cloud = useMobileCloud();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const attention = cloud.outbox.filter((item) => item.status === "needs-attention");
  const userId = cloud.view.authenticatedUserId;
  if (userId === null) return null;
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="flex-grow px-5 pb-16 pt-6"
    >
      <Text className="mb-3 text-3xl font-semibold tracking-tight text-foreground">
        Your organizations
      </Text>
      {cloud.organizations.map((item) => (
        <ActionButton
          key={item.organization.id}
          label={`${item.organization.name} · ${item.membership.role}`}
          onPress={() => void cloud.selectOrganization(userId, item.organization.id)}
        />
      ))}
      {cloud.organizationsCursor === null ? null : (
        <ActionButton
          label="Load more organizations"
          onPress={() => void cloud.loadMoreOrganizations()}
        />
      )}
      {cloud.organizationsError === null ? null : (
        <Text className="mt-2 text-sm text-destructive">{cloud.organizationsError}</Text>
      )}
      {attention.length === 0 ? null : (
        <StateCard title="Outbox needs attention">
          {attention.map((item) => (
            <View className="mt-3 border-t border-border pt-3" key={item.mutation.commandId}>
              <Text className="text-sm text-destructive">{item.attention?.message}</Text>
              {item.attention?.code === "forbidden" || item.attention?.code === "not-found" ? (
                <ActionButton
                  label="Retry after access changes"
                  onPress={() => void cloud.retryOutboxItem(item.mutation.commandId)}
                />
              ) : null}
              <ActionButton
                label="Discard command"
                onPress={() => void cloud.discardOutboxItem(item.mutation.commandId)}
              />
            </View>
          ))}
        </StateCard>
      )}
      <AppInput onChangeText={setName} placeholder="New organization name" value={name} />
      <ActionButton
        disabled={creating}
        label={creating ? "Creating…" : "Create organization"}
        onPress={() => {
          if (name.trim().length === 0) {
            setError("Enter an organization name.");
            return;
          }
          setCreating(true);
          void cloud
            .bootstrapOrganization(name.trim())
            .catch((cause: unknown) => setError(errorMessage(cause)))
            .finally(() => setCreating(false));
        }}
      />
      {error === null ? null : <Text className="mt-2 text-sm text-destructive">{error}</Text>}
      <ActionButton label="Sign out" onPress={() => void cloud.signOut()} />
    </ScrollView>
  );
};

export const BootstrapRouteScreen = () => {
  const { retry, view } = useMobileCloud();
  const title =
    view.phase === "configuration-required"
      ? "Cloud configuration required"
      : view.phase === "offline"
        ? "Glass Cloud is unavailable"
        : "Opening Glass";
  return (
    <View className="flex-1 bg-background px-5 pt-6">
      <StateCard title={title}>
        {view.phase === "checking-session" ? <ActivityIndicator /> : null}
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
