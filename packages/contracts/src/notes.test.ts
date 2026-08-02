import { getBlockId, type OpenEditorDocument } from "@openeditor/core";
import { describe, expect, it } from "vite-plus/test";

import { decodeProductEvent, decodeProductMutation } from "./events.ts";
import {
  decodeNoteContentResponse,
  decodeOpenEditorNoteContent,
  decodeSaveNoteContentRequest,
  decodeSaveNoteContentResponse,
  maxNoteContentBytes,
  maxNoteContentEnvelopeBytes,
} from "./notes.ts";
import { decodeProductEntity } from "./product.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const noteId = "33333333-3333-4333-8333-333333333333";
const commandId = "44444444-4444-4444-8444-444444444444";
const userId = "55555555-5555-4555-8555-555555555555";
const savedAt = "2026-08-02T12:00:00.000Z";

const rawDocument = (): OpenEditorDocument => ({
  type: "doc",
  version: 1,
  content: [
    {
      type: "heading",
      attrs: { level: 99 },
      content: [{ type: "text", text: "Native OpenEditor content" }],
    },
  ],
});

const noteMetadata = {
  createdAt: "2026-08-02T12:00:00.000Z",
  icon: "📝",
  id: noteId,
  kind: "note",
  name: "Architecture",
  organizationId,
  projectId,
  updatedAt: "2026-08-02T12:00:00.000Z",
  version: 1,
};

describe("native OpenEditor note content", () => {
  it("normalizes through OpenEditor instead of a Glass document model", () => {
    const decoded = decodeOpenEditorNoteContent(rawDocument());

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.content[0]?.attrs?.level).toBe(6);
    expect(getBlockId(decoded.value.content[0]!)).toMatch(/^oe_/u);
  });

  it("rejects unsupported OpenEditor document versions with native issue paths", () => {
    const decoded = decodeOpenEditorNoteContent({ type: "doc", version: 2, content: [] });

    expect(decoded).toMatchObject({
      ok: false,
      issues: [{ path: "$.content.version" }],
    });
  });

  it("enforces the five MiB normalized content bound", () => {
    const decoded = decodeSaveNoteContentRequest({
      content: {
        type: "doc",
        version: 1,
        content: [{ type: "text", text: "x".repeat(maxNoteContentBytes) }],
      },
      noteId,
      organizationId,
    });

    expect(decoded).toMatchObject({ ok: false });
  });

  it("allows envelope fields around content at the exact five MiB limit", () => {
    const empty = decodeOpenEditorNoteContent({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "" }] }],
    });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    const fixedBytes = new TextEncoder().encode(JSON.stringify(empty.value)).byteLength;
    const content = decodeOpenEditorNoteContent({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "x".repeat(maxNoteContentBytes - fixedBytes) }],
        },
      ],
    });
    expect(content.ok).toBe(true);
    if (!content.ok) return;
    expect(new TextEncoder().encode(JSON.stringify(content.value)).byteLength).toBe(
      maxNoteContentBytes,
    );
    const request = { content: content.value, noteId, organizationId };
    expect(new TextEncoder().encode(JSON.stringify(request)).byteLength).toBeGreaterThan(
      maxNoteContentBytes,
    );
    expect(new TextEncoder().encode(JSON.stringify(request)).byteLength).toBeLessThanOrEqual(
      maxNoteContentEnvelopeBytes,
    );
    expect(decodeSaveNoteContentRequest(request)).toMatchObject({ ok: true });
    expect(decodeNoteContentResponse({ ...request, savedAt, savedByUserId: userId })).toMatchObject(
      { ok: true },
    );
  });

  it("returns normalized content from dedicated load and save boundaries", () => {
    const request = { content: rawDocument(), noteId, organizationId };
    const load = decodeNoteContentResponse({
      ...request,
      savedAt,
      savedByUserId: userId,
    });
    const save = decodeSaveNoteContentRequest(request);

    expect(load.ok && getBlockId(load.value.content.content[0]!)).toMatch(/^oe_/u);
    expect(save.ok && getBlockId(save.value.content.content[0]!)).toMatch(/^oe_/u);
    expect(
      decodeSaveNoteContentResponse({ noteId, organizationId, savedAt, savedByUserId: userId }),
    ).toMatchObject({ ok: true });
  });

  it("does not accept server-owned save authority in a client request", () => {
    expect(
      decodeSaveNoteContentRequest({
        content: rawDocument(),
        noteId,
        organizationId,
        savedAt,
        savedByUserId: userId,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("note metadata isolation", () => {
  it("keeps note artifacts metadata-only", () => {
    expect(decodeProductEntity("artifact", noteMetadata)).toEqual({
      ok: true,
      value: noteMetadata,
    });
    expect(
      decodeProductEntity("artifact", { ...noteMetadata, content: rawDocument() }),
    ).toMatchObject({ ok: false });
  });

  it("rejects editor content from generic mutations before it can enter the outbox", () => {
    expect(
      decodeProductMutation({
        commandId,
        organizationId,
        operation: {
          artifactId: noteId,
          content: rawDocument(),
          icon: null,
          kind: "note.create",
          name: "Architecture",
          projectId,
        },
      }),
    ).toMatchObject({ ok: false });
  });

  it("decodes optimistic note metadata updates without content", () => {
    const mutation = {
      commandId,
      organizationId,
      operation: {
        artifactId: noteId,
        expectedVersion: 1,
        icon: "📐",
        kind: "note.update",
        name: "Architecture plan",
      },
    };

    expect(decodeProductMutation(mutation)).toEqual({ ok: true, value: mutation });
  });

  it("allows only note metadata in product events", () => {
    const event = {
      action: "created",
      actorUserId: userId,
      aggregateId: noteId,
      aggregateType: "artifact",
      aggregateVersion: 1,
      commandId,
      cursor: "1",
      entity: noteMetadata,
      eventId: "66666666-6666-4666-8666-666666666666",
      occurredAt: "2026-08-02T12:00:00.000Z",
      organizationId,
    };

    expect(decodeProductEvent(event)).toEqual({ ok: true, value: event });
    expect(
      decodeProductEvent({
        ...event,
        entity: { ...noteMetadata, content: rawDocument() },
      }),
    ).toMatchObject({ ok: false });
  });
});
