import type { BoundaryError } from "./errors.ts";
import { decodeExecutionRequest, type ExecutionRequest } from "./execution.ts";
import type {
  ExecutionEnvironmentId,
  ExecutionOperationId,
  IsoDateTime,
  OrganizationId,
  ProjectId,
  WorkspaceId,
} from "./ids.ts";
import { decodeId, decodeIsoDateTime } from "./ids.ts";
import {
  combine,
  decodeFailure,
  decodeInteger,
  decodeRecord,
  decodeString,
  decodeSuccess,
  required,
  type DecodeResult,
} from "./validation.ts";

export const maxExecutionEventPayloadBytes = 131_072;
export const maxExecutionEventsPerOperation = 2_048;
export const maxExecutionResultBytes = 1_048_576;

export type WorkspaceBinding = Readonly<{
  createdAt: IsoDateTime;
  displayName: string;
  environmentId: ExecutionEnvironmentId;
  id: WorkspaceId;
  organizationId: OrganizationId;
  projectId: ProjectId;
  revokedAt: IsoDateTime | null;
}>;

export type CreateWorkspaceBindingRequest = Readonly<{
  environmentId: ExecutionEnvironmentId;
  organizationId: OrganizationId;
  projectId: ProjectId;
  workspaceId: WorkspaceId;
}>;

export type CreateExecutionOperationRequest = Readonly<{
  environmentId: ExecutionEnvironmentId;
  operationId: ExecutionOperationId;
  organizationId: OrganizationId;
  projectId: ProjectId;
  request: ExecutionRequest;
  requestId: string;
  workspaceId: WorkspaceId;
}>;

export type ExecutionOperationStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ExecutionOperationEvent = Readonly<{
  createdAt: IsoDateTime;
  event: "progress" | "result" | "error";
  payload: unknown;
  sequence: number;
}>;

export type ExecutionOperation = Readonly<{
  capability: string;
  completedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  environmentId: ExecutionEnvironmentId;
  error: BoundaryError | null;
  events: readonly ExecutionOperationEvent[];
  lastSequence: number;
  operationId: ExecutionOperationId;
  organizationId: OrganizationId;
  projectId: ProjectId;
  request: ExecutionRequest;
  requestId: string;
  result: unknown | null;
  status: ExecutionOperationStatus;
  workspaceId: WorkspaceId;
}>;

export type ExecutionDispatch = Readonly<{
  dispatchGrant: string;
  operation: ExecutionOperation;
}>;

const rejectUnknown = (
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
): DecodeResult<true> => {
  const keys = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !keys.has(key));
  return unknown === undefined
    ? decodeSuccess(true)
    : decodeFailure(`${path}.${unknown}`, "unknown_variant", "Unknown response field.");
};

const nullableDate = (input: unknown, path: string) =>
  input === null ? decodeSuccess<null>(null) : decodeIsoDateTime(input, path);

const boundedJson = (input: unknown, path: string, maxBytes: number): DecodeResult<unknown> => {
  try {
    const encoded = JSON.stringify(input);
    return encoded !== undefined && new TextEncoder().encode(encoded).byteLength <= maxBytes
      ? decodeSuccess(input)
      : decodeFailure(path, "out_of_range", "JSON value exceeds the accepted bound.");
  } catch {
    return decodeFailure(path, "invalid_format", "Expected a JSON-serializable value.");
  }
};

export const decodeWorkspaceBinding = (input: unknown): DecodeResult<WorkspaceBinding> => {
  const record = decodeRecord(input, "$workspaceBinding");
  if (!record.ok) return record;
  const keys = rejectUnknown(
    record.value,
    ["createdAt", "displayName", "environmentId", "id", "organizationId", "projectId", "revokedAt"],
    "$workspaceBinding",
  );
  if (!keys.ok) return keys;
  const createdAt = decodeIsoDateTime(record.value.createdAt, "$workspaceBinding.createdAt");
  const displayName = decodeString(record.value.displayName, "$workspaceBinding.displayName", {
    minLength: 1,
    maxLength: 120,
  });
  const environmentId = decodeId<ExecutionEnvironmentId>(
    record.value.environmentId,
    "$workspaceBinding.environmentId",
  );
  const id = decodeId<WorkspaceId>(record.value.id, "$workspaceBinding.id");
  const organizationId = decodeId<OrganizationId>(
    record.value.organizationId,
    "$workspaceBinding.organizationId",
  );
  const projectId = decodeId<ProjectId>(record.value.projectId, "$workspaceBinding.projectId");
  const revokedAt = nullableDate(record.value.revokedAt, "$workspaceBinding.revokedAt");
  return combine(
    [createdAt, displayName, environmentId, id, organizationId, projectId, revokedAt],
    () => ({
      createdAt: createdAt.ok ? createdAt.value : ("" as IsoDateTime),
      displayName: displayName.ok ? displayName.value : "",
      environmentId: environmentId.ok ? environmentId.value : ("" as ExecutionEnvironmentId),
      id: id.ok ? id.value : ("" as WorkspaceId),
      organizationId: organizationId.ok ? organizationId.value : ("" as OrganizationId),
      projectId: projectId.ok ? projectId.value : ("" as ProjectId),
      revokedAt: revokedAt.ok ? revokedAt.value : null,
    }),
  );
};

