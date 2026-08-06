import type { ExecutionCapability } from "./architecture.ts";
import {
  decodeConnectClientFrame,
  decodeConnectNodeFrame,
  decodeConnectNodeHello,
  type ConnectClientFrame,
  type ConnectNodeFrame,
} from "./connect.ts";
import type {
  EnvironmentChallengeId,
  ExecutionEnvironmentId,
  IsoDateTime,
  OrganizationId,
  UserId,
  WorkspaceId,
} from "./ids.ts";
import { decodeId, decodeIsoDateTime } from "./ids.ts";
import {
  combine,
  decodeFailure,
  decodeRecord,
  decodeString,
  decodeSuccess,
  type DecodeResult,
} from "./validation.ts";

export const maxTunnelLogLines = 500;
export const maxTunnelControlBodyBytes = 1_048_576;

export type CloudflaredReleaseAsset = Readonly<{
  arch: "arm64" | "x64";
  archive: "binary" | "exe" | "tar.gz";
  downloadUrl: string;
  installedSha256: string;
  platform: "darwin" | "linux" | "win32";
  sha256: string;
  version: "2026.7.3";
}>;

export type ManagedTunnelConfiguration = Readonly<{
  hostname: string;
  token: string;
  tunnelId: string;
}>;

export type ValidateClientTicketResponse = Readonly<{
  actorUserId: UserId;
  clientNonce: string;
  environmentId: ExecutionEnvironmentId;
  expiresAt: IsoDateTime;
  hostname: string;
  keyVersion: number;
  organizationId: OrganizationId;
  sessionId: string;
  ticketId: string;
}>;

export type ValidateDispatchResponse = Readonly<{ sessionId: string }>;

export type TunnelClientAuth = Readonly<{
  nonce: string;
  ticket: string;
  type: "client.auth";
}>;

export type TunnelNodeWelcome = Readonly<{
  clientNonce: string;
  environmentId: ExecutionEnvironmentId;
  expiresAt: IsoDateTime;
  hostname: string;
  keyVersion: number;
  organizationId: OrganizationId;
  protocolVersion: 2;
  serverNonce: string;
  sessionId: string;
  signature: string;
  ticketId: string;
  type: "node.welcome";
}>;

export const tunnelWelcomeSigningPayload = (
  welcome: Omit<TunnelNodeWelcome, "signature">,
): string =>
  [
    "glass-connect-node-welcome-v2",
    welcome.sessionId,
    welcome.ticketId,
    welcome.environmentId,
    welcome.organizationId,
    welcome.hostname,
    String(welcome.keyVersion),
    welcome.clientNonce,
    welcome.serverNonce,
    welcome.expiresAt,
    String(welcome.protocolVersion),
  ].join("\n");

export type TunnelEnvironmentProof = Readonly<{
  environmentId: ExecutionEnvironmentId;
  organizationId: OrganizationId;
  proofChallengeId: EnvironmentChallengeId;
  signature: string;
}>;

export type TunnelConfigurationRequest = TunnelEnvironmentProof & Readonly<{ localOrigin: string }>;
export type ValidateClientTicketRequest = TunnelEnvironmentProof & Readonly<{ ticket: string }>;
export type ValidateDispatchRequest = TunnelEnvironmentProof &
  Readonly<{ frame: ConnectClientFrame; sessionId: string }>;
export type RecordOperationFrameRequest = TunnelEnvironmentProof &
  Readonly<{ frame: ConnectNodeFrame; sessionId: string }>;
export type PublishNodePresenceRequest = TunnelEnvironmentProof &
  Readonly<{
    capabilities: readonly ExecutionCapability[];
    status: "offline" | "online";
    workspaces: readonly Readonly<{ id: WorkspaceId; name: string }>[];
  }>;

const proofKeys = ["environmentId", "organizationId", "proofChallengeId", "signature"] as const;

const rejectUnknown = (
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
): DecodeResult<true> => {
  const keys = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !keys.has(key));
  return unknown === undefined
    ? decodeSuccess(true)
    : decodeFailure(`${path}.${unknown}`, "unknown_variant", "Unknown tunnel field.");
};

const identifier = (input: unknown, path: string) =>
  decodeString(input, path, { minLength: 1, maxLength: 128 });

