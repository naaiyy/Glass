import type { BoundaryError } from "./errors.ts";
import type { ExecutionCapability } from "./architecture.ts";
import {
  decodeId,
  decodeIsoDateTime,
  type IsoDateTime,
  type OrganizationId,
  type WorkspaceId,
} from "./ids.ts";
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

export const glassConnectProtocolVersion = 1 as const;
export const maxConnectFrameBytes = 1_048_576;
export const maxConnectPayloadBytes = 786_432;
export const connectTicketLifetimeSeconds = 60;

export type ConnectRole = "client" | "node";
export type ConnectTicket = Readonly<{
  expiresAt: IsoDateTime;
  keyVersion: number;
  publicKey: string;
  ticket: string;
  ticketId: string;
  websocketUrl: string;
}>;

export type CreateConnectTicketRequest = Readonly<{
  clientNonce: string;
  organizationId: OrganizationId;
}>;

export type ConnectTicketClaims = Readonly<{
  audience: "glass-connect";
  environmentId: string;
  expiresAt: number;
  generation: number;
  issuedAt: number;
  organizationId: string;
  role: ConnectRole;
  ticketId: string;
}>;

export type ConnectOperationRequest = Readonly<{
  capability: string;
  dispatchGrant: string;
  operationId: string;
  payload: unknown;
  requestId: string;
  type: "operation.request";
}>;

export type ConnectOperationCancel = Readonly<{
  dispatchGrant: string;
  operationId: string;
  reason: string;
  requestId: string;
  type: "operation.cancel";
}>;

export type ConnectClientFrame = ConnectOperationRequest | ConnectOperationCancel;

export type ConnectOperationEvent = Readonly<{
  event: "progress" | "result";
  operationId: string;
  payload: unknown;
  requestId: string;
  sequence: number;
  type: "operation.event";
}>;

export type ConnectOperationError = Readonly<{
  error: BoundaryError;
  operationId: string;
  requestId: string;
  type: "operation.error";
}>;

export type ConnectNodeFrame = ConnectOperationEvent | ConnectOperationError;

export type ConnectNodeHello = Readonly<{
  capabilities: readonly ExecutionCapability[];
  protocolVersion: typeof glassConnectProtocolVersion;
  type: "node.hello";
  workspaces: readonly Readonly<{ id: WorkspaceId; name: string }>[];
}>;

export type ConnectNodeDispatch = Readonly<{
  channelId: string;
  frame: ConnectClientFrame;
  type: "relay.dispatch";
}>;

export type ConnectNodeReply = Readonly<{
  channelId: string;
  frame: ConnectNodeFrame;
  type: "relay.reply";
}>;

export type ConnectPresence = Readonly<{
  capabilities: readonly string[];
  connectedAt: IsoDateTime | null;
  environmentId: string;
  lastSeenAt: IsoDateTime | null;
  status: "offline" | "online";
}>;

export type ConnectWorkspaceCatalog = readonly Readonly<{ id: WorkspaceId; name: string }>[];

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

export const decodeCreateConnectTicketRequest = (
  input: unknown,
): DecodeResult<CreateConnectTicketRequest> => {
  const record = decodeRecord(input, "$connectTicketRequest");
  if (!record.ok) return record;
  const keys = rejectUnknown(
    record.value,
    ["clientNonce", "organizationId"],
    "$connectTicketRequest",
  );
  if (!keys.ok) return keys;
  const clientNonce = decodeString(record.value.clientNonce, "$connectTicketRequest.clientNonce", {
    minLength: 43,
    maxLength: 43,
  });
  if (clientNonce.ok && !/^[A-Za-z0-9_-]+$/u.test(clientNonce.value))
    return decodeFailure(
      "$connectTicketRequest.clientNonce",
      "invalid_format",
      "Expected a base64url nonce.",
    );
  const organizationId = decodeId<OrganizationId>(
    record.value.organizationId,
    "$connectTicketRequest.organizationId",
  );
  return combine([clientNonce, organizationId], () => ({
    clientNonce: clientNonce.ok ? clientNonce.value : "",
    organizationId: organizationId.ok ? organizationId.value : ("" as OrganizationId),
  }));
};