export const decodeWorkspaceBindingList = (
  input: unknown,
): DecodeResult<readonly WorkspaceBinding[]> => {
  if (!Array.isArray(input) || input.length > 1_000)
    return decodeFailure(
      "$workspaceBindings",
      "out_of_range",
      "Expected at most 1,000 workspace bindings.",
    );
  const bindings: WorkspaceBinding[] = [];
  for (const value of input) {
    const binding = decodeWorkspaceBinding(value);
    if (!binding.ok) return binding;
    bindings.push(binding.value);
  }
  return decodeSuccess(bindings);
};

const decodeBoundaryError = (input: unknown): DecodeResult<BoundaryError> => {
  const record = decodeRecord(input, "$executionOperation.error");
  if (!record.ok) return record;
  const keys = rejectUnknown(
    record.value,
    ["code", "commandId", "currentVersion", "message", "retryable"],
    "$executionOperation.error",
  );
  if (!keys.ok) return keys;
  const code = decodeString(record.value.code, "$executionOperation.error.code", {
    minLength: 1,
    maxLength: 64,
  });
  const message = decodeString(record.value.message, "$executionOperation.error.message", {
    minLength: 1,
    maxLength: 2_000,
  });
  const retryable =
    typeof record.value.retryable === "boolean"
      ? decodeSuccess(record.value.retryable)
      : decodeFailure("$executionOperation.error.retryable", "invalid_type", "Expected a boolean.");
  if (!code.ok) return code;
  if (!message.ok) return message;
  if (!retryable.ok) return retryable;
  return decodeSuccess({
    code: code.value as BoundaryError["code"],
    message: message.value,
    retryable: retryable.value,
    ...(typeof record.value.commandId === "string"
      ? { commandId: record.value.commandId as never }
      : {}),
    ...(Number.isSafeInteger(record.value.currentVersion)
      ? { currentVersion: record.value.currentVersion as number }
      : {}),
  });
};

