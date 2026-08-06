import { describe, expect, it } from "vite-plus/test";
import {
  decodeCreateExecutionOperationRequest,
  decodeCreateWorkspaceBindingRequest,
} from "./execution-cloud.ts";

describe("execution cloud contracts", () => {
  it("does not accept a client-supplied workspace display name as authority", () => {
    expect(
      decodeCreateWorkspaceBindingRequest({
        environmentId: "10000000-0000-4000-8000-000000000001",
        organizationId: "30000000-0000-4000-8000-000000000001",
        projectId: "40000000-0000-4000-8000-000000000001",
        workspaceId: "50000000-0000-4000-8000-000000000001",
        displayName: "Untrusted name",
      }),
    ).toMatchObject({ ok: true, value: { workspaceId: "50000000-0000-4000-8000-000000000001" } });
  });
  it("requires explicit cloud and workspace scope", () => {
    expect(
      decodeCreateExecutionOperationRequest({ request: { operation: "workspace.list" } }),
    ).toMatchObject({ ok: false });
  });

  it("accepts a scoped operation intent", () => {
    expect(
      decodeCreateExecutionOperationRequest({
        environmentId: "10000000-0000-4000-8000-000000000001",
        operationId: "20000000-0000-4000-8000-000000000001",
        organizationId: "30000000-0000-4000-8000-000000000001",
        projectId: "40000000-0000-4000-8000-000000000001",
        workspaceId: "50000000-0000-4000-8000-000000000001",
        requestId: "request-1",
        request: { operation: "workspace.list" },
      }),
    ).toMatchObject({ ok: true });
  });
});
