import type { ProjectId } from "@glass/contracts/ids";
import type { NoteArtifact } from "@glass/contracts/product";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { Text, TextInput } from "react-native";

import { errorMessage } from "../lib/errors.ts";
import { decodeRouteId } from "../navigation/decode-route-id.ts";
import type { RootStack } from "../navigation/routes.ts";
import { useMobileCloud } from "../product-cloud/ProductCloudProvider.tsx";
import { ActionButton, DetailLayout } from "../ui/primitives.tsx";
import { styles } from "../ui/styles.ts";

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
        <Text style={styles.body}>This project is not in the validated projection.</Text>
      </DetailLayout>
    );
  const threads = snapshot.threads.filter((item) => item.projectId === project.id);
  const artifacts = snapshot.artifacts.filter((item) => item.projectId === project.id);
  const notes = artifacts.filter((item): item is NoteArtifact => item.kind === "note");
  const outputs = artifacts.filter((item) => item.kind === "agent-output");
  return (
    <DetailLayout title={project.name}>
      <Text style={styles.body}>{project.description ?? "No description"}</Text>
      <Text style={styles.sectionTitle}>Threads</Text>
      {threads.map((item) => (
        <ActionButton
          key={item.id}
          label={item.title ?? "Untitled thread"}
          onPress={() => navigation.navigate("Thread", { threadId: item.id })}
        />
      ))}
      <Text style={styles.sectionTitle}>Notes</Text>
      <TextInput
        autoCorrect={false}
        editable={!creatingNote}
        maxLength={240}
        onChangeText={setNoteName}
        placeholder="New note name"
        placeholderTextColor="#71817a"
        style={styles.input}
        value={noteName}
      />
      {noteError === null ? null : <Text style={styles.error}>{noteError}</Text>}
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
      {notes.length === 0 ? <Text style={styles.muted}>No notes yet.</Text> : null}
      {notes.map((item) => (
        <ActionButton
          key={item.id}
          label={item.icon === null ? item.name : `${item.icon} ${item.name}`}
          onPress={() => navigation.navigate("Note", { noteId: item.id })}
        />
      ))}
      <Text style={styles.sectionTitle}>Artifacts</Text>
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
