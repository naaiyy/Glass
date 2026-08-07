import type { ProjectId } from "@glass/contracts/ids";
import type { NoteArtifact } from "@glass/contracts/product";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { Text } from "react-native";

import { errorMessage } from "../lib/errors.ts";
import { decodeRouteId } from "../navigation/decode-route-id.ts";
import type { RootStack } from "../navigation/routes.ts";
import { useMobileCloud } from "../product-cloud/ProductCloudProvider.tsx";
import { ActionButton, AppInput, DetailLayout } from "../ui/primitives.tsx";

export const ProjectScreen = ({
  navigation,
  route,
}: NativeStackScreenProps<RootStack, "Project">) => {
  const cloud = useMobileCloud();
  const snapshot = cloud.view.snapshot;
  const [noteName, setNoteName] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [creatingNote, setCreatingNote] = useState(false);
  const projectId = decodeRouteId<ProjectId>(route.params.projectId, "$projectId");
  const project = snapshot?.projects.find((item) => item.id === projectId);
  if (snapshot === null || project === undefined)
    return (
      <DetailLayout title="Project unavailable">
        <Text className="text-[15px] leading-6 text-foreground">
          This project is not in the validated projection.
        </Text>
      </DetailLayout>
    );
  const threads = snapshot.threads.filter((item) => item.projectId === project.id);
  const artifacts = snapshot.artifacts.filter((item) => item.projectId === project.id);
  const notes = artifacts.filter((item): item is NoteArtifact => item.kind === "note");
  const outputs = artifacts.filter((item) => item.kind === "agent-output");
  return (
    <DetailLayout title={project.name}>
      <Text className="text-[15px] leading-6 text-muted-foreground">
        {project.description ?? "No description"}
      </Text>
      <Text className="mt-6 text-lg font-semibold text-foreground">Threads</Text>
      {threads.map((item) => (
        <ActionButton
          key={item.id}
          label={item.title ?? "Untitled thread"}
          onPress={() => navigation.navigate("Thread", { threadId: item.id })}
        />
      ))}
      <Text className="mt-6 text-lg font-semibold text-foreground">Notes</Text>
      <AppInput
        autoCorrect={false}
        editable={!creatingNote}
        maxLength={240}
        onChangeText={setNoteName}
        placeholder="New note name"
        value={noteName}
      />
      {noteError === null ? null : (
        <Text className="mt-2 text-sm text-destructive">{noteError}</Text>
      )}
      <ActionButton
        disabled={creatingNote}
        label={creatingNote ? "Creating…" : "Create note"}
        onPress={() => {
          const name = noteName.trim();
          if (name.length === 0) {
            setNoteError("Enter a note name while Glass Cloud is live.");
            return;
          }
          setCreatingNote(true);
          setNoteError(null);
          void cloud
            .createNote(project.id, name)
            .then((noteId) => {
              setNoteName("");
              navigation.navigate("Note", { noteId });
            })
            .catch((error: unknown) => setNoteError(errorMessage(error)))
            .finally(() => setCreatingNote(false));
        }}
      />
      {notes.length === 0 ? (
        <Text className="mt-2 text-sm text-muted-foreground">No notes yet.</Text>
      ) : null}
      {notes.map((item) => (
        <ActionButton
          key={item.id}
          label={item.icon === null ? item.name : `${item.icon} ${item.name}`}
          onPress={() => navigation.navigate("Note", { noteId: item.id })}
        />
      ))}
      <Text className="mt-6 text-lg font-semibold text-foreground">Artifacts</Text>
      {outputs.map((item) => (
        <ActionButton
          key={item.id}
          label={item.name}
          onPress={() => navigation.navigate("Artifact", { artifactId: item.id })}
        />
      ))}
    </DetailLayout>
  );
};