export const decodeExecutionOperation = (input: unknown): DecodeResult<ExecutionOperation> => {
  const record = decodeRecord(input, "$executionOperation");
  if (!record.ok) return record;
  const keys = rejectUnknown(
    record.value,
    [
      "capability",
      "completedAt",
      "createdAt",
      "environmentId",
      "error",
      "events",
      "lastSequence",
      "operationId",
      "organizationId",
      "projectId",
      "request",
      "requestId",
      "result",
      "status",
      "workspaceId",
    ],
    "$executionOperation",
  );
  if (!keys.ok) return keys;
  const capability = decodeString(record.value.capability, "$executionOperation.capability", {
    minLength: 1,
    maxLength: 64,
  });
  const completedAt = nullableDate(record.value.completedAt, "$executionOperation.completedAt");
  const createdAt = decodeIsoDateTime(record.value.createdAt, "$executionOperation.createdAt");
  const environmentId = decodeId<ExecutionEnvironmentId>(
    record.value.environmentId,
    "$executionOperation.environmentId",
  );
  const error =
    record.value.error === null
      ? decodeSuccess<null>(null)
      : decodeBoundaryError(record.value.error);
  const lastSequence = decodeInteger(
    record.value.lastSequence,
    "$executionOperation.lastSequence",
    { min: -1, max: maxExecutionEventsPerOperation - 1 },
  );
  const operationId = decodeId<ExecutionOperationId>(
    record.value.operationId,
    "$executionOperation.operationId",
  );
  const organizationId = decodeId<OrganizationId>(
    record.value.organizationId,
    "$executionOperation.organizationId",
  );
  const projectId = decodeId<ProjectId>(record.value.projectId, "$executionOperation.projectId");
  const request = decodeExecutionRequest(record.value.request);
  const requestId = decodeString(record.value.requestId, "$executionOperation.requestId", {
    minLength: 1,
    maxLength: 128,
  });
  const result =
    record.value.result === null
      ? decodeSuccess<null>(null)
      : boundedJson(record.value.result, "$executionOperation.result", maxExecutionResultBytes);
  const statuses: readonly ExecutionOperationStatus[] = [
    "queued",
    "running",
    "cancelling",
    "succeeded",
    "failed",
    "cancelled",
  ];
  const status = statuses.includes(record.value.status as ExecutionOperationStatus)
    ? decodeSuccess(record.value.status as ExecutionOperationStatus)
    : decodeFailure("$executionOperation.status", "unknown_variant", "Unknown execution status.");
  const workspaceId = decodeId<WorkspaceId>(
    record.value.workspaceId,
    "$executionOperation.workspaceId",
  );
  if (
    !Array.isArray(record.value.events) ||
    record.value.events.length > maxExecutionEventsPerOperation
  )
    return decodeFailure(
      "$executionOperation.events",
      "out_of_range",
      "Too many execution events.",
    );
  const events: ExecutionOperationEvent[] = [];
  for (const [index, value] of record.value.events.entries()) {
    const path = `$executionOperation.events[${index}]`;
    const eventRecord = decodeRecord(value, path);
    if (!eventRecord.ok) return eventRecord;
    const eventKeys = rejectUnknown(
      eventRecord.value,
      ["createdAt", "event", "payload", "sequence"],
      path,
    );
    if (!eventKeys.ok) return eventKeys;
    const eventCreatedAt = decodeIsoDateTime(eventRecord.value.createdAt, `${path}.createdAt`);
    const event =
      eventRecord.value.event === "progress" ||
      eventRecord.value.event === "result" ||
      eventRecord.value.event === "error"
        ? decodeSuccess<ExecutionOperationEvent["event"]>(eventRecord.value.event)
        : decodeFailure(`${path}.event`, "unknown_variant", "Unknown execution event.");
    const payload = boundedJson(
      eventRecord.value.payload,
      `${path}.payload`,
      maxExecutionEventPayloadBytes,
    );
    const sequence = decodeInteger(eventRecord.value.sequence, `${path}.sequence`, {
      min: 0,
      max: maxExecutionEventsPerOperation - 1,
    });
    if (!eventCreatedAt.ok) return eventCreatedAt;
    if (!event.ok) return event;
    if (!payload.ok) return payload;
    if (!sequence.ok) return sequence;
    events.push({
      createdAt: eventCreatedAt.value,
      event: event.value,
      payload: payload.value,
      sequence: sequence.value,
    });
  }
  return combine(
    [
      capability,
      completedAt,
      createdAt,
      environmentId,
      error,
      lastSequence,
      operationId,
      organizationId,
      projectId,
      request,
      requestId,
      result,
      status,
      workspaceId,
    ],
    () => ({
      capability: capability.ok ? capability.value : "",
      completedAt: completedAt.ok ? completedAt.value : null,
      createdAt: createdAt.ok ? createdAt.value : ("" as IsoDateTime),
      environmentId: environmentId.ok ? environmentId.value : ("" as ExecutionEnvironmentId),
      error: error.ok ? error.value : null,
      events,
      lastSequence: lastSequence.ok ? lastSequence.value : -1,
      operationId: operationId.ok ? operationId.value : ("" as ExecutionOperationId),
      organizationId: organizationId.ok ? organizationId.value : ("" as OrganizationId),
      projectId: projectId.ok ? projectId.value : ("" as ProjectId),
      request: request.ok ? request.value : ({ operation: "workspace.list" } as ExecutionRequest),
      requestId: requestId.ok ? requestId.value : "",
      result: result.ok ? result.value : null,
      status: status.ok ? status.value : "failed",
      workspaceId: workspaceId.ok ? workspaceId.value : ("" as WorkspaceId),
    }),
  );
};