export const decodeConnectTicket = (input: unknown): DecodeResult<ConnectTicket> => {
  const record = decodeRecord(input, "$connectTicket");
  if (!record.ok) return record;
  const keys = rejectUnknown(
    record.value,
    ["expiresAt", "keyVersion", "publicKey", "ticket", "ticketId", "websocketUrl"],
    "$connectTicket",
  );
  if (!keys.ok) return keys;
  const expiresAt = decodeIsoDateTime(record.value.expiresAt, "$connectTicket.expiresAt");
  const ticket = decodeString(record.value.ticket, "$connectTicket.ticket", {
    minLength: 32,
    maxLength: 4_096,
  });
  const keyVersion = decodeInteger(record.value.keyVersion, "$connectTicket.keyVersion", {
    min: 1,
  });
  const publicKey = decodeString(record.value.publicKey, "$connectTicket.publicKey", {
    minLength: 43,
    maxLength: 43,
  });
  const ticketId = decodeIdentifier(record.value.ticketId, "$connectTicket.ticketId");
  const websocketUrl = decodeString(record.value.websocketUrl, "$connectTicket.websocketUrl", {
    minLength: 1,
    maxLength: 2_048,
  });
  if (!websocketUrl.ok) return websocketUrl;
  try {
    const url = new URL(websocketUrl.value);
    if (url.protocol !== "wss:" && url.protocol !== "ws:") {
      return decodeFailure(
        "$connectTicket.websocketUrl",
        "invalid_format",
        "Expected a WebSocket URL.",
      );
    }
  } catch {
    return decodeFailure("$connectTicket.websocketUrl", "invalid_format", "Expected a valid URL.");
  }
  return combine([expiresAt, keyVersion, publicKey, ticket, ticketId], () => ({
    expiresAt: expiresAt.ok ? expiresAt.value : ("" as IsoDateTime),
    keyVersion: keyVersion.ok ? keyVersion.value : 0,
    publicKey: publicKey.ok ? publicKey.value : "",
    ticket: ticket.ok ? ticket.value : "",
    ticketId: ticketId.ok ? ticketId.value : "",
    websocketUrl: websocketUrl.value,
  }));
};

export const decodeConnectPresence = (input: unknown): DecodeResult<ConnectPresence> => {
  const record = decodeRecord(input, "$connectPresence");
  if (!record.ok) return record;
  const keys = rejectUnknown(
    record.value,
    ["capabilities", "connectedAt", "environmentId", "lastSeenAt", "status"],
    "$connectPresence",
  );
  if (!keys.ok) return keys;
  if (!Array.isArray(record.value.capabilities) || record.value.capabilities.length > 32) {
    return decodeFailure(
      "$connectPresence.capabilities",
      "out_of_range",
      "Expected at most 32 capabilities.",
    );
  }
  const capabilities: string[] = [];
  for (const [index, value] of record.value.capabilities.entries()) {
    const capability = decodeIdentifier(value, `$connectPresence.capabilities[${index}]`);
    if (!capability.ok) return capability;
    capabilities.push(capability.value);
  }
  const environmentId = decodeId(record.value.environmentId, "$connectPresence.environmentId");
  const connectedAt =
    record.value.connectedAt === null
      ? decodeSuccess<null>(null)
      : decodeIsoDateTime(record.value.connectedAt, "$connectPresence.connectedAt");
  const lastSeenAt =
    record.value.lastSeenAt === null
      ? decodeSuccess<null>(null)
      : decodeIsoDateTime(record.value.lastSeenAt, "$connectPresence.lastSeenAt");
  const status =
    record.value.status === "online" || record.value.status === "offline"
      ? decodeSuccess<ConnectPresence["status"]>(record.value.status)
      : decodeFailure("$connectPresence.status", "unknown_variant", "Unknown presence status.");
  return combine([environmentId, connectedAt, lastSeenAt, status], () => ({
    capabilities,
    connectedAt: connectedAt.ok ? connectedAt.value : null,
    environmentId: environmentId.ok ? environmentId.value : "",
    lastSeenAt: lastSeenAt.ok ? lastSeenAt.value : null,
    status: status.ok ? status.value : "offline",
  }));
};

