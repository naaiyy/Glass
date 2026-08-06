import type { Client } from "pg";
import { describe, expect, it } from "vite-plus/test";
import { digestConnectDispatchPayload } from "./connect-tickets.ts";
import { createPostgresExecutionService } from "./execution-service.ts";
import { canIssueRequestDispatch } from "./index.ts";

describe("durable dispatch claims", () => {
  it.each(["running", "cancelling", "succeeded", "failed", "cancelled"] as const)(
    "does not issue another request grant for a %s operation",
    (status) => {
      expect(canIssueRequestDispatch({ status } as never)).toBe(false);
    },
  );

  it("never reclaims an already claimed request and therefore cannot re-execute it", async () => {
    const request = { operation: "file.read", path: "safe.txt", workspaceId: "workspace-1" };
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("select o.*"))
          return {
            rows: [
              {
                actor_user_id: "user-1",
                dispatch_channel_id: "channel-1",
                dispatch_session_id: "session-1",
                request,
                status: "running",
              },
            ],
          };
        return { rows: [] };
      },
    } as unknown as Client;
    const service = createPostgresExecutionService(client);
    const claimed = await service.claimDispatch(
      {
        audience: "glass-connect-dispatch",
        capability: "file.read",
        environmentId: "environment-1",
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        intentId: "operation-1",
        operationId: "operation-1",
        organizationId: "organization-1",
        projectId: "project-1",
        purpose: "request",
        requestId: "request-1",
        requestDigest: await digestConnectDispatchPayload(request),
        workspaceId: "workspace-1",
      },
      "user-1",
      "session-1",
      "channel-1",
    );
    expect(claimed).toBe(false);
    expect(statements.some((sql) => sql.includes("update execution_operations set status"))).toBe(
      false,
    );
  });

  it("authorizes cancellation from a new session without replacing the original result claim", async () => {
    const request = { operation: "file.read", path: "safe.txt", workspaceId: "workspace-1" };
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("select o.*"))
          return {
            rows: [
              {
                actor_user_id: "user-1",
                dispatch_channel_id: "old-channel",
                dispatch_session_id: "old-session",
                request,
                status: "cancelling",
              },
            ],
          };
        return { rows: [] };
      },
    } as unknown as Client;
    const service = createPostgresExecutionService(client);
    const claimed = await service.claimDispatch(
      {
        audience: "glass-connect-dispatch",
        capability: "file.read",
        environmentId: "environment-1",
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        intentId: "operation-1",
        operationId: "operation-1",
        organizationId: "organization-1",
        projectId: "project-1",
        purpose: "cancel",
        requestId: "request-1",
        requestDigest: await digestConnectDispatchPayload(request),
        workspaceId: "workspace-1",
      },
      "user-1",
      "new-session",
      "new-channel",
    );
    expect(claimed).toBe(true);
    expect(statements.some((sql) => sql.includes("dispatch_session_id = $2"))).toBe(false);
  });

  it("serializes array-valued terminal results as JSONB parameters", async () => {
    const parameters: unknown[][] = [];
    const client = {
      query: async (sql: string, values: readonly unknown[] = []) => {
        parameters.push([...values]);
        if (sql.includes("select o.*, e.revoked_at"))
          return {
            rows: [
              {
                capability: "file.list",
                dispatch_channel_id: "channel-1",
                dispatch_session_id: "session-1",
                environment_id: "environment-1",
                environment_revoked_at: null,
                id: "operation-1",
                last_sequence: -1,
                organization_id: "organization-1",
                project_id: "project-1",
                request_id: "request-1",
                status: "running",
                workspace_id: "workspace-1",
                binding_revoked_at: null,
              },
            ],
          };
        return { rows: [] };
      },
    } as unknown as Client;
    const service = createPostgresExecutionService(client);

    await service.recordNodeFrame(
      {
        audience: "glass-connect-dispatch",
        capability: "file.list",
        environmentId: "environment-1",
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        intentId: "operation-1",
        operationId: "operation-1",
        organizationId: "organization-1",
        projectId: "project-1",
        purpose: "request",
        requestDigest: "digest",
        requestId: "request-1",
        workspaceId: "workspace-1",
      },
      {
        event: "result",
        operationId: "operation-1",
        payload: { status: "succeeded", value: [{ name: "README.md" }] },
        requestId: "request-1",
        sequence: 0,
        type: "operation.event",
      },
    );

    expect(parameters).toContainEqual([
      "operation-1",
      0,
      "result",
      JSON.stringify({ status: "succeeded", value: [{ name: "README.md" }] }),
    ]);
    expect(parameters).toContainEqual([
      "operation-1",
      0,
      "succeeded",
      JSON.stringify([{ name: "README.md" }]),
      null,
    ]);
  });
});
