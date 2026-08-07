import type { ProjectId } from "@glass/contracts/ids";
import type { NoteArtifact } from "@glass/contracts/product";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { Pressable, Text } from "react-native";

import { errorMessage } from "../lib/errors.ts";
import { decodeRouteId } from "../navigation/decode-route-id.ts";
import type { RootStack } from "../navigation/routes.ts";
import { useMobileCloud } from "../product-cloud/ProductCloudProvider.tsx";
import { ActionButton, AppInput, DetailLayout, StateCard } from "../ui/primitives.tsx";

const summaryLabel = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

export const ProjectScreen = ({
  navigation,
  route,
}: NativeStackScreenProps<RootStack, "Project">) => {
  const cloud = useMobileCloud();
  const snapshot = cloud.view.snapshot;
  const projectId = decodeRouteId<ProjectId>(route.params.projectId, "$projectId");
  const project = snapshot?.projects.find((item) => item.id === projectId);
  const [noteName, setNoteName] = useState("");
  const [threadTitle, setThreadTitle] = useState("");
  const [creating, setCreating] = useState<"note" | "thread" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (snapshot === null || project === undefined)
    return (
      <DetailLayout title="Project unavailable">
        <Text className="text-[15px] leading-6 text-foreground">
          This project is not in the validated projection.
        </Text>
      </DetailLayout>
    );

  const threads = snapshot.threads.filter((thread) => thread.projectId === project.id);
  const notes = snapshot.artifacts.filter(
    (artifact): artifact is NoteArtifact =>
      artifact.kind === "note" && artifact.projectId === project.id,
  );
  const artifacts = snapshot.artifacts.filter(
    (artifact) => artifact.kind === "agent-output" && artifact.projectId === project.id,
  );

  return (
    <DetailLayout title={project.name}>
      {error === null ? null : <Text className="text-sm text-destructive">{error}</Text>}
      <StateCard title="Threads">
        <AppInput
          editable={creating === null}
          maxLength={240}
          onChangeText={setThreadTitle}
          placeholder="Thread title (optional)"
          value={threadTitle}
        />
        <ActionButton
          disabled={creating !== null}
          label={creating === "thread" ? "Creating…" : "New thread"}
          onPress={() => {
            setCreating("thread");
            setError(null);
            void cloud
              .createThread(project.id, threadTitle.trim() || null)
              .then((threadId) => {
                setThreadTitle("");
                navigation.navigate("Thread", { threadId });
              })
              .catch((cause: unknown) => setError(errorMessage(cause)))
              .finally(() => setCreating(null));
          }}
        />
        {threads.length === 0 ? (
          <Text className="py-2 text-sm text-muted-foreground">No threads yet.</Text>
        ) : null}
        {threads.map((thread) => (
          <Pressable
            accessibilityRole="button"
            className="mt-2 rounded-lg px-3 py-2 active:bg-muted"
            key={thread.id}
            onPress={() => navigation.navigate("Thread", { threadId: thread.id })}
          >
            <Text className="text-base font-semibold text-card-foreground">
              {thread.title ?? "Untitled thread"}
            </Text>
            <Text className="mt-0.5 text-sm text-muted-foreground">
              {summaryLabel(
                snapshot.messages.filter((message) => message.threadId === thread.id).length,
                "message",
              )}
            </Text>
          </Pressable>
        ))}
      </StateCard>

      <StateCard title="Notes">
        <AppInput
          editable={creating === null}
          maxLength={240}
          onChangeText={setNoteName}
          placeholder="New note name"
          value={noteName}
        />
        <ActionButton
          disabled={creating !== null}
          label={creating === "note" ? "Creating…" : "New note"}
          onPress={() => {
            const name = noteName.trim();
            if (name.length === 0) {
              setError("Enter a note name.");
              return;
            }
            setCreating("note");
            setError(null);
            void cloud
              .createNote(project.id, name)
              .then((noteId) => {
                setNoteName("");
                navigation.navigate("Note", { noteId });
              })
              .catch((cause: unknown) => setError(errorMessage(cause)))
              .finally(() => setCreating(null));
          }}
        />
        {notes.length === 0 ? (
          <Text className="py-2 text-sm text-muted-foreground">No notes yet.</Text>
        ) : null}
        {notes.map((note) => (
          <Pressable
            accessibilityRole="button"
            className="mt-2 rounded-lg px-3 py-2 active:bg-muted"
            key={note.id}
            onPress={() => navigation.navigate("Note", { noteId: note.id })}
          >
            <Text className="text-base font-semibold text-card-foreground">
              {note.icon === null ? note.name : `${note.icon} ${note.name}`}
            </Text>
          </Pressable>
        ))}
      </StateCard>

      <StateCard title="Artifacts">
        <Text className="text-sm text-muted-foreground">
          Agent work in this project produces artifacts here.
        </Text>
        {artifacts.length === 0 ? (
          <Text className="py-2 text-sm text-muted-foreground">No artifacts yet.</Text>
        ) : null}
        {artifacts.map((artifact) => (
          <Pressable
            accessibilityRole="button"
            className="mt-2 rounded-lg px-3 py-2 active:bg-muted"
            key={artifact.id}
            onPress={() => navigation.navigate("Artifact", { artifactId: artifact.id })}
          >
            <Text className="text-base font-semibold text-card-foreground">{artifact.name}</Text>
          </Pressable>
        ))}
      </StateCard>
    </DetailLayout>
  );
};