export const decodeConnectWorkspaceCatalog = (
  input: unknown,
): DecodeResult<ConnectWorkspaceCatalog> => {
  if (!Array.isArray(input) || input.length > 1_000) {
    return decodeFailure("$workspaceCatalog", "out_of_range", "Expected at most 1,000 workspaces.");
  }
  const workspaces: Array<Readonly<{ id: WorkspaceId; name: string }>> = [];
  for (const [index, value] of input.entries()) {
    const path = `$workspaceCatalog[${index}]`;
    const record = decodeRecord(value, path);
    if (!record.ok) return record;
    const keys = rejectUnknown(record.value, ["id", "name"], path);
    if (!keys.ok) return keys;
    const id = decodeId<WorkspaceId>(record.value.id, `${path}.id`);
    const name = decodeString(record.value.name, `${path}.name`, { minLength: 1, maxLength: 120 });
    if (!id.ok) return id;
    if (!name.ok) return name;
    if (workspaces.some((candidate) => candidate.id === id.value)) {
      return decodeFailure(`${path}.id`, "invalid_format", "Workspace IDs must be unique.");
    }
    workspaces.push({ id: id.value, name: name.value });
  }
  return decodeSuccess(workspaces);
};

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

const decodeIdentifier = (input: unknown, path: string): DecodeResult<string> => {
  const decoded = decodeString(input, path, { minLength: 1, maxLength: 128 });
  if (!decoded.ok) return decoded;
  return identifierPattern.test(decoded.value)
    ? decoded
    : decodeFailure(path, "invalid_format", "Expected a bounded protocol identifier.");
};

const payloadWithinBound = (payload: unknown, path: string): DecodeResult<unknown> => {
  let encoded: string;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    return decodeFailure(path, "invalid_format", "Payload must be JSON serializable.");
  }
  return new TextEncoder().encode(encoded).byteLength <= maxConnectPayloadBytes
    ? decodeSuccess(payload)
    : decodeFailure(path, "out_of_range", "Payload exceeds the Glass Connect bound.");
};

const decodeBoundaryError = (input: unknown): DecodeResult<BoundaryError> => {
  const record = decodeRecord(input, "$.error");
  if (!record.ok) return record;
  const code = required(record.value, "code", "$.error");
  const message = required(record.value, "message", "$.error");
  const retryable = required(record.value, "retryable", "$.error");
  const codeValue = code.ok
    ? decodeString(code.value, "$.error.code", { minLength: 1, maxLength: 64 })
    : code;
  const messageValue = message.ok
    ? decodeString(message.value, "$.error.message", { minLength: 1, maxLength: 2_000 })
    : message;
  const retryableValue =
    retryable.ok && typeof retryable.value === "boolean"
      ? decodeSuccess(retryable.value)
      : decodeFailure("$.error.retryable", "invalid_type", "Expected a boolean.");
  return combine([code, message, retryable, codeValue, messageValue, retryableValue], () => ({
    code: codeValue.ok ? (codeValue.value as BoundaryError["code"]) : "INVALID_RESPONSE",
    message: messageValue.ok ? messageValue.value : "Invalid error",
    retryable: retryableValue.ok ? retryableValue.value : false,
  }));
};

export const decodeConnectClientFrame = (input: unknown): DecodeResult<ConnectClientFrame> => {
  const record = decodeRecord(input, "$");
  if (!record.ok) return record;
  const type = required(record.value, "type");
  if (!type.ok) return type;
  if (type.value !== "operation.request" && type.value !== "operation.cancel") {
    return decodeFailure("$.type", "unknown_variant", "Unknown client frame type.");
  }
  const requestId = required(record.value, "requestId");
  const operationId = required(record.value, "operationId");
  const requestIdValue = requestId.ok
    ? decodeIdentifier(requestId.value, "$.requestId")
    : requestId;
  const operationIdValue = operationId.ok
    ? decodeIdentifier(operationId.value, "$.operationId")
    : operationId;
  if (type.value === "operation.cancel") {
    const dispatchGrant = required(record.value, "dispatchGrant");
    const reason = required(record.value, "reason");
    const reasonValue = reason.ok
      ? decodeString(reason.value, "$.reason", { minLength: 1, maxLength: 500 })
      : reason;
    const dispatchGrantValue = dispatchGrant.ok
      ? decodeString(dispatchGrant.value, "$.dispatchGrant", { minLength: 32, maxLength: 4_096 })
      : dispatchGrant;
    return combine(
      [
        requestId,
        operationId,
        reason,
        dispatchGrant,
        requestIdValue,
        operationIdValue,
        reasonValue,
        dispatchGrantValue,
      ],
      () => ({
        type: "operation.cancel",
        requestId: requestIdValue.ok ? requestIdValue.value : "invalid",
        operationId: operationIdValue.ok ? operationIdValue.value : "invalid",
        dispatchGrant: dispatchGrantValue.ok ? dispatchGrantValue.value : "invalid",
        reason: reasonValue.ok ? reasonValue.value : "Cancelled",
      }),
    );
  }
  const capability = required(record.value, "capability");
  const dispatchGrant = required(record.value, "dispatchGrant");
  const payload = required(record.value, "payload");
  const capabilityValue = capability.ok
    ? decodeIdentifier(capability.value, "$.capability")
    : capability;
  const dispatchGrantValue = dispatchGrant.ok
    ? decodeString(dispatchGrant.value, "$.dispatchGrant", { minLength: 32, maxLength: 4_096 })
    : dispatchGrant;
  const payloadValue = payload.ok ? payloadWithinBound(payload.value, "$.payload") : payload;
  return combine(
    [
      requestId,
      operationId,
      capability,
      dispatchGrant,
      payload,
      requestIdValue,
      operationIdValue,
      capabilityValue,
      dispatchGrantValue,
      payloadValue,
    ],
    () => ({
      type: "operation.request",
      requestId: requestIdValue.ok ? requestIdValue.value : "invalid",
      operationId: operationIdValue.ok ? operationIdValue.value : "invalid",
      capability: capabilityValue.ok ? capabilityValue.value : "invalid",
      dispatchGrant: dispatchGrantValue.ok ? dispatchGrantValue.value : "invalid",
      payload: payloadValue.ok ? payloadValue.value : null,
    }),
  );
};