export const decodeTunnelClientAuth = (input: unknown): DecodeResult<TunnelClientAuth> => {
  const record = decodeRecord(input, "$clientAuth");
  if (!record.ok) return record;
  const keys = rejectUnknown(record.value, ["nonce", "ticket", "type"], "$clientAuth");
  if (!keys.ok) return keys;
  if (record.value.type !== "client.auth")
    return decodeFailure("$clientAuth.type", "unknown_variant", "Expected client authentication.");
  const nonce = decodeString(record.value.nonce, "$clientAuth.nonce", {
    minLength: 43,
    maxLength: 43,
  });
  if (nonce.ok && !/^[A-Za-z0-9_-]+$/u.test(nonce.value))
    return decodeFailure("$clientAuth.nonce", "invalid_format", "Expected a base64url nonce.");
  const ticket = decodeString(record.value.ticket, "$clientAuth.ticket", {
    minLength: 32,
    maxLength: 4_096,
  });
  return combine([nonce, ticket], () => ({
    type: "client.auth",
    nonce: nonce.ok ? nonce.value : "",
    ticket: ticket.ok ? ticket.value : "",
  }));
};

export const decodeTunnelNodeWelcome = (input: unknown): DecodeResult<TunnelNodeWelcome> => {
  const record = decodeRecord(input, "$nodeWelcome");
  if (!record.ok) return record;
  const keys = rejectUnknown(
    record.value,
    [
      "clientNonce",
      "environmentId",
      "expiresAt",
      "hostname",
      "keyVersion",
      "organizationId",
      "protocolVersion",
      "serverNonce",
      "sessionId",
      "signature",
      "ticketId",
      "type",
    ],
    "$nodeWelcome",
  );
  if (!keys.ok) return keys;
  if (record.value.type !== "node.welcome" || record.value.protocolVersion !== 2)
    return decodeFailure(
      "$nodeWelcome.type",
      "unknown_variant",
      "Expected a supported node welcome.",
    );
  const clientNonce = decodeString(record.value.clientNonce, "$nodeWelcome.clientNonce", {
    minLength: 43,
    maxLength: 43,
  });
  const environmentId = decodeId<ExecutionEnvironmentId>(
    record.value.environmentId,
    "$nodeWelcome.environmentId",
  );
  const expiresAt = decodeIsoDateTime(record.value.expiresAt, "$nodeWelcome.expiresAt");
  const hostname = decodeString(record.value.hostname, "$nodeWelcome.hostname", {
    minLength: 1,
    maxLength: 253,
  });
  const keyVersion =
    Number.isSafeInteger(record.value.keyVersion) && (record.value.keyVersion as number) >= 1
      ? decodeSuccess(record.value.keyVersion as number)
      : decodeFailure(
          "$nodeWelcome.keyVersion",
          "invalid_type",
          "Expected a positive key version.",
        );
  const organizationId = decodeId<OrganizationId>(
    record.value.organizationId,
    "$nodeWelcome.organizationId",
  );
  const serverNonce = decodeString(record.value.serverNonce, "$nodeWelcome.serverNonce", {
    minLength: 43,
    maxLength: 43,
  });
  const sessionId = identifier(record.value.sessionId, "$nodeWelcome.sessionId");
  const signature = decodeString(record.value.signature, "$nodeWelcome.signature", {
    minLength: 86,
    maxLength: 86,
  });
  const ticketId = identifier(record.value.ticketId, "$nodeWelcome.ticketId");
  return combine(
    [
      clientNonce,
      environmentId,
      expiresAt,
      hostname,
      keyVersion,
      organizationId,
      serverNonce,
      sessionId,
      signature,
      ticketId,
    ],
    () => ({
      type: "node.welcome",
      protocolVersion: 2,
      clientNonce: clientNonce.ok ? clientNonce.value : "",
      environmentId: environmentId.ok ? environmentId.value : ("" as ExecutionEnvironmentId),
      expiresAt: expiresAt.ok ? expiresAt.value : ("" as IsoDateTime),
      hostname: hostname.ok ? hostname.value : "",
      keyVersion: keyVersion.ok ? keyVersion.value : 0,
      organizationId: organizationId.ok ? organizationId.value : ("" as OrganizationId),
      serverNonce: serverNonce.ok ? serverNonce.value : "",
      sessionId: sessionId.ok ? sessionId.value : "",
      signature: signature.ok ? signature.value : "",
      ticketId: ticketId.ok ? ticketId.value : "",
    }),
  );
};

