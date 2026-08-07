import type { ArtifactId } from "@glass/contracts/ids";
import type { NoteArtifact } from "@glass/contracts/product";
import type { OpenEditorDocument } from "@openeditor/core";
import { OpenEditorNative, type OpenEditorNativeController } from "@openeditor/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, Text, View } from "react-native";

import { mobileAuthenticatedFetch } from "../cloud/auth-client.ts";
import { createProductTransport, resolveApiBaseUrl } from "../cloud/transport.ts";
import { errorMessage } from "../lib/errors.ts";
import { decodeRouteId } from "../navigation/decode-route-id.ts";
import type { RootStack } from "../navigation/routes.ts";
import { useProductCloudState } from "../product-cloud/ProductCloudProvider.tsx";
import { ActionButton } from "../ui/primitives.tsx";
import { styles } from "../ui/styles.ts";

type NoteLoadState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ error: string; status: "error" }>
  | Readonly<{ content: OpenEditorDocument; status: "ready" }>;

type NoteSaveState =
  | Readonly<{ status: "saved" }>
  | Readonly<{ status: "saving" }>
  | Readonly<{ error: string; status: "error" }>;

export const NoteScreen = ({ navigation, route }: NativeStackScreenProps<RootStack, "Note">) => {
  const snapshot = useProductCloudState().view.snapshot;
  const routeNoteId = decodeRouteId<ArtifactId>(route.params.noteId, "$noteId");
  const note = snapshot?.artifacts.find(
    (item): item is NoteArtifact => item.kind === "note" && item.id === routeNoteId,
  );
  const noteId = note?.id;
  const noteOrganizationId = note?.organizationId;
  const apiBaseUrl = useMemo(() => resolveApiBaseUrl(process.env.EXPO_PUBLIC_GLASS_API_URL), []);
  const transport = useMemo(
    () => createProductTransport(apiBaseUrl, mobileAuthenticatedFetch(apiBaseUrl)),
    [apiBaseUrl],
  );
  const controller = useRef<OpenEditorNativeController>(null);
  const [loadGeneration, setLoadGeneration] = useState(0);
  const [loadState, setLoadState] = useState<NoteLoadState>({ status: "loading" });
  const [saveState, setSaveState] = useState<NoteSaveState>({ status: "saved" });
  const pendingRevision = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const flushInFlight = useRef<Promise<void> | null>(null);
  const allowLeave = useRef(false);

  useEffect(() => {
    let active = true;
    if (noteId === undefined || noteOrganizationId === undefined) {
      setLoadState({
        error: "This note is not in the validated product snapshot.",
        status: "error",
      });
      return () => {
        active = false;
      };
    }
    setLoadState({ status: "loading" });
    void transport
      .loadNoteContent(noteOrganizationId, noteId)
      .then((response) => {
        if (active) setLoadState({ content: response.content, status: "ready" });
      })
      .catch((error: unknown) => {
        if (active) setLoadState({ error: errorMessage(error), status: "error" });
      });
    return () => {
      active = false;
    };
  }, [loadGeneration, noteId, noteOrganizationId, transport]);

  const savePending = useCallback(async (): Promise<void> => {
    if (noteId === undefined || noteOrganizationId === undefined) return;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (flushInFlight.current !== null) return flushInFlight.current;
    if (inFlight.current !== null) return inFlight.current;
    const run = async (): Promise<void> => {
      const revision = pendingRevision.current;
      if (revision === null) {
        setSaveState({ status: "saved" });
        return;
      }
      pendingRevision.current = null;
      setSaveState({ status: "saving" });
      try {
        const current = await controller.current?.getDocument({ minimumRevision: revision });
        if (current === undefined) throw new Error("The note editor is not ready.");
        await transport.saveNoteContent({
          content: current.document,
          noteId,
          organizationId: noteOrganizationId,
        });
      } catch (error) {
        pendingRevision.current = Math.max(pendingRevision.current ?? 0, revision);
        setSaveState({ error: errorMessage(error), status: "error" });
        return;
      }
      return run();
    };
    inFlight.current = run().finally(() => {
      inFlight.current = null;
    });
    return inFlight.current;
  }, [noteId, noteOrganizationId, transport]);

  const flush = useCallback((): Promise<void> => {
    if (noteId === undefined || noteOrganizationId === undefined || controller.current === null) {
      return Promise.resolve();
    }
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (flushInFlight.current !== null) return flushInFlight.current;
    const run = async (): Promise<void> => {
      await inFlight.current;
      const current = await controller.current?.flushDocument();
      if (current === undefined) throw new Error("The note editor is not ready.");
      setSaveState({ status: "saving" });
      try {
        await transport.saveNoteContent({
          content: current.document,
          noteId,
          organizationId: noteOrganizationId,
        });
      } catch (error) {
        pendingRevision.current = Math.max(pendingRevision.current ?? 0, current.revision);
        setSaveState({ error: errorMessage(error), status: "error" });
        throw error;
      }
      if (pendingRevision.current !== null && pendingRevision.current <= current.revision) {
        pendingRevision.current = null;
      }
      if (pendingRevision.current !== null) return run();
      setSaveState({ status: "saved" });
    };
    flushInFlight.current = run().finally(() => {
      flushInFlight.current = null;
    });
    return flushInFlight.current;
  }, [noteId, noteOrganizationId, transport]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active")
        void flush().catch((error: unknown) =>
          setSaveState({ error: errorMessage(error), status: "error" }),
        );
    });
    return () => subscription.remove();
  }, [flush]);

  useEffect(
    () =>
      navigation.addListener("beforeRemove", (event) => {
        if (allowLeave.current || controller.current === null) return;
        event.preventDefault();
        void flush()
          .then(() => {
            allowLeave.current = true;
            navigation.dispatch(event.data.action);
          })
          .catch((error: unknown) => setSaveState({ error: errorMessage(error), status: "error" }));
      }),
    [flush, navigation],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  if (note === undefined) {
    return (
      <View style={styles.noteState}>
        <Text style={styles.error}>This note is not in the validated product snapshot.</Text>
      </View>
    );
  }

  return (
    <View style={styles.noteScreen}>
      <View style={styles.noteStatusRow}>
        <Text numberOfLines={1} style={styles.noteTitle}>
          {note.icon === null ? note.name : `${note.icon} ${note.name}`}
        </Text>
        <Text style={saveState.status === "error" ? styles.error : styles.muted}>
          {saveState.status === "saved" ? "Saved" : null}
          {saveState.status === "saving" ? "Saving…" : null}
          {saveState.status === "error" ? saveState.error : null}
        </Text>
      </View>
      {saveState.status === "error" ? (
        <ActionButton
          label="Retry save"
          onPress={() =>
            void flush().catch((error: unknown) =>
              setSaveState({ error: errorMessage(error), status: "error" }),
            )
          }
        />
      ) : null}
      {loadState.status === "loading" ? (
        <View style={styles.noteState}>
          <ActivityIndicator />
          <Text style={styles.muted}>Loading note…</Text>
        </View>
      ) : null}
      {loadState.status === "error" ? (
        <View style={styles.noteState}>
          <Text style={styles.error}>{loadState.error}</Text>
          <ActionButton
            label="Retry load"
            onPress={() => setLoadGeneration((value) => value + 1)}
          />
        </View>
      ) : null}
      {loadState.status === "ready" ? (
        <OpenEditorNative
          initialDocument={loadState.content}
          key={note.id}
          onDocumentChanged={({ documentRevision }) => {
            pendingRevision.current = Math.max(pendingRevision.current ?? 0, documentRevision);
            setSaveState({ status: "saving" });
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => void savePending(), 800);
          }}
          onError={(error) => setSaveState({ error: error.message, status: "error" })}
          placeholder="Start writing…"
          ref={controller}
          style={styles.noteEditor}
        />
      ) : null}
    </View>
  );
};
