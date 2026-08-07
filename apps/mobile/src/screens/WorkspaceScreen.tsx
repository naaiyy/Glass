import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import { ExecutionCard } from "../execution/ExecutionCard.tsx";
import { errorMessage } from "../lib/errors.ts";
import type { RootStack } from "../navigation/routes.ts";
import { useMobileCloud } from "../product-cloud/ProductCloudProvider.tsx";
import { ActionButton, AppInput, StateCard } from "../ui/primitives.tsx";

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
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="flex-grow px-5 pb-16 pt-6"
    >
      <Text className="text-xs font-semibold tracking-widest text-muted-foreground">
        GLASS · MOBILE
      </Text>
      <Text className="mt-2 text-4xl font-semibold tracking-tight text-foreground">
        Your cloud workspace
      </Text>

      {view.phase === "configuration-required" ? (
        <StateCard title="Cloud configuration required">
          <Text className="text-[15px] leading-6 text-foreground">{view.error}</Text>
          <Text className="text-sm leading-5 text-muted-foreground">
            Set EXPO_PUBLIC_GLASS_API_URL to the Glass Cloud API origin.
          </Text>
        </StateCard>
      ) : null}

      {view.phase === "checking-session" ? (
        <StateCard title="Checking Glass Cloud session">
          <ActivityIndicator />
        </StateCard>
      ) : null}

      {view.phase === "synchronizing" ? (
        <StateCard title="Synchronizing product state">
          <ActivityIndicator />
          <Text className="text-sm leading-5 text-muted-foreground">
            Cached records remain distinct from cloud-confirmed updates.
          </Text>
        </StateCard>
      ) : null}

      {view.phase === "offline" ? (
        <StateCard title="Product connection offline">
          <Text className="text-[15px] leading-6 text-foreground">
            {view.error ?? "Glass Cloud is unreachable."}
          </Text>
          <Text className="text-sm leading-5 text-muted-foreground">
            {snapshot === null
              ? "No validated cache is available."
              : "Showing the last validated device cache."}
          </Text>
          <ActionButton label="Reconnect" onPress={retry} />
        </StateCard>
      ) : null}

      {attention.length > 0 ? (
        <StateCard title="Outbox needs attention">
          {attention.map((item) => (
            <View className="mt-3 border-t border-border pt-3" key={item.mutation.commandId}>
              <Text className="text-sm text-destructive">
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
          <Text className="text-[15px] leading-6 text-foreground">
            {pending} durable command(s) waiting for Glass Cloud.
          </Text>
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
          <View className="mt-7">
            <Text className="text-xl font-semibold text-foreground">
              {snapshot.organization.name}
            </Text>
          </View>
          <AppInput
            autoCorrect={false}
            maxLength={240}
            onChangeText={setProjectName}
            placeholder="New project name"
            value={projectName}
          />
          <AppInput
            autoCorrect={false}
            maxLength={4000}
            onChangeText={setProjectDescription}
            placeholder="Project description (optional)"
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
          {inputError === null ? null : (
            <Text className="mt-2 text-sm text-destructive">{inputError}</Text>
          )}
          {snapshot.projects.map((project) => (
            <Pressable
              accessibilityRole="button"
              key={project.id}
              onPress={() => navigation.navigate("Project", { projectId: project.id })}
              className="mt-2 rounded-xl border border-border bg-card p-4 active:bg-muted"
            >
              <Text className="text-base font-semibold text-card-foreground">{project.name}</Text>
              <Text className="mt-1 text-sm leading-5 text-muted-foreground" numberOfLines={2}>
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