const decodeProof = (
  record: Readonly<Record<string, unknown>>,
  path: string,
): DecodeResult<TunnelEnvironmentProof> => {
  const environmentId = decodeId<ExecutionEnvironmentId>(
    record.environmentId,
    `${path}.environmentId`,
  );
  const organizationId = decodeId<OrganizationId>(record.organizationId, `${path}.organizationId`);
  const proofChallengeId = decodeId<EnvironmentChallengeId>(
    record.proofChallengeId,
    `${path}.proofChallengeId`,
  );
  const signature = decodeString(record.signature, `${path}.signature`, {
    minLength: 86,
    maxLength: 86,
  });
  if (signature.ok && !/^[A-Za-z0-9_-]+$/u.test(signature.value))
    return decodeFailure(`${path}.signature`, "invalid_format", "Expected a base64url signature.");
  return combine([environmentId, organizationId, proofChallengeId, signature], () => ({
    environmentId: environmentId.ok ? environmentId.value : ("" as ExecutionEnvironmentId),
    organizationId: organizationId.ok ? organizationId.value : ("" as OrganizationId),
    proofChallengeId: proofChallengeId.ok ? proofChallengeId.value : ("" as EnvironmentChallengeId),
    signature: signature.ok ? signature.value : "",
  }));
};

const decodeProofRequest = <Value>(
  input: unknown,
  path: string,
  extraKeys: readonly string[],
  build: (
    record: Readonly<Record<string, unknown>>,
    proof: TunnelEnvironmentProof,
  ) => DecodeResult<Value>,
): DecodeResult<Value> => {
  const record = decodeRecord(input, path);
  if (!record.ok) return record;
  const keys = rejectUnknown(record.value, [...proofKeys, ...extraKeys], path);
  if (!keys.ok) return keys;
  const proof = decodeProof(record.value, path);
  return proof.ok ? build(record.value, proof.value) : proof;
};

export const decodeTunnelConfigurationRequest = (
  input: unknown,
): DecodeResult<TunnelConfigurationRequest> =>
  decodeProofRequest(input, "$tunnelConfigurationRequest", ["localOrigin"], (record, proof) => {
    const localOrigin = decodeString(
      record.localOrigin,
      "$tunnelConfigurationRequest.localOrigin",
      { minLength: 18, maxLength: 22 },
    );
    if (!localOrigin.ok) return localOrigin;
    try {
      const url = new URL(localOrigin.value);
      const port = Number(url.port);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        url.username !== "" ||
        url.password !== "" ||
        url.pathname !== "/" ||
        url.search !== "" ||
        url.hash !== "" ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65_535 ||
        url.origin !== localOrigin.value
      )
        return decodeFailure(
          "$tunnelConfigurationRequest.localOrigin",
          "invalid_format",
          "Expected exactly http://127.0.0.1:<port>.",
        );
    } catch {
      return decodeFailure(
        "$tunnelConfigurationRequest.localOrigin",
        "invalid_format",
        "Expected a valid loopback origin.",
      );
    }
    return decodeSuccess({ ...proof, localOrigin: localOrigin.value });
  });

const releaseBase = "https://github.com/cloudflare/cloudflared/releases/download/2026.7.3/";
export const cloudflaredReleaseManifest: readonly CloudflaredReleaseAsset[] = [
  {
    platform: "darwin",
    arch: "x64",
    archive: "tar.gz",
    version: "2026.7.3",
    downloadUrl: `${releaseBase}cloudflared-darwin-amd64.tgz`,
    sha256: "70d1c8684fa6d14b5843787ec8d1ea8e18b23650e424f4ea43d849a506487c3b",
    installedSha256: "e88fe5874d42a94f49a7ea59cabc3722d2962d0449232b0f3b1a426a712e275c",
  },
  {
    platform: "darwin",
    arch: "arm64",
    archive: "tar.gz",
    version: "2026.7.3",
    downloadUrl: `${releaseBase}cloudflared-darwin-arm64.tgz`,
    sha256: "90c5a4f914d705fd70c135dba6d80b1791d254b08d6d4136301941f88330dd09",
    installedSha256: "f35c50089cd25f77a4cb5a2152036bc26db15aa31fbe11f7995d2e42a4ed6257",
  },
  {
    platform: "linux",
    arch: "x64",
    archive: "binary",
    version: "2026.7.3",
    downloadUrl: `${releaseBase}cloudflared-linux-amd64`,
    sha256: "9d71c677db00134c1bd4144b7783486b654ad281b1ea62b4972098d19f770f17",
    installedSha256: "9d71c677db00134c1bd4144b7783486b654ad281b1ea62b4972098d19f770f17",
  },
  {
    platform: "linux",
    arch: "arm64",
    archive: "binary",
    version: "2026.7.3",
    downloadUrl: `${releaseBase}cloudflared-linux-arm64`,
    sha256: "65259e652a7bea08bf5df603233ab22b8bf3116af8df9f9206209af6a1b955c0",
    installedSha256: "65259e652a7bea08bf5df603233ab22b8bf3116af8df9f9206209af6a1b955c0",
  },
  {
    platform: "win32",
    arch: "x64",
    archive: "exe",
    version: "2026.7.3",
    downloadUrl: `${releaseBase}cloudflared-windows-amd64.exe`,
    sha256: "8635da433b6df8194746e88ed9d2589566c20e38bfc2a80e431a348b7c765841",
    installedSha256: "8635da433b6df8194746e88ed9d2589566c20e38bfc2a80e431a348b7c765841",
  },
] as const;

