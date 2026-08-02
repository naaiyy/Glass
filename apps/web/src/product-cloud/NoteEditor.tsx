import type { NoteArtifact } from "@glass/contracts/product";
import type { NoteContentResponse } from "@glass/contracts/notes";
import type { OpenEditorDocument } from "@openeditor/core";
import { OpenEditor } from "@openeditor/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createProductCloudTransport } from "./transport.ts";

const saveDelayMs = 800;
const enabledBlocks = [
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "taskList",
  "toggleList",
  "callout",
  "blockquote",
  "codeBlock",
  "table",
  "divider",
  "columns",
  "diagram",
] as const;

type LoadState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ error: string; status: "error" }>
  | Readonly<{ response: NoteContentResponse; status: "ready" }>;

type SaveState =
  | Readonly<{ status: "saved" }>
  | Readonly<{ status: "saving" }>
  | Readonly<{ error: string; status: "error" }>;

const messageFrom = (error: unknown): string =>
  error instanceof Error ? error.message : "Glass Cloud could not save this note.";

export const NoteEditor = ({ note, onClose }: { note: NoteArtifact; onClose: () => void }) => {
  const transport = useMemo(
    () => createProductCloudTransport(import.meta.env.VITE_GLASS_API_URL),
    [],
  );
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [saveState, setSaveState] = useState<SaveState>({ status: "saved" });
  const [loadGeneration, setLoadGeneration] = useState(0);
  const [closing, setClosing] = useState(false);
  const pending = useRef<OpenEditorDocument | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    setLoadState({ status: "loading" });
    setSaveState({ status: "saved" });
    pending.current = null;
    void transport
      .loadNoteContent(note.organizationId, note.id)
      .then((response) => {
        if (!abort.signal.aborted) setLoadState({ response, status: "ready" });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setLoadState({ error: messageFrom(error), status: "error" });
      });
    return () => abort.abort();
  }, [loadGeneration, note.id, note.organizationId, transport]);

  const savePending = useCallback(
    async (publishState = true): Promise<void> => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (inFlight.current !== null) return inFlight.current;

      const run = async (): Promise<void> => {
        const content = pending.current;
        if (content === null) {
          if (publishState && mounted.current) setSaveState({ status: "saved" });
          return;
        }
        pending.current = null;
        if (publishState && mounted.current) setSaveState({ status: "saving" });
        try {
          await transport.saveNoteContent({
            content,
            noteId: note.id,
            organizationId: note.organizationId,
          });
        } catch (error) {
          if (pending.current === null) pending.current = content;
          if (publishState && mounted.current) {
            setSaveState({ error: messageFrom(error), status: "error" });
          }
          throw error;
        }
        return run();
      };

      inFlight.current = run().finally(() => {
        inFlight.current = null;
      });
      return inFlight.current;
    },
    [note.id, note.organizationId, transport],
  );

  const scheduleSave = useCallback(
    (content: OpenEditorDocument) => {
      pending.current = content;
      setSaveState({ status: "saving" });
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => void savePending().catch(() => undefined), saveDelayMs);
    },
    [savePending],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      void savePending(false).catch(() => undefined);
    },
    [savePending],
  );

  useEffect(() => {
    const guardUnsavedContent = (event: BeforeUnloadEvent) => {
      if (pending.current === null && inFlight.current === null) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guardUnsavedContent);
    return () => window.removeEventListener("beforeunload", guardUnsavedContent);
  }, []);

  const closeSafely = async () => {
    setClosing(true);
    try {
      await savePending();
      onClose();
    } catch {
      // savePending preserves the document and publishes the actionable error.
      setClosing(false);
    }
  };

  return (
    <section className="note-workspace" aria-label={`Note: ${note.name}`}>
      <header className="note-header">
        <button
          className="note-back"
          disabled={closing}
          onClick={() => void closeSafely()}
          type="button"
        >
          {closing ? "Saving…" : "Back to workspace"}
        </button>
        <div>
          <p className="section-label">Note</p>
          <h2>{note.name}</h2>
        </div>
        <div className={`note-save-state note-save-state-${saveState.status}`} role="status">
          {saveState.status === "saved" ? "Saved" : null}
          {saveState.status === "saving" ? "Saving…" : null}
          {saveState.status === "error" ? (
            <>
              <span>{saveState.error}</span>
              <button onClick={() => void savePending().catch(() => undefined)} type="button">
                Retry
              </button>
            </>
          ) : null}
        </div>
      </header>

      {loadState.status === "loading" ? <p className="state-panel">Loading note…</p> : null}
      {loadState.status === "error" ? (
        <section className="offline-banner">
          <p>{loadState.error}</p>
          <button
            className="retry-button"
            onClick={() => setLoadGeneration((value) => value + 1)}
            type="button"
          >
            Retry load
          </button>
        </section>
      ) : null}
      {loadState.status === "ready" ? (
        <OpenEditor
          contentClassName="note-editor-content"
          enabledBlocks={enabledBlocks}
          initialDocument={loadState.response.content}
          key={note.id}
          onChange={scheduleSave}
          placeholder="Start writing…"
        />
      ) : null}
    </section>
  );
};