export const decodeConnectNodeFrame = (input: unknown): DecodeResult<ConnectNodeFrame> => {
  const record = decodeRecord(input, "$");
  if (!record.ok) return record;
  const type = required(record.value, "type");
  if (!type.ok) return type;
  const requestId = required(record.value, "requestId");
  const operationId = required(record.value, "operationId");
  const requestIdValue = requestId.ok
    ? decodeIdentifier(requestId.value, "$.requestId")
    : requestId;
  const operationIdValue = operationId.ok
    ? decodeIdentifier(operationId.value, "$.operationId")
    : operationId;
  if (type.value === "operation.error") {
    const error = required(record.value, "error");
    const errorValue = error.ok ? decodeBoundaryError(error.value) : error;
    return combine(
      [requestId, operationId, error, requestIdValue, operationIdValue, errorValue],
      () => ({
        type: "operation.error",
        requestId: requestIdValue.ok ? requestIdValue.value : "invalid",
        operationId: operationIdValue.ok ? operationIdValue.value : "invalid",
        error: errorValue.ok
          ? errorValue.value
          : { code: "INVALID_RESPONSE", message: "Invalid error", retryable: false },
      }),
    );
  }
  if (type.value !== "operation.event") {
    return decodeFailure("$.type", "unknown_variant", "Unknown node frame type.");
  }
  const event = required(record.value, "event");
  const sequence = required(record.value, "sequence");
  const payload = required(record.value, "payload");
  const eventValue: DecodeResult<"progress" | "result"> =
    event.ok && (event.value === "progress" || event.value === "result")
      ? decodeSuccess(event.value)
      : decodeFailure("$.event", "unknown_variant", "Unknown operation event type.");
  const sequenceValue = sequence.ok
    ? decodeInteger(sequence.value, "$.sequence", { min: 0 })
    : sequence;
  const payloadValue = payload.ok ? payloadWithinBound(payload.value, "$.payload") : payload;
  return combine(
    [
      requestId,
      operationId,
      event,
      sequence,
      payload,
      requestIdValue,
      operationIdValue,
      eventValue,
      sequenceValue,
      payloadValue,
    ],
    () => ({
      type: "operation.event",
      requestId: requestIdValue.ok ? requestIdValue.value : "invalid",
      operationId: operationIdValue.ok ? operationIdValue.value : "invalid",
      event: eventValue.ok ? eventValue.value : "progress",
      sequence: sequenceValue.ok ? sequenceValue.value : 0,
      payload: payloadValue.ok ? payloadValue.value : null,
    }),
  );
};

