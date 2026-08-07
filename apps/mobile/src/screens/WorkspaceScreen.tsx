import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { ExecutionCard } from "../execution/ExecutionCard.tsx";
import { errorMessage } from "../lib/errors.ts";
import type { RootStack } from "../navigation/routes.ts";
import { useMobileCloud } from "../product-cloud/ProductCloudProvider.tsx";
import { ActionButton, StateCard } from "../ui/primitives.tsx";
import { styles } from "../ui/styles.ts";

export const WorkspaceScreen = ({ navigation }: NativeStackScreenProps<RootStack, "Workspace">) => {
  const { createProject, discardOutboxItem, outbox, retry, retryOutboxItem, signOut, view } =
    useMobileCloud();
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const attention = outbox.filter((item) => item.status === "needs-attention");
  const pending = outbox.length - attention.length;
  const snapshot = view.snapshot;
  const authenticatedUserId = view.authenticatedUserId;

  const runCloudAction = (action: Promise<void>) => {
    void action.catch((error: unknown) => setInputError(errorMessage(error)));
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.eyebrow}>GLASS · MOBILE</Text>
      <Text style={styles.title}>Your cloud workspace</Text>

      {view.phase === "configuration-required" ? (
        <StateCard title="Cloud configuration required">
          <Text style={styles.body}>{view.error}</Text>
          <Text style={styles.muted}>
            Set EXPO_PUBLIC_GLASS_API_URL to the Glass Cloud API origin.
          </Text>
        </StateCard>
      ) : null}

      {view.phase === "checking-session" ? (
        <StateCard title="Checking Glass Cloud session">
          <ActivityIndicator color="#8de0bd" />
        </StateCard>
      ) : null}

      {view.phase === "synchronizing" ? (
        <StateCard title="Synchronizing product state">
          <ActivityIndicator color="#8de0bd" />
          <Text style={styles.muted}>
            Cached records remain distinct from cloud-confirmed updates.
          </Text>
        </StateCard>
      ) : null}

      {view.phase === "offline" ? (
        <StateCard title="Product connection offline">
          <Text style={styles.body}>{view.error ?? "Glass Cloud is unreachable."}</Text>
          <Text style={styles.muted}>
            {snapshot === null
              ? "No validated cache is available."
              : "Showing the last validated device cache."}
          </Text>
          <ActionButton label="Reconnect" onPress={retry} />
        </StateCard>
      ) : null}

      {view.phase === "live" ? (
        <StateCard title="Product connection live">
          <Text style={styles.muted}>Your workspace is up to date.</Text>
        </StateCard>
      ) : null}

      {attention.length > 0 ? (
        <StateCard title="Outbox needs attention">
          {attention.map((item) => (
            <View key={item.mutation.commandId} style={styles.attentionItem}>
              <Text style={styles.error}>
                {item.mutation.operation.kind}: {item.attention?.message}
              </Text>
              {item.attention?.code === "forbidden" || item.attention?.code === "not-found" ? (
                <ActionButton
                  label="Retry after access changes"
                  onPress={() => runCloudAction(retryOutboxItem(item.mutation.commandId))}
                />
              ) : null}
              <ActionButton
                label="Discard command"
                onPress={() => runCloudAction(discardOutboxItem(item.mutation.commandId))}
              />
            </View>
          ))}
        </StateCard>
      ) : pending > 0 ? (
        <StateCard title="Outbox pending">
          <Text style={styles.body}>{pending} durable command(s) waiting for Glass Cloud.</Text>
        </StateCard>
      ) : null}

      <ExecutionCard
        organizationId={view.scope?.organizationId ?? null}
        projects={snapshot?.projects ?? []}
      />

      {authenticatedUserId === null ? null : (
        <ActionButton label="Sign out of Glass Cloud" onPress={() => runCloudAction(signOut())} />
      )}

      {snapshot === null ? null : (
        <>
          <View style={styles.summaryHeader}>
            <Text style={styles.sectionTitle}>{snapshot.organization.name}</Text>
          </View>
          <TextInput
            autoCorrect={false}
            maxLength={240}
            onChangeText={setProjectName}
            placeholder="New project name"
            placeholderTextColor="#71817a"
            style={styles.input}
            value={projectName}
          />
          <TextInput
            autoCorrect={false}
            maxLength={4000}
            onChangeText={setProjectDescription}
            placeholder="Project description (optional)"
            placeholderTextColor="#71817a"
            style={styles.input}
            value={projectDescription}
          />
          <ActionButton
            disabled={creating}
            label={creating ? "Creating…" : "Create project"}
            onPress={() => {
              const name = projectName.trim();
              if (name.length === 0) {
                setInputError("Enter a project name.");
                return;
              }
              setCreating(true);
              setInputError(null);
              void createProject(name, projectDescription.trim() || null)
                .then(() => {
                  setProjectName("");
                  setProjectDescription("");
                })
                .catch((error: unknown) => setInputError(errorMessage(error)))
                .finally(() => setCreating(false));
            }}
          />
          {inputError === null ? null : <Text style={styles.error}>{inputError}</Text>}
          {snapshot.projects.map((project) => (
            <Pressable
              accessibilityRole="button"
              key={project.id}
              onPress={() => navigation.navigate("Project", { projectId: project.id })}
              style={styles.listCard}
            >
              <Text style={styles.listTitle}>{project.name}</Text>
              <Text numberOfLines={2} style={styles.muted}>
                {project.description ?? "No description"}
              </Text>
            </Pressable>
          ))}
        </>
      )}
      <StatusBar />
    </ScrollView>
  );
};
