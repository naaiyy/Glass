import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { errorMessage } from "../lib/errors.ts";
import type { RootStack } from "../navigation/routes.ts";
import { useMobileCloud } from "../product-cloud/ProductCloudProvider.tsx";
import {
  ActionButton,
  AppInput,
  CenteredLoadingState,
  SelectMenu,
  StateCard,
} from "../ui/primitives.tsx";

export const WorkspaceScreen = ({ navigation }: NativeStackScreenProps<RootStack, "Workspace">) => {
  const {
    bootstrapOrganization,
    createProject,
    discardOutboxItem,
    loadMoreOrganizations,
    organizations,
    organizationsCursor,
    organizationsError,
    outbox,
    retry,
    retryOutboxItem,
    selectOrganization,
    view,
  } = useMobileCloud();
  const [organizationName, setOrganizationName] = useState("");
  const [creatingOrganization, setCreatingOrganization] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [creating, setCreating] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const attention = outbox.filter((item) => item.status === "needs-attention");
  const pending = outbox.length - attention.length;
  const snapshot = view.snapshot;
  const authenticatedUserId = view.authenticatedUserId;

  const runCloudAction = (action: Promise<void>) => {
    void action.catch((error: unknown) => setInputError(errorMessage(error)));
  };

  if (view.phase === "checking-session" || view.phase === "synchronizing") {
    return <CenteredLoadingState label="Opening your workspace…" />;
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="flex-grow px-5 pb-16 pt-6"
      contentInsetAdjustmentBehavior="automatic"
    >
      {view.phase === "configuration-required" ? (
        <StateCard title="Cloud configuration required">
          <Text className="text-[15px] leading-6 text-foreground">{view.error}</Text>
          <Text className="text-sm leading-5 text-muted-foreground">
            Set EXPO_PUBLIC_GLASS_API_URL to the Glass Cloud API origin.
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

      {authenticatedUserId === null ? null : (
        <StateCard title="Organizations">
          <SelectMenu
            disabled={organizations.length === 0}
            label="Organization"
            onSelect={(organizationId) =>
              runCloudAction(selectOrganization(authenticatedUserId, organizationId))
            }
            options={organizations.map((item) => ({
              label: `${item.organization.name} · ${item.membership.role}`,
              value: item.organization.id,
            }))}
            placeholder="Choose an organization"
            value={view.scope?.organizationId ?? null}
          />
          {organizations.length === 0 ? (
            <Text className="py-2 text-sm text-muted-foreground">No organizations yet.</Text>
          ) : null}
          {organizationsCursor === null ? null : (
            <ActionButton
              label="Load more"
              onPress={() => runCloudAction(loadMoreOrganizations())}
            />
          )}
          <AppInput
            autoCorrect={false}
            maxLength={240}
            onChangeText={setOrganizationName}
            placeholder="Organization name"
            value={organizationName}
          />
          <ActionButton
            disabled={creatingOrganization}
            label={creatingOrganization ? "Creating…" : "Create"}
            onPress={() => {
              const name = organizationName.trim();
              if (name.length === 0) {
                setInputError("Enter an organization name.");
                return;
              }
              setCreatingOrganization(true);
              setInputError(null);
              void bootstrapOrganization(name)
                .catch((error: unknown) => setInputError(errorMessage(error)))
                .finally(() => setCreatingOrganization(false));
            }}
          />
          {organizationsError === null ? null : (
            <Text className="mt-2 text-sm text-destructive">{organizationsError}</Text>
          )}
        </StateCard>
      )}
      {inputError === null ? null : (
        <Text className="mt-2 text-sm text-destructive">{inputError}</Text>
      )}

      {snapshot === null ? null : (
        <>
          <View>
            <Text className="text-xs font-medium text-muted-foreground">Organization</Text>
            <Text className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
              {snapshot.organization.name}
            </Text>
          </View>
          <StateCard title="Projects">
            <AppInput
              autoCorrect={false}
              maxLength={240}
              onChangeText={setProjectName}
              placeholder="New project name"
              value={projectName}
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
                void createProject(name)
                  .then((projectId) => {
                    setProjectName("");
                    navigation.navigate("Project", { projectId });
                  })
                  .catch((error: unknown) => setInputError(errorMessage(error)))
                  .finally(() => setCreating(false));
              }}
            />
            {snapshot.projects.length === 0 ? (
              <Text className="py-2 text-sm text-muted-foreground">No projects yet.</Text>
            ) : null}
            {snapshot.projects.map((project) => (
              <Pressable
                accessibilityRole="button"
                key={project.id}
                onPress={() => navigation.navigate("Project", { projectId: project.id })}
                className="mt-2 rounded-lg px-3 py-2 active:bg-muted"
              >
                <Text className="text-base font-semibold text-card-foreground">{project.name}</Text>
              </Pressable>
            ))}
          </StateCard>
        </>
      )}

      <StatusBar />
    </ScrollView>
  );
};
