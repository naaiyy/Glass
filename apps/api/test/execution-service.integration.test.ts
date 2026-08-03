import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  digestConnectDispatchPayload,
  type ConnectDispatchGrantClaims,
} from "../src/connect-tickets.ts";
import {
  createPostgresExecutionService,
  ExecutionServiceFailure,
} from "../src/execution-service.ts";
import type {
  CreateExecutionOperationRequest,
  CreateWorkspaceBindingRequest,
} from "@glass/contracts/execution-cloud";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseName = databaseUrl === undefined ? "" : new URL(databaseUrl).pathname.slice(1);
const integration =
  databaseUrl !== undefined && databaseName.endsWith("_test") ? describe : describe.skip;

const userId = "10000000-0000-4000-8000-000000000011";
const outsiderId = "10000000-0000-4000-8000-000000000012";
const memberId = "10000000-0000-4000-8000-000000000013";
const organizationId = "20000000-0000-4000-8000-000000000011";
const projectId = "30000000-0000-4000-8000-000000000011";
const environmentId = "40000000-0000-4000-8000-000000000011";
const workspaceId = "50000000-0000-4000-8000-000000000011";
const operationId = "60000000-0000-4000-8000-000000000011";

integration("durable execution orchestration", () => {
  const client = new Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    await client.connect();
    await client.query("drop schema public cascade; create schema public");
    const migrationRoot = resolve(import.meta.dirname, "../../../infra/cloud/migrations/postgres");
    const migrationFiles = (await readdir(migrationRoot))
      .filter((file) => /^\d{4}_.+\.sql$/u.test(file))
      .sort();
    for (const migrationFile of migrationFiles) {
      // eslint-disable-next-line no-await-in-loop
      const migration = await readFile(resolve(migrationRoot, migrationFile), "utf8");
      // eslint-disable-next-line no-await-in-loop
      await client.query(migration.replaceAll("--> statement-breakpoint", ""));
    }
    await client.query(
      `insert into "user" (id,name,email,email_verified,created_at,updated_at) values
       ($1,'Owner','execution-owner@glass.test',true,now(),now()),
       ($2,'Outsider','execution-outsider@glass.test',true,now(),now()),
       ($3,'Member','execution-member@glass.test',true,now(),now())`,
      [userId, outsiderId, memberId],
    );
    await client.query(
      `insert into organizations (id,name,slug,created_by_user_id) values ($1,'Execution','execution-test',$2)`,
      [organizationId, userId],
    );
    await client.query(
      `insert into organization_members (organization_id,user_id,role) values ($1,$2,'owner')`,
      [organizationId, userId],
    );
    await client.query(
      `insert into organization_members (organization_id,user_id,role) values ($1,$2,'member')`,
      [organizationId, memberId],
    );
    await client.query(
      `insert into projects (id,organization_id,name,created_by_user_id) values ($1,$2,'Project',$3)`,
      [projectId, organizationId, userId],
    );
    await client.query(
      `insert into execution_environments (id,organization_id,display_name,platform,public_key,created_by_user_id)
       values ($1,$2,'Node','linux','AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',$3)`,
      [environmentId, organizationId, userId],
    );
  });

  afterAll(() => client.end());

  it("authorizes bindings and durably reconciles idempotent node events", async () => {
    const service = createPostgresExecutionService(client);
    const binding: CreateWorkspaceBindingRequest = {
      environmentId: environmentId as CreateWorkspaceBindingRequest["environmentId"],
      organizationId: organizationId as CreateWorkspaceBindingRequest["organizationId"],
      projectId: projectId as CreateWorkspaceBindingRequest["projectId"],
      workspaceId: workspaceId as CreateWorkspaceBindingRequest["workspaceId"],
    };
    await expect(
      service.createWorkspaceBinding(outsiderId, binding, "Untrusted client name"),
    ).rejects.toBeInstanceOf(ExecutionServiceFailure);
    await expect(
      service.createWorkspaceBinding(memberId, binding, "Member workspace"),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      service.createWorkspaceBinding(userId, binding, "Advertised workspace"),
    ).resolves.toMatchObject({ displayName: "Advertised workspace" });
    await expect(
      service.createOperation(userId, {
        ...binding,
        operationId:
          "60000000-0000-4000-8000-000000000099" as CreateExecutionOperationRequest["operationId"],
        requestId: "workspace-discovery",
        request: { operation: "workspace.list" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const request: CreateExecutionOperationRequest = {
      ...binding,
      operationId: operationId as CreateExecutionOperationRequest["operationId"],
      requestId: "read-file-1",
      request: { operation: "file.read", workspaceId: binding.workspaceId, path: "README.md" },
    };
    const created = await service.createOperation(userId, request);
    expect(created.status).toBe("queued");
    await expect(service.createOperation(userId, request)).resolves.toMatchObject({ operationId });
    await expect(
      service.createOperation(userId, {
        ...request,
        request: { ...request.request, path: "other" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const claims: ConnectDispatchGrantClaims = {
      audience: "glass-connect-dispatch",
      capability: "file.read",
      environmentId,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      intentId: operationId,
      operationId,
      organizationId,
      projectId,
      purpose: "request",
      requestId: request.requestId,
      requestDigest: "not-used-by-persistence",
      workspaceId,
    };
    await expect(
      service.recordNodeFrame(
        { ...claims, projectId: "30000000-0000-4000-8000-000000000099" },
        {
          type: "operation.error",
          requestId: request.requestId,
          operationId,
          error: { code: "EXECUTION_FAILED", message: "mismatch", retryable: false },
        },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const progress = {
      type: "operation.event" as const,
      requestId: request.requestId,
      operationId,
      event: "progress" as const,
      sequence: 0,
      payload: { stream: "stdout", data: "reading" },
    };
    await service.recordNodeFrame(claims, progress);
    await service.recordNodeFrame(claims, progress);
    await service.recordNodeFrame(claims, {
      type: "operation.event",
      requestId: request.requestId,
      operationId,
      event: "result",
      sequence: 1,
      payload: { status: "succeeded", value: { contentBase64: "Z2xhc3M=" } },
    });

    const reconciled = await service.getOperation(userId, operationId, -1, 100);
    expect(reconciled).toMatchObject({
      status: "succeeded",
      lastSequence: 1,
      result: { contentBase64: "Z2xhc3M=" },
    });
    expect(reconciled.events).toHaveLength(2);
    await expect(
      service.recordNodeFrame(claims, {
        ...progress,
        payload: { stream: "stdout", data: "tampered" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const cancellationId = "60000000-0000-4000-8000-000000000012";
    const cancelling = await service.createOperation(userId, {
      ...request,
      operationId: cancellationId as CreateExecutionOperationRequest["operationId"],
      requestId: "read-file-2",
    });
    await expect(service.cancelOperation(userId, cancelling.operationId)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(service.getOperation(userId, cancellationId, -1, 100)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(service.cancelOperation(userId, cancellationId)).resolves.toMatchObject({
      status: "cancelled",
    });

    const runningCancellationId = "60000000-0000-4000-8000-000000000014";
    const runningCancellation = await service.createOperation(userId, {
      ...request,
      operationId: runningCancellationId as CreateExecutionOperationRequest["operationId"],
      requestId: "read-file-running-cancel",
    });
    const cancellationClaims = {
      ...claims,
      operationId: runningCancellationId,
      intentId: runningCancellationId,
      requestId: "read-file-running-cancel",
      requestDigest: await digestConnectDispatchPayload(request.request),
    };
    await expect(
      service.claimDispatch(cancellationClaims, userId, "session-cancel", "channel-cancel"),
    ).resolves.toBe(true);
    await expect(
      service.cancelOperation(userId, runningCancellation.operationId),
    ).resolves.toMatchObject({ status: "cancelling" });
    await service.recordNodeFrame(cancellationClaims, {
      type: "operation.error",
      requestId: "read-file-running-cancel",
      operationId: runningCancellationId,
      error: { code: "EXECUTION_CANCELLED", message: "Cancelled", retryable: false },
    });
    await service.recordNodeFrame(cancellationClaims, {
      type: "operation.error",
      requestId: "read-file-running-cancel",
      operationId: runningCancellationId,
      error: { code: "EXECUTION_CANCELLED", message: "Cancelled", retryable: false },
    });
    await expect(
      service.recordNodeFrame(cancellationClaims, {
        type: "operation.error",
        requestId: "read-file-running-cancel",
        operationId: runningCancellationId,
        error: { code: "EXECUTION_CANCELLED", message: "Different", retryable: false },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      service.getOperation(userId, runningCancellationId, -1, 100),
    ).resolves.toMatchObject({ status: "cancelled" });

    const revokedOperationId = "60000000-0000-4000-8000-000000000013";
    await service.createOperation(userId, {
      ...request,
      operationId: revokedOperationId as CreateExecutionOperationRequest["operationId"],
      requestId: "read-file-3",
    });
    const revokedClaims = {
      ...claims,
      operationId: revokedOperationId,
      intentId: revokedOperationId,
      requestId: "read-file-3",
    };
    await expect(service.authorizeDispatch(revokedClaims)).resolves.toBe(true);
    await service.revokeWorkspaceBinding(userId, environmentId, workspaceId);
    await expect(service.authorizeDispatch(revokedClaims)).resolves.toBe(false);
    await expect(
      service.recordNodeFrame(revokedClaims, {
        type: "operation.error",
        requestId: "read-file-3",
        operationId: revokedOperationId,
        error: { code: "EXECUTION_FAILED", message: "late reply", retryable: false },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