export const decodeValidateClientTicketRequest = (
  input: unknown,
): DecodeResult<ValidateClientTicketRequest> =>
  decodeProofRequest(input, "$clientTicketValidationRequest", ["ticket"], (record, proof) => {
    const ticket = decodeString(record.ticket, "$clientTicketValidationRequest.ticket", {
      minLength: 32,
      maxLength: 4_096,
    });
    return ticket.ok ? decodeSuccess({ ...proof, ticket: ticket.value }) : ticket;
  });

export const decodeValidateDispatchRequest = (
  input: unknown,
): DecodeResult<ValidateDispatchRequest> =>
  decodeProofRequest(
    input,
    "$dispatchValidationRequest",
    ["frame", "sessionId"],
    (record, proof) => {
      const frame = decodeConnectClientFrame(record.frame);
      const sessionId = identifier(record.sessionId, "$dispatchValidationRequest.sessionId");
      return combine([frame, sessionId], () => ({
        ...proof,
        frame: frame.ok ? frame.value : ({} as ConnectClientFrame),
        sessionId: sessionId.ok ? sessionId.value : "",
      }));
    },
  );

export const decodeRecordOperationFrameRequest = (
  input: unknown,
): DecodeResult<RecordOperationFrameRequest> =>
  decodeProofRequest(input, "$operationFrameRequest", ["frame", "sessionId"], (record, proof) => {
    const sessionId = identifier(record.sessionId, "$operationFrameRequest.sessionId");
    const frame = decodeConnectNodeFrame(record.frame);
    return combine([sessionId, frame], () => ({
      ...proof,
      sessionId: sessionId.ok ? sessionId.value : "",
      frame: frame.ok ? frame.value : ({} as ConnectNodeFrame),
    }));
  });

export const decodePublishNodePresenceRequest = (
  input: unknown,
): DecodeResult<PublishNodePresenceRequest> =>
  decodeProofRequest(
    input,
    "$nodePresenceRequest",
    ["capabilities", "status", "workspaces"],
    (record, proof) => {
      const status =
        record.status === "offline" || record.status === "online"
          ? decodeSuccess<"offline" | "online">(record.status)
          : decodeFailure(
              "$nodePresenceRequest.status",
              "unknown_variant",
              "Unknown presence status.",
            );
      const hello = decodeConnectNodeHello({
        type: "node.hello",
        protocolVersion: 1,
        capabilities: record.capabilities,
        workspaces: record.workspaces,
      });
      return combine([status, hello], () => ({
        ...proof,
        capabilities: hello.ok ? hello.value.capabilities : [],
        status: status.ok ? status.value : "offline",
        workspaces: hello.ok ? hello.value.workspaces : [],
      }));
    },
  );

