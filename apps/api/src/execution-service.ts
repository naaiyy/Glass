import type { BoundaryError } from "@glass/contracts/errors";
import type {
  CreateExecutionOperationRequest,
  CreateWorkspaceBindingRequest,
  ExecutionOperation,
  ExecutionOperationEvent,
  WorkspaceBinding,
} from "@glass/contracts/execution-cloud";
import {
  maxExecutionEventPayloadBytes,
  maxExecutionEventsPerOperation,
  maxExecutionResultBytes,
} from "@glass/contracts/execution-cloud";
import type { ExecutionRequest } from "@glass/contracts/execution";
import type { IsoDateTime } from "@glass/contracts/ids";
import type { ConnectNodeFrame } from "@glass/contracts/connect";
import type { Client, QueryResultRow } from "pg";
import {
  digestConnectDispatchPayload,
  type ConnectDispatchGrantClaims,
} from "./connect-tickets.ts";

export class ExecutionServiceFailure extends Error {
  readonly retryable: boolean;
  readonly code: "conflict" | "forbidden" | "invalid" | "not-found";

  constructor(
    code: "conflict" | "forbidden" | "invalid" | "not-found",
    message: string,
    retryable = false,
  ) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.name = "ExecutionServiceFailure";
  }
}

const iso = (value: Date | string | null): IsoDateTime | null =>
  value === null ? null : (new Date(value).toISOString() as IsoDateTime);

const encodedBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const transaction = async <Value>(client: Client, run: () => Promise<Value>): Promise<Value> => {
  await client.query("begin");
  try {
    const value = await run();
    await client.query("commit");
    return value;
  } catch (cause) {
    await client.query("rollback");
    throw cause;
  }
};

const operationFromRow = (
  row: QueryResultRow,
  events: readonly ExecutionOperationEvent[] = [],
): ExecutionOperation => ({
  capability: String(row.capability),
  completedAt: iso(row.completed_at as Date | string | null),
  createdAt: iso(row.created_at as Date | string)!,
  environmentId: String(row.environment_id) as ExecutionOperation["environmentId"],
  error: (row.error ?? null) as BoundaryError | null,
  events,
  lastSequence: Number(row.last_sequence),
  operationId: String(row.id) as ExecutionOperation["operationId"],
  organizationId: String(row.organization_id) as ExecutionOperation["organizationId"],
  projectId: String(row.project_id) as ExecutionOperation["projectId"],
  request: row.request as ExecutionRequest,
  requestId: String(row.request_id),
  result: row.result ?? null,
  status: row.status as ExecutionOperation["status"],
  workspaceId: String(row.workspace_id) as ExecutionOperation["workspaceId"],
});

const eventFromRow = (row: QueryResultRow): ExecutionOperationEvent => ({
  createdAt: iso(row.created_at as Date | string)!,
  event: row.event as ExecutionOperationEvent["event"],
  payload: row.payload,
  sequence: Number(row.sequence),
});

const requireMemberProjectEnvironmentBinding = async (
  client: Client,
  userId: string,
  scope: Readonly<{
    environmentId: string;
    organizationId: string;
    projectId: string;
    workspaceId: string;
  }>,
): Promise<void> => {
  const result = await client.query(
    `select 1
       from organization_members m
       join projects p on p.organization_id = m.organization_id and p.id = $3 and p.archived_at is null
       join execution_environments e on e.organization_id = m.organization_id and e.id = $4 and e.revoked_at is null
       join workspace_bindings w on w.organization_id = m.organization_id and w.project_id = p.id
         and w.environment_id = e.id and w.id = $5 and w.revoked_at is null
      where m.organization_id = $1 and m.user_id = $2 and m.removed_at is null`,
    [scope.organizationId, userId, scope.projectId, scope.environmentId, scope.workspaceId],
  );
  if (result.rows.length !== 1) {
    throw new ExecutionServiceFailure(
      "forbidden",
      "The project, environment, and workspace binding are not available to this user.",
    );
  }
};

