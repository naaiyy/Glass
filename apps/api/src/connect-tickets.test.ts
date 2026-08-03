import { describe, expect, it } from "vite-plus/test";
import {
  digestConnectDispatchPayload,
  dispatchFrameMatchesGrant,
  issueConnectDispatchGrant,
  verifyConnectDispatchGrant,
} from "./connect-tickets.ts";

const secret = "a-strong-test-secret-that-is-at-least-32-bytes";

describe("Glass Connect tickets", () => {
  it("refuses to sign with a short configuration secret", async () => {
    await expect(
      issueConnectDispatchGrant(
        {
          capability: "file.read",
          environmentId: "environment-1",
          expiresAt: Math.floor(Date.now() / 1000) + 30,
          intentId: "intent-1",
          operationId: "operation-1",
          organizationId: "organization-1",
          projectId: "project-1",
          purpose: "request",
          requestId: "request-1",
          requestDigest: "digest-1",
          workspaceId: "workspace-1",
        },
        "short",
      ),
    ).rejects.toThrow("at least 32 bytes");
  });
  it("binds dispatch grants to the authorized execution scope", async () => {
    const now = Date.parse("2026-08-03T12:00:00.000Z");
    const grant = await issueConnectDispatchGrant(
      {
        capability: "workspace.read",
        environmentId: "environment-1",
        expiresAt: Math.floor(now / 1000) + 60,
        intentId: "intent-1",
        operationId: "operation-1",
        organizationId: "organization-1",
        projectId: "project-1",
        purpose: "request",
        requestId: "request-1",
        requestDigest: "digest-1",
        workspaceId: "workspace-1",
      },
      secret,
    );
    expect(await verifyConnectDispatchGrant(grant, secret, now)).toMatchObject({
      audience: "glass-connect-dispatch",
      capability: "workspace.read",
      environmentId: "environment-1",
      operationId: "operation-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
    });
    expect(await verifyConnectDispatchGrant(grant, secret, now + 60_000)).toBeNull();
  });

  it("rejects a signed request grant attached to a substituted machine payload", async () => {
    const payload = { operation: "file.read", path: "safe.txt", workspaceId: "workspace-1" };
    const claims = {
      audience: "glass-connect-dispatch" as const,
      capability: "file.read",
      environmentId: "environment-1",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      intentId: "operation-1",
      operationId: "operation-1",
      organizationId: "organization-1",
      projectId: "project-1",
      purpose: "request" as const,
      requestId: "request-1",
      requestDigest: await digestConnectDispatchPayload(payload),
      workspaceId: "workspace-1",
    };
    await expect(
      dispatchFrameMatchesGrant(
        {
          type: "operation.request",
          capability: "file.read",
          dispatchGrant: "signed-grant",
          operationId: "operation-1",
          requestId: "request-1",
          payload: { operation: "file.read", path: "secret.txt", workspaceId: "workspace-1" },
        },
        claims,
      ),
    ).resolves.toBe(false);
    await expect(
      dispatchFrameMatchesGrant(
        {
          type: "operation.request",
          capability: "file.read",
          dispatchGrant: "signed-grant",
          operationId: "operation-1",
          requestId: "request-1",
          payload: { ...payload, workspaceId: "workspace-2" },
        },
        claims,
      ),
    ).resolves.toBe(false);
  });

  it("requires an exact cancel grant and identifiers for cancellation", async () => {
    const claims = {
      audience: "glass-connect-dispatch" as const,
      capability: "file.read",
      environmentId: "environment-1",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      intentId: "operation-1",
      operationId: "operation-1",
      organizationId: "organization-1",
      projectId: "project-1",
      purpose: "cancel" as const,
      requestId: "request-1",
      requestDigest: "unused-for-cancel",
      workspaceId: "workspace-1",
    };
    await expect(
      dispatchFrameMatchesGrant(
        {
          type: "operation.cancel",
          dispatchGrant: "signed-grant",
          operationId: "operation-2",
          requestId: "request-1",
          reason: "Stop",
        },
        claims,
      ),
    ).resolves.toBe(false);
    await expect(
      dispatchFrameMatchesGrant(
        {
          type: "operation.cancel",
          dispatchGrant: "signed-grant",
          operationId: "operation-1",
          requestId: "request-1",
          reason: "Stop",
        },
        claims,
      ),
    ).resolves.toBe(true);
  });
});
