import { describe, expect, it } from "vite-plus/test";
import { createDocument } from "@openeditor/core";
import type {
  ArtifactId,
  CommandId,
  IsoDateTime,
  OrganizationId,
  ProjectId,
  UserId,
} from "@glass/contracts/ids";

import {
  classifyProductTransportError,
  createProductTransport,
  drainThenSynchronize,
  ProductHttpError,
  ProductProtocolError,
  resolveApiBaseUrl,
} from "./transport.ts";
import {
  createNoteMutation,
  createOrganizationMutation,
  createProjectMutation,
} from "./product-mutations.ts";

const organizationId = "00000000-0000-4000-8000-000000000001" as OrganizationId;
const otherOrganizationId = "00000000-0000-4000-8000-000000000002" as OrganizationId;
const noteId = "00000000-0000-4000-8000-000000000003" as ArtifactId;
const userId = "00000000-0000-4000-8000-000000000004" as UserId;
const commandId = "00000000-0000-4000-8000-000000000005" as CommandId;
const projectId = "00000000-0000-4000-8000-000000000006" as ProjectId;
const savedAt = "2026-08-02T10:00:00.000Z" as IsoDateTime;

describe("mobile product transport policy", () => {
  it("accepts only a bare HTTP(S) API origin", () => {
    expect(resolveApiBaseUrl("https://api.glass.example/")).toBe("https://api.glass.example");
    expect(() => resolveApiBaseUrl("https://api.glass.example/prefix")).toThrow(
      ProductProtocolError,
    );
    expect(() => resolveApiBaseUrl("https://user:secret@api.glass.example")).toThrow(
      ProductProtocolError,
    );
  });

  it("drains recovered commands before the synchronization that marks mobile live", async () => {
    const order: string[] = [];
    await drainThenSynchronize(
      async () => {
        order.push("drain");
      },
      async () => {
        order.push("synchronize");
      },
    );
    expect(order).toEqual(["drain", "synchronize"]);
  });

  it("creates note commands without putting editor content in the mutation", () => {
    const ids = [noteId, commandId][Symbol.iterator]();
    const created = createNoteMutation(
      {
        name: "Mobile plan",
        organizationId,
        projectId,
      },
      () => ids.next().value ?? "",
    );

    expect(created.mutation.operation.kind).toBe("note.create");
    expect("content" in created.mutation.operation).toBe(false);
  });

  it("creates durable organization and project commands with client-generated IDs", () => {
    const organizationIds = [otherOrganizationId, commandId][Symbol.iterator]();
    expect(
      createOrganizationMutation("Acme", () => organizationIds.next().value ?? "").mutation,
    ).toEqual({
      commandId,
      operation: { kind: "organization.create", name: "Acme" },
      organizationId: otherOrganizationId,
    });

    const projectIds = [projectId, commandId][Symbol.iterator]();
    expect(
      createProjectMutation(
        { description: null, name: "Core", organizationId },
        () => projectIds.next().value ?? "",
      ).mutation,
    ).toEqual({
      commandId,
      operation: { description: null, kind: "project.create", name: "Core", projectId },
      organizationId,
    });
  });

  it("rejects organization discovery records for another authenticated user", async () => {
    const requests: string[] = [];
    const fetcher = ((input: RequestInfo | URL) => {
      requests.push(String(input));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: [
              {
                membership: {
                  createdAt: savedAt,
                  organizationId,
                  role: "owner",
                  updatedAt: savedAt,
                  userId: "00000000-0000-4000-8000-000000000099",
                  version: 1,
                },
                organization: {
                  createdAt: savedAt,
                  id: organizationId,
                  name: "Glass",
                  updatedAt: savedAt,
                  version: 1,
                },
              },
            ],
            nextCursor: organizationId,
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
      );
    }) as typeof fetch;
    await expect(
      createProductTransport("https://api.glass.example", fetcher).listOrganizations(userId, {
        after: otherOrganizationId,
        limit: 25,
      }),
    ).rejects.toBeInstanceOf(ProductProtocolError);
    expect(requests[0]).toContain(`after=${otherOrganizationId}`);
    expect(requests[0]).toContain("limit=25");
  });

  it("keeps authoritative denials out of transient retry behavior", () => {
    expect(
      classifyProductTransportError(
        new ProductHttpError(401, {
          code: "UNAUTHENTICATED",
          message: "Session expired.",
          retryable: false,
        }),
      ),
    ).toEqual({
      code: "unauthenticated",
      currentVersion: null,
      kind: "permanent",
      message: "Session expired.",
    });
    expect(
      classifyProductTransportError(
        new ProductHttpError(403, {
          code: "FORBIDDEN",
          message: "Membership is required.",
          retryable: false,
        }),
      ),
    ).toEqual({
      code: "forbidden",
      currentVersion: null,
      kind: "permanent",
      message: "Membership is required.",
    });
    expect(
      classifyProductTransportError(
        new ProductHttpError(503, {
          code: "PRODUCT_UNAVAILABLE",
          message: "Try again.",
          retryable: true,
        }),
      ),
    ).toEqual({ kind: "transient" });
  });

  it("loads note content with authenticated organization and note scoping", async () => {
    const requests: Array<{ input: string; init: RequestInit | undefined }> = [];
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input: String(input), init });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: createDocument(),
            noteId,
            organizationId,
            savedAt,
            savedByUserId: userId,
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
      );
    }) as typeof fetch;

    await createProductTransport("https://api.glass.example", fetcher).loadNoteContent(
      organizationId,
      noteId,
    );

    expect(requests[0]?.input).toContain(`/v1/notes/content?organizationId=${organizationId}`);
    expect(requests[0]?.input).toContain(`noteId=${noteId}`);
    expect(requests[0]?.init?.credentials).toBe("include");
  });

  it("rejects a note load response from another organization", async () => {
    const fetcher = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            content: createDocument(),
            noteId,
            organizationId: otherOrganizationId,
            savedAt,
            savedByUserId: userId,
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
      )) as typeof fetch;
    await expect(
      createProductTransport("https://api.glass.example", fetcher).loadNoteContent(
        organizationId,
        noteId,
      ),
    ).rejects.toBeInstanceOf(ProductProtocolError);
  });

  it("keeps note content outside the product outbox transport", () => {
    const fetcher = (() => Promise.reject(new Error("unused"))) as typeof fetch;
    const transport = createProductTransport("https://api.glass.example", fetcher);

    expect("saveNoteContent" in transport.outboxTransport).toBe(false);
    expect("loadNoteContent" in transport.outboxTransport).toBe(false);
    expect(typeof transport.saveNoteContent).toBe("function");
  });
});