export const decodeConnectNodeHello = (input: unknown): DecodeResult<ConnectNodeHello> => {
  const record = decodeRecord(input, "$");
  if (!record.ok) return record;
  if (record.value.type !== "node.hello") {
    return decodeFailure("$.type", "unknown_variant", "Expected a node hello frame.");
  }
  if (record.value.protocolVersion !== glassConnectProtocolVersion) {
    return decodeFailure(
      "$.protocolVersion",
      "unknown_variant",
      "Unsupported Glass Connect protocol version.",
    );
  }
  if (!Array.isArray(record.value.capabilities) || record.value.capabilities.length > 32) {
    return decodeFailure("$.capabilities", "out_of_range", "Expected at most 32 capabilities.");
  }
  if (!Array.isArray(record.value.workspaces) || record.value.workspaces.length > 1_000) {
    return decodeFailure("$.workspaces", "out_of_range", "Expected at most 1,000 workspaces.");
  }
  const knownCapabilities = new Set<ExecutionCapability>([
    "browser-automation",
    "filesystem",
    "git",
    "processes",
    "terminals",
    "workspace-checkpoints",
  ]);
  const capabilities: ExecutionCapability[] = [];
  for (const [index, capability] of record.value.capabilities.entries()) {
    const decoded = decodeIdentifier(capability, `$.capabilities[${index}]`);
    if (!decoded.ok) return decoded;
    if (!knownCapabilities.has(decoded.value as ExecutionCapability)) {
      return decodeFailure(
        `$.capabilities[${index}]`,
        "unknown_variant",
        "Unknown execution capability.",
      );
    }
    if (!capabilities.includes(decoded.value as ExecutionCapability)) {
      capabilities.push(decoded.value as ExecutionCapability);
    }
  }
  const workspaces: Array<Readonly<{ id: WorkspaceId; name: string }>> = [];
  for (const [index, workspace] of record.value.workspaces.entries()) {
    const decoded = decodeRecord(workspace, `$.workspaces[${index}]`);
    if (!decoded.ok) return decoded;
    const id = decodeId<WorkspaceId>(decoded.value.id, `$.workspaces[${index}].id`);
    if (!id.ok) return id;
    if (workspaces.some((candidate) => candidate.id === id.value)) {
      return decodeFailure(
        `$.workspaces[${index}].id`,
        "invalid_format",
        "Workspace IDs must be unique in a node hello.",
      );
    }
    const name = decodeString(decoded.value.name, `$.workspaces[${index}].name`, {
      minLength: 1,
      maxLength: 120,
    });
    if (!name.ok) return name;
    workspaces.push({ id: id.value, name: name.value });
  }
  return decodeSuccess({
    type: "node.hello",
    protocolVersion: glassConnectProtocolVersion,
    capabilities,
    workspaces,
  });
};

export const decodeNodeDispatch = (input: unknown): DecodeResult<ConnectNodeDispatch> => {
  const record = decodeRecord(input, "$");
  if (!record.ok) return record;
  if (record.value.type !== "relay.dispatch") {
    return decodeFailure("$.type", "unknown_variant", "Unknown relay frame type.");
  }
  const channelId = decodeIdentifier(record.value.channelId, "$.channelId");
  const frame = decodeConnectClientFrame(record.value.frame);
  return combine([channelId, frame], () => ({
    type: "relay.dispatch",
    channelId: channelId.ok ? channelId.value : "invalid",
    frame: frame.ok ? frame.value : ({} as ConnectClientFrame),
  }));
};

export const decodeNodeReply = (input: unknown): DecodeResult<ConnectNodeReply> => {
  const record = decodeRecord(input, "$");
  if (!record.ok) return record;
  if (record.value.type !== "relay.reply") {
    return decodeFailure("$.type", "unknown_variant", "Unknown relay frame type.");
  }
  const channelId = decodeIdentifier(record.value.channelId, "$.channelId");
  const frame = decodeConnectNodeFrame(record.value.frame);
  return combine([channelId, frame], () => ({
    type: "relay.reply",
    channelId: channelId.ok ? channelId.value : "invalid",
    frame: frame.ok ? frame.value : ({} as ConnectNodeFrame),
  }));
};

export const decodeConnectFrameText = <Value>(
  input: string,
  decode: (value: unknown) => DecodeResult<Value>,
): DecodeResult<Value> => {
  if (new TextEncoder().encode(input).byteLength > maxConnectFrameBytes) {
    return decodeFailure("$", "out_of_range", "Frame exceeds the Glass Connect bound.");
  }
  try {
    return decode(JSON.parse(input) as unknown);
  } catch {
    return decodeFailure("$", "invalid_format", "Frame must be valid JSON.");
  }
};