export interface ExecutionService {
  claimDispatch(
    claims: ConnectDispatchGrantClaims,
    actorUserId: string,
    sessionId: string,
    channelId: string,
  ): Promise<boolean>;
  recordClaimedNodeFrame(
    sessionId: string,
    channelId: string,
    frame: ConnectNodeFrame,
  ): Promise<void>;
  authorizeDispatch(claims: ConnectDispatchGrantClaims): Promise<boolean>;
  createWorkspaceBinding(
    userId: string,
    request: CreateWorkspaceBindingRequest,
    displayName: string,
  ): Promise<WorkspaceBinding>;
  revokeWorkspaceBinding(
    userId: string,
    environmentId: string,
    workspaceId: string,
  ): Promise<WorkspaceBinding>;
  listWorkspaceBindings(
    userId: string,
    organizationId: string,
    projectId: string,
  ): Promise<readonly WorkspaceBinding[]>;
  authorizeEnvironmentAdmin(
    userId: string,
    organizationId: string,
    environmentId: string,
  ): Promise<boolean>;
  createOperation(
    userId: string,
    request: CreateExecutionOperationRequest,
  ): Promise<ExecutionOperation>;
  getOperation(
    userId: string,
    operationId: string,
    after: number,
    limit: number,
  ): Promise<ExecutionOperation>;
  cancelOperation(userId: string, operationId: string): Promise<ExecutionOperation>;
  invalidateEnvironment(environmentId: string): Promise<void>;
  recordNodeFrame(claims: ConnectDispatchGrantClaims, frame: ConnectNodeFrame): Promise<void>;
}

