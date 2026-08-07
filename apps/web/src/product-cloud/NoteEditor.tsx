import type { NoteArtifact } from "@glass/contracts/product";
import type { NoteContentResponse } from "@glass/contracts/notes";
import type { OpenEditorDocument } from "@openeditor/core";
import { OpenEditor, type OpenEditorTheme } from "@openeditor/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { createProductCloudTransport } from "./transport.ts";
import { WorkspaceHeaderContent } from "./WorkspaceHeader.tsx";

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

const openEditorTheme = {
  surface: "var(--background)",
  surfaceRaised: "var(--popover)",
  surfaceMuted: "var(--muted)",
  interactionHover: "var(--accent)",
  interactionSelected: "var(--secondary)",
  blockSurface: "var(--card)",
  text: "var(--foreground)",
  textSoft: "var(--muted-foreground)",
  heading: "var(--foreground)",
  muted: "var(--muted-foreground)",
  placeholder: "var(--muted-foreground)",
  border: "var(--border)",
  borderStrong: "var(--input)",
  structuralLine: "var(--border)",
  accent: "var(--primary)",
  accentText: "var(--primary-foreground)",
  accentStrong: "var(--ring)",
  buttonBackground: "var(--primary)",
  buttonText: "var(--primary-foreground)",
  codeBackground: "var(--muted)",
  codeText: "var(--foreground)",
  link: "var(--foreground)",
  linkHover: "var(--muted-foreground)",
  shadow: "0 12px 32px oklch(0 0 0 / 0.16)",
  fontSans: "var(--font-sans)",
  fontMono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  radiusSmall: "var(--radius-sm)",
  radiusMedium: "var(--radius-md)",
  radiusLarge: "var(--radius-lg)",
  bodyFontSize: "1rem",
  bodyLineHeight: "1.65",
  headingFont: "var(--font-sans)",
  headingLineHeight: "1.2",
  headingWeight: "650",
} satisfies OpenEditorTheme;

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
    <section className="mt-4" aria-label={`Note: ${note.name}`}>
      <WorkspaceHeaderContent>
        <Button
          disabled={closing}
          onClick={() => void closeSafely()}
          size="sm"
          type="button"
          variant="ghost"
        >
          {closing ? "Saving…" : "Back to workspace"}
        </Button>
        <span aria-hidden="true" className="h-4 w-px bg-border" />
        <h1 className="min-w-0 truncate text-sm font-semibold">{note.name}</h1>
        <div
          className={`ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground note-save-state-${saveState.status}`}
          role="status"
        >
          {saveState.status === "saved" ? "Saved" : null}
          {saveState.status === "saving" ? "Saving…" : null}
          {saveState.status === "error" ? (
            <>
              <span className="max-w-64 truncate text-destructive">{saveState.error}</span>
              <Button
                onClick={() => void savePending().catch(() => undefined)}
                size="sm"
                type="button"
                variant="outline"
              >
                Retry
              </Button>
            </>
          ) : null}
        </div>
      </WorkspaceHeaderContent>

      {loadState.status === "loading" ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading note…</p>
      ) : null}
      {loadState.status === "error" ? (
        <Alert variant="destructive">
          <AlertDescription>{loadState.error}</AlertDescription>
          <Button
            className="mt-3"
            onClick={() => setLoadGeneration((value) => value + 1)}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry load
          </Button>
        </Alert>
      ) : null}
      {loadState.status === "ready" ? (
        <OpenEditor
          className="note-editor-surface"
          contentClassName="note-editor-content"
          enabledBlocks={enabledBlocks}
          initialDocument={loadState.response.content}
          key={note.id}
          onChange={scheduleSave}
          placeholder="Start writing…"
          theme={openEditorTheme}
        />
      ) : null}
    </section>
  );
};