export const decodeExecutionDispatch = (input: unknown): DecodeResult<ExecutionDispatch> => {
  const record = decodeRecord(input, "$executionDispatch");
  if (!record.ok) return record;
  const keys = rejectUnknown(record.value, ["dispatchGrant", "operation"], "$executionDispatch");
  if (!keys.ok) return keys;
  const dispatchGrant = decodeString(
    record.value.dispatchGrant,
    "$executionDispatch.dispatchGrant",
    { minLength: 32, maxLength: 4_096 },
  );
  const operation = decodeExecutionOperation(record.value.operation);
  return combine([dispatchGrant, operation], () => ({
    dispatchGrant: dispatchGrant.ok ? dispatchGrant.value : "",
    operation: operation.ok ? operation.value : ({} as ExecutionOperation),
  }));
};

export const decodeExecutionDispatchOrOperation = (
  input: unknown,
): DecodeResult<ExecutionDispatch | ExecutionOperation> => {
  const record = decodeRecord(input, "$executionDispatchOrOperation");
  if (!record.ok) return record;
  return Object.hasOwn(record.value, "dispatchGrant")
    ? decodeExecutionDispatch(input)
    : decodeExecutionOperation(input);
};

const requiredId = <Value extends string>(
  record: Readonly<Record<string, unknown>>,
  key: string,
) => {
  const value = required(record, key);
  return value.ok ? decodeId<Value>(value.value, `$.${key}`) : value;
};

export const decodeCreateWorkspaceBindingRequest = (
  input: unknown,
): DecodeResult<CreateWorkspaceBindingRequest> => {
  const record = decodeRecord(input, "$");
  if (!record.ok) return record;
  const environmentId = requiredId<ExecutionEnvironmentId>(record.value, "environmentId");
  const organizationId = requiredId<OrganizationId>(record.value, "organizationId");
  const projectId = requiredId<ProjectId>(record.value, "projectId");
  const workspaceId = requiredId<WorkspaceId>(record.value, "workspaceId");
  return combine([environmentId, organizationId, projectId, workspaceId], () => ({
    environmentId: environmentId.ok ? environmentId.value : ("" as ExecutionEnvironmentId),
    organizationId: organizationId.ok ? organizationId.value : ("" as OrganizationId),
    projectId: projectId.ok ? projectId.value : ("" as ProjectId),
    workspaceId: workspaceId.ok ? workspaceId.value : ("" as WorkspaceId),
  }));
};

export const decodeCreateExecutionOperationRequest = (
  input: unknown,
): DecodeResult<CreateExecutionOperationRequest> => {
  const record = decodeRecord(input, "$");
  if (!record.ok) return record;
  const environmentId = requiredId<ExecutionEnvironmentId>(record.value, "environmentId");
  const operationId = requiredId<ExecutionOperationId>(record.value, "operationId");
  const organizationId = requiredId<OrganizationId>(record.value, "organizationId");
  const projectId = requiredId<ProjectId>(record.value, "projectId");
  const workspaceId = requiredId<WorkspaceId>(record.value, "workspaceId");
  const requestIdRaw = required(record.value, "requestId");
  const requestId = requestIdRaw.ok
    ? decodeString(requestIdRaw.value, "$.requestId", { minLength: 1, maxLength: 128 })
    : requestIdRaw;
  const requestRaw = required(record.value, "request");
  const request = requestRaw.ok ? decodeExecutionRequest(requestRaw.value) : requestRaw;
  return combine(
    [environmentId, operationId, organizationId, projectId, workspaceId, requestId, request],
    () => ({
      environmentId: environmentId.ok ? environmentId.value : ("" as ExecutionEnvironmentId),
      operationId: operationId.ok ? operationId.value : ("" as ExecutionOperationId),
      organizationId: organizationId.ok ? organizationId.value : ("" as OrganizationId),
      projectId: projectId.ok ? projectId.value : ("" as ProjectId),
      workspaceId: workspaceId.ok ? workspaceId.value : ("" as WorkspaceId),
      requestId: requestId.ok ? requestId.value : "",
      request: request.ok ? request.value : ({ operation: "workspace.list" } as ExecutionRequest),
    }),
  );
};

export const decodeExecutionEventsQuery = (
  input: Readonly<{ after: unknown; limit: unknown }>,
): DecodeResult<Readonly<{ after: number; limit: number }>> => {
  const after = decodeInteger(input.after, "$.after", { min: -1 });
  const limit = decodeInteger(input.limit, "$.limit", { min: 1, max: 500 });
  return combine([after, limit], () => ({
    after: after.ok ? after.value : -1,
    limit: limit.ok ? limit.value : 100,
  }));
};
