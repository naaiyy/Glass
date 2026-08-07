import { useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, View } from "react-native";

import { errorMessage } from "../lib/errors.ts";
import { useMobileCloud } from "../product-cloud/ProductCloudProvider.tsx";
import { ActionButton, StateCard } from "../ui/primitives.tsx";
import { styles } from "../ui/styles.ts";

export const AuthRouteScreen = () => {
  const cloud = useMobileCloud();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.detailTitle}>Welcome to Glass</Text>
      <Text style={styles.body}>Sign in with GitHub to continue.</Text>
      <ActionButton
        disabled={pending}
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
      {error === null ? null : <Text style={styles.error}>{error}</Text>}
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
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.detailTitle}>Your organizations</Text>
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
        <Text style={styles.error}>{cloud.organizationsError}</Text>
      )}
      {attention.length === 0 ? null : (
        <StateCard title="Outbox needs attention">
          {attention.map((item) => (
            <View key={item.mutation.commandId} style={styles.attentionItem}>
              <Text style={styles.error}>{item.attention?.message}</Text>
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
      <TextInput
        onChangeText={setName}
        placeholder="New organization name"
        placeholderTextColor="#71817a"
        style={styles.input}
        value={name}
      />
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
      {error === null ? null : <Text style={styles.error}>{error}</Text>}
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
    <View style={styles.screen}>
      <StateCard title={title}>
        {view.phase === "checking-session" ? <ActivityIndicator color="#8de0bd" /> : null}
        {view.error === null ? null : <Text style={styles.body}>{view.error}</Text>}
        {view.phase === "configuration-required" ? (
          <Text style={styles.muted}>
            Set EXPO_PUBLIC_GLASS_API_URL to the Glass Cloud API origin.
          </Text>
        ) : null}
        {view.phase === "offline" ? <ActionButton label="Reconnect" onPress={retry} /> : null}
      </StateCard>
    </View>
  );
};