export const decodeManagedTunnelConfiguration = (
  input: unknown,
): DecodeResult<ManagedTunnelConfiguration> => {
  const record = decodeRecord(input, "$tunnelConfiguration");
  if (!record.ok) return record;
  const keys = rejectUnknown(
    record.value,
    ["hostname", "token", "tunnelId"],
    "$tunnelConfiguration",
  );
  if (!keys.ok) return keys;
  const hostname = decodeString(record.value.hostname, "$tunnelConfiguration.hostname", {
    minLength: 1,
    maxLength: 253,
  });
  if (
    hostname.ok &&
    (!/^[a-z0-9.-]+$/u.test(hostname.value) ||
      hostname.value.includes("..") ||
      hostname.value.startsWith(".") ||
      hostname.value.endsWith("."))
  )
    return decodeFailure(
      "$tunnelConfiguration.hostname",
      "invalid_format",
      "Invalid tunnel hostname.",
    );
  const token = decodeString(record.value.token, "$tunnelConfiguration.token", {
    minLength: 32,
    maxLength: 8_192,
  });
  const tunnelId = decodeId<string>(record.value.tunnelId, "$tunnelConfiguration.tunnelId");
  return combine([hostname, token, tunnelId], () => ({
    hostname: hostname.ok ? hostname.value : "",
    token: token.ok ? token.value : "",
    tunnelId: tunnelId.ok ? tunnelId.value : "",
  }));
};

export const decodeValidateClientTicketResponse = (
  input: unknown,
): DecodeResult<ValidateClientTicketResponse> => {
  const record = decodeRecord(input, "$clientTicketValidation");
  if (!record.ok) return record;
  const keys = rejectUnknown(
    record.value,
    [
      "actorUserId",
      "clientNonce",
      "environmentId",
      "expiresAt",
      "hostname",
      "keyVersion",
      "organizationId",
      "sessionId",
      "ticketId",
    ],
    "$clientTicketValidation",
  );
  if (!keys.ok) return keys;
  const actorUserId = decodeId<UserId>(
    record.value.actorUserId,
    "$clientTicketValidation.actorUserId",
  );
  const clientNonce = decodeString(
    record.value.clientNonce,
    "$clientTicketValidation.clientNonce",
    { minLength: 43, maxLength: 43 },
  );
  const environmentId = decodeId<ExecutionEnvironmentId>(
    record.value.environmentId,
    "$clientTicketValidation.environmentId",
  );
  const expiresAt = decodeIsoDateTime(record.value.expiresAt, "$clientTicketValidation.expiresAt");
  const hostname = decodeString(record.value.hostname, "$clientTicketValidation.hostname", {
    minLength: 1,
    maxLength: 253,
  });
  const keyVersion =
    Number.isSafeInteger(record.value.keyVersion) && (record.value.keyVersion as number) >= 1
      ? decodeSuccess(record.value.keyVersion as number)
      : decodeFailure(
          "$clientTicketValidation.keyVersion",
          "invalid_type",
          "Expected a positive key version.",
        );
  const organizationId = decodeId<OrganizationId>(
    record.value.organizationId,
    "$clientTicketValidation.organizationId",
  );
  const sessionId = identifier(record.value.sessionId, "$clientTicketValidation.sessionId");
  const ticketId = identifier(record.value.ticketId, "$clientTicketValidation.ticketId");
  return combine(
    [
      actorUserId,
      clientNonce,
      environmentId,
      expiresAt,
      hostname,
      keyVersion,
      organizationId,
      sessionId,
      ticketId,
    ],
    () => ({
      actorUserId: actorUserId.ok ? actorUserId.value : ("" as UserId),
      clientNonce: clientNonce.ok ? clientNonce.value : "",
      environmentId: environmentId.ok ? environmentId.value : ("" as ExecutionEnvironmentId),
      expiresAt: expiresAt.ok ? expiresAt.value : ("" as IsoDateTime),
      hostname: hostname.ok ? hostname.value : "",
      keyVersion: keyVersion.ok ? keyVersion.value : 0,
      organizationId: organizationId.ok ? organizationId.value : ("" as OrganizationId),
      sessionId: sessionId.ok ? sessionId.value : "",
      ticketId: ticketId.ok ? ticketId.value : "",
    }),
  );
};

export const decodeValidateDispatchResponse = (
  input: unknown,
): DecodeResult<ValidateDispatchResponse> => {
  const record = decodeRecord(input, "$dispatchValidation");
  if (!record.ok) return record;
  const keys = rejectUnknown(record.value, ["sessionId"], "$dispatchValidation");
  if (!keys.ok) return keys;
  const sessionId = identifier(record.value.sessionId, "$dispatchValidation.sessionId");
  return sessionId.ok ? decodeSuccess({ sessionId: sessionId.value }) : sessionId;
};