export const createPostgresExecutionService = (client: Client): ExecutionService => ({
  claimDispatch: async (claims, actorUserId, sessionId, channelId) =>
    transaction(client, async () => {
      const locked = await client.query(
        `select o.* from execution_operations o
         join organization_members m on m.organization_id = o.organization_id
           and m.user_id = o.actor_user_id and m.removed_at is null
         join projects p on p.id = o.project_id and p.organization_id = o.organization_id and p.archived_at is null
         join execution_environments e on e.id = o.environment_id and e.organization_id = o.organization_id and e.revoked_at is null
         join workspace_bindings w on w.environment_id = o.environment_id and w.id = o.workspace_id
           and w.organization_id = o.organization_id and w.project_id = o.project_id and w.revoked_at is null
         where o.id = $1 and o.actor_user_id = $2 and o.organization_id = $3 and o.project_id = $4
           and o.environment_id = $5 and o.workspace_id = $6 and o.request_id = $7 and o.capability = $8
           and o.status in ('queued','running','cancelling') for update of o`,
        [
          claims.operationId,
          actorUserId,
          claims.organizationId,
          claims.projectId,
          claims.environmentId,
          claims.workspaceId,
          claims.requestId,
          claims.capability,
        ],
      );
      const row = locked.rows[0];
      if (
        row === undefined ||
        claims.intentId !== claims.operationId ||
        (claims.purpose === "request" &&
          claims.requestDigest !== (await digestConnectDispatchPayload(row.request))) ||
        (claims.purpose === "cancel" && row.status !== "cancelling")
      )
        return false;
      if (row.dispatch_session_id !== null) {
        if (claims.purpose === "cancel") return true;
        return false;
      }
      await client.query(
        `update execution_operations set status = case when status = 'queued' then 'running' else status end,
          dispatch_session_id = $2, dispatch_channel_id = $3, dispatch_claimed_at = now(),
          updated_at = now() where id = $1`,
        [claims.operationId, sessionId, channelId],
      );
      return true;
    }),

  recordClaimedNodeFrame: async (sessionId, channelId, frame) => {
    const result = await client.query(
      `select * from execution_operations where id = $1 and dispatch_session_id = $2 and dispatch_channel_id = $3`,
      [frame.operationId, sessionId, channelId],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new ExecutionServiceFailure(
        "forbidden",
        "The node frame has no durable dispatch claim.",
      );
    const grant: ConnectDispatchGrantClaims &
      Readonly<{ dispatchSessionId: string; dispatchChannelId: string }> = {
      audience: "glass-connect-dispatch",
      capability: String(row.capability),
      environmentId: String(row.environment_id),
      expiresAt: Math.floor(Date.now() / 1000) + 1,
      intentId: String(row.id),
      operationId: String(row.id),
      organizationId: String(row.organization_id),
      projectId: String(row.project_id),
      purpose: "request",
      requestId: String(row.request_id),
      requestDigest: await digestConnectDispatchPayload(row.request),
      workspaceId: String(row.workspace_id),
      dispatchSessionId: sessionId,
      dispatchChannelId: channelId,
    };
    await createPostgresExecutionService(client).recordNodeFrame(grant, frame);
  },

  authorizeDispatch: async (claims) => {
    const result = await client.query(
      `select 1 from execution_operations o
       join execution_environments e on e.id = o.environment_id and e.organization_id = o.organization_id and e.revoked_at is null
       join workspace_bindings w on w.environment_id = o.environment_id and w.id = o.workspace_id
         and w.organization_id = o.organization_id and w.project_id = o.project_id and w.revoked_at is null
       where o.id = $1 and o.organization_id = $2 and o.project_id = $3
         and o.environment_id = $4 and o.workspace_id = $5 and o.request_id = $6
         and o.capability = $7 and o.status in ('queued','running','cancelling')`,
      [
        claims.operationId,
        claims.organizationId,
        claims.projectId,
        claims.environmentId,
        claims.workspaceId,
        claims.requestId,
        claims.capability,
      ],
    );
    return result.rows.length === 1;
  },

  createWorkspaceBinding: (userId, request, displayName) =>
    transaction(client, async () => {
      const authorized = await client.query(
        `select 1 from organization_members m
        join projects p on p.organization_id = m.organization_id and p.id = $3 and p.archived_at is null
        join execution_environments e on e.organization_id = m.organization_id and e.id = $4 and e.revoked_at is null
       where m.organization_id = $1 and m.user_id = $2 and m.removed_at is null
         and m.role in ('owner', 'admin')`,
        [request.organizationId, userId, request.projectId, request.environmentId],
      );
      if (authorized.rows.length !== 1)
        throw new ExecutionServiceFailure(
          "forbidden",
          "The workspace binding scope is not authorized.",
        );
      const result = await client.query(
        `insert into workspace_bindings (id, organization_id, project_id, environment_id, display_name, created_by_user_id)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (environment_id, id) do update set
         organization_id = excluded.organization_id,
         project_id = excluded.project_id,
         display_name = excluded.display_name,
         created_by_user_id = excluded.created_by_user_id,
         created_at = now(), revoked_at = null
       returning *`,
        [
          request.workspaceId,
          request.organizationId,
          request.projectId,
          request.environmentId,
          displayName,
          userId,
        ],
      );
      const row = result.rows[0]!;
      return {
        id: String(row.id) as WorkspaceBinding["id"],
        displayName: String(row.display_name),
        organizationId: String(row.organization_id) as WorkspaceBinding["organizationId"],
        projectId: String(row.project_id) as WorkspaceBinding["projectId"],
        environmentId: String(row.environment_id) as WorkspaceBinding["environmentId"],
        createdAt: iso(row.created_at as Date | string)!,
        revokedAt: iso(row.revoked_at as Date | string | null),
      };
    }),

  revokeWorkspaceBinding: (userId, environmentId, workspaceId) =>
    transaction(client, async () => {
      const result = await client.query(
        `update workspace_bindings w set revoked_at = coalesce(w.revoked_at, now())
       where w.environment_id = $1 and w.id = $2 and exists (
         select 1 from organization_members m where m.organization_id = w.organization_id
           and m.user_id = $3 and m.removed_at is null and m.role in ('owner', 'admin')
       ) returning *`,
        [environmentId, workspaceId, userId],
      );
      if (result.rows.length !== 1)
        throw new ExecutionServiceFailure("forbidden", "The workspace binding cannot be revoked.");
      const row = result.rows[0]!;
      await client.query(
        `update execution_operations set status = 'failed', completed_at = now(), updated_at = now(),
          error = '{"code":"EXECUTION_UNAVAILABLE","message":"The workspace binding was revoked.","retryable":false}'::jsonb
         where environment_id = $1 and workspace_id = $2 and status in ('queued','running','cancelling')`,
        [environmentId, workspaceId],
      );
      return {
        id: String(row.id) as WorkspaceBinding["id"],
        displayName: String(row.display_name),
        organizationId: String(row.organization_id) as WorkspaceBinding["organizationId"],
        projectId: String(row.project_id) as WorkspaceBinding["projectId"],
        environmentId: String(row.environment_id) as WorkspaceBinding["environmentId"],
        createdAt: iso(row.created_at as Date | string)!,
        revokedAt: iso(row.revoked_at as Date | string | null),
      };
    }),

  listWorkspaceBindings: async (userId, organizationId, projectId) => {
    const result = await client.query(
      `select w.* from workspace_bindings w join organization_members m
        on m.organization_id = w.organization_id and m.user_id = $2 and m.removed_at is null
       where w.organization_id = $1 and w.project_id = $3 and w.revoked_at is null
       order by w.display_name asc, w.environment_id asc, w.id asc`,
      [organizationId, userId, projectId],
    );
    return result.rows.map((row) => ({
      id: String(row.id) as WorkspaceBinding["id"],
      displayName: String(row.display_name),
      organizationId: String(row.organization_id) as WorkspaceBinding["organizationId"],
      projectId: String(row.project_id) as WorkspaceBinding["projectId"],
      environmentId: String(row.environment_id) as WorkspaceBinding["environmentId"],
      createdAt: iso(row.created_at as Date | string)!,
      revokedAt: iso(row.revoked_at as Date | string | null),
    }));
  },

  authorizeEnvironmentAdmin: async (userId, organizationId, environmentId) => {
    const result = await client.query(
      `select 1 from organization_members m join execution_environments e
        on e.organization_id = m.organization_id and e.id = $3 and e.revoked_at is null
       where m.organization_id = $1 and m.user_id = $2 and m.removed_at is null and m.role in ('owner','admin')`,
      [organizationId, userId, environmentId],
    );
    return result.rows.length === 1;
  },

  createOperation: (userId, request) =>
    transaction(client, async () => {
      if (request.request.operation === "workspace.list") {
        throw new ExecutionServiceFailure(
          "forbidden",
          "Workspace discovery cannot run through a project-scoped execution grant.",
        );
      }
      if ("workspaceId" in request.request && request.request.workspaceId !== request.workspaceId) {
        throw new ExecutionServiceFailure(
          "invalid",
          "The execution request workspace does not match its authorized binding.",
        );
      }
      await requireMemberProjectEnvironmentBinding(client, userId, request);
      const capability = request.request.operation;
      const existing = await client.query(
        `select * from execution_operations where organization_id = $1 and actor_user_id = $2 and request_id = $3 for update`,
        [request.organizationId, userId, request.requestId],
      );
      if (existing.rows[0] !== undefined) {
        const operation = operationFromRow(existing.rows[0]);
        const same =
          operation.operationId === request.operationId &&
          operation.projectId === request.projectId &&
          operation.environmentId === request.environmentId &&
          operation.workspaceId === request.workspaceId &&
          canonicalJson(operation.request) === canonicalJson(request.request);
        if (!same)
          throw new ExecutionServiceFailure(
            "conflict",
            "The idempotency key was already used for a different execution request.",
          );
        return operation;
      }
      const result = await client.query(
        `insert into execution_operations
        (id, organization_id, project_id, environment_id, workspace_id, actor_user_id, request_id, capability, operation, request)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [
          request.operationId,
          request.organizationId,
          request.projectId,
          request.environmentId,
          request.workspaceId,
          userId,
          request.requestId,
          capability,
          request.request.operation,
          request.request,
        ],
      );
      return operationFromRow(result.rows[0]!);
    }),

  getOperation: async (userId, operationId, after, limit) => {
    const result = await client.query(
      `select o.* from execution_operations o join organization_members m
        on m.organization_id = o.organization_id and m.user_id = $2 and m.removed_at is null
       where o.id = $1`,
      [operationId, userId],
    );
    if (result.rows[0] === undefined)
      throw new ExecutionServiceFailure("not-found", "The execution operation does not exist.");
    const events = await client.query(
      `select * from execution_operation_events where operation_id = $1 and sequence > $2 order by sequence asc limit $3`,
      [operationId, after, limit],
    );
    return operationFromRow(result.rows[0], events.rows.map(eventFromRow));
  },

  cancelOperation: (userId, operationId) =>
    transaction(client, async () => {
      const result = await client.query(
        `update execution_operations o set
         status = case when o.dispatch_session_id is null then 'cancelled'::execution_operation_status else 'cancelling'::execution_operation_status end,
         completed_at = case when o.dispatch_session_id is null then now() else o.completed_at end,
         updated_at = now()
       where o.id = $1 and o.status in ('queued','running') and exists (
         select 1 from organization_members m where m.organization_id = o.organization_id
           and m.user_id = $2 and m.removed_at is null
       ) returning *`,
        [operationId, userId],
      );
      if (result.rows[0] === undefined) {
        const current = await client.query(
          `select o.* from execution_operations o join organization_members m
            on m.organization_id = o.organization_id and m.user_id = $2 and m.removed_at is null
           where o.id = $1`,
          [operationId, userId],
        );
        if (current.rows[0] === undefined)
          throw new ExecutionServiceFailure("not-found", "The execution operation does not exist.");
        const operation = operationFromRow(current.rows[0]);
        if (["succeeded", "failed", "cancelled"].includes(operation.status)) return operation;
        throw new ExecutionServiceFailure(
          "forbidden",
          "The execution operation cannot be cancelled.",
        );
      }
      return operationFromRow(result.rows[0]);
    }),

  invalidateEnvironment: async (environmentId) => {
    await client.query(
      `update execution_operations set status = 'failed', completed_at = now(), updated_at = now(),
        error = '{"code":"EXECUTION_UNAVAILABLE","message":"The execution environment was revoked.","retryable":false}'::jsonb
       where environment_id = $1 and status in ('queued','running','cancelling')`,
      [environmentId],
    );
  },

  recordNodeFrame: (claims, frame) =>
    transaction(client, async () => {
      if (
        claims.operationId !== frame.operationId ||
        claims.requestId !== frame.requestId ||
        claims.intentId !== frame.operationId
      ) {
        throw new ExecutionServiceFailure(
          "forbidden",
          "The node frame is outside its dispatch grant.",
        );
      }
      const locked = await client.query(
        `select o.*, e.revoked_at as environment_revoked_at, w.revoked_at as binding_revoked_at
           from execution_operations o
           join execution_environments e on e.organization_id = o.organization_id and e.id = o.environment_id
           join workspace_bindings w on w.organization_id = o.organization_id and w.project_id = o.project_id
             and w.environment_id = o.environment_id and w.id = o.workspace_id
          where o.id = $1 for update of o, e, w`,
        [frame.operationId],
      );
      const row = locked.rows[0];
      if (
        row === undefined ||
        row.organization_id !== claims.organizationId ||
        row.project_id !== claims.projectId ||
        row.environment_id !== claims.environmentId ||
        row.workspace_id !== claims.workspaceId ||
        row.capability !== claims.capability ||
        row.environment_revoked_at !== null ||
        row.binding_revoked_at !== null ||
        ("dispatchSessionId" in claims && row.dispatch_session_id !== claims.dispatchSessionId) ||
        ("dispatchChannelId" in claims && row.dispatch_channel_id !== claims.dispatchChannelId)
      ) {
        throw new ExecutionServiceFailure(
          "forbidden",
          "The dispatch grant does not match the durable execution intent.",
        );
      }
      if (
        frame.type === "operation.error" &&
        (row.status === "failed" || row.status === "cancelled")
      ) {
        if (canonicalJson(row.error) === canonicalJson(frame.error)) return;
        throw new ExecutionServiceFailure(
          "conflict",
          "The node replayed a different terminal execution error.",
        );
      }
      const nextSequence =
        frame.type === "operation.event" ? frame.sequence : Number(row.last_sequence) + 1;
      if (nextSequence < 0 || nextSequence >= maxExecutionEventsPerOperation)
        throw new ExecutionServiceFailure("invalid", "Execution event sequence exceeds its bound.");
      const event = frame.type === "operation.error" ? "error" : frame.event;
      const payload = frame.type === "operation.error" ? frame.error : frame.payload;
      const bound =
        event === "result"
          ? maxExecutionResultBytes
          : event === "error"
            ? 16_384
            : maxExecutionEventPayloadBytes;
      if (encodedBytes(payload) > bound)
        throw new ExecutionServiceFailure("invalid", "Execution event payload exceeds its bound.");
      const prior = await client.query(
        `select event, payload from execution_operation_events where operation_id = $1 and sequence = $2`,
        [frame.operationId, nextSequence],
      );
      if (prior.rows[0] !== undefined) {
        if (
          prior.rows[0].event !== event ||
          canonicalJson(prior.rows[0].payload) !== canonicalJson(payload)
        ) {
          throw new ExecutionServiceFailure(
            "conflict",
            "The node replayed an execution sequence with different content.",
          );
        }
        return;
      }
      if (nextSequence !== Number(row.last_sequence) + 1)
        throw new ExecutionServiceFailure("conflict", "Execution events must be contiguous.", true);
      if (["succeeded", "failed", "cancelled"].includes(String(row.status)))
        throw new ExecutionServiceFailure(
          "conflict",
          "The execution operation is already terminal.",
        );
      await client.query(
        `insert into execution_operation_events (operation_id, sequence, event, payload) values ($1,$2,$3,$4)`,
        [frame.operationId, nextSequence, event, payload],
      );
      const terminalStatus =
        event === "result"
          ? "succeeded"
          : event === "error"
            ? (payload as BoundaryError).code === "EXECUTION_CANCELLED"
              ? "cancelled"
              : "failed"
            : null;
      const result =
        event === "result" && typeof payload === "object" && payload !== null && "value" in payload
          ? payload.value
          : null;
      await client.query(
        `update execution_operations set last_sequence = $2,
        status = coalesce($3::execution_operation_status, 'running'::execution_operation_status),
        started_at = coalesce(started_at, now()),
        completed_at = case when $3::text is null then completed_at else now() end,
        result = case when $3::text = 'succeeded' then $4 else result end,
        error = case when $3::text in ('failed','cancelled') then $5 else error end,
        updated_at = now() where id = $1`,
        [
          frame.operationId,
          nextSequence,
          terminalStatus,
          result,
          event === "error" ? payload : null,
        ],
      );
    }),
});
