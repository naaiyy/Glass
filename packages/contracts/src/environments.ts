import type {
  EnvironmentChallengeId,
  EnvironmentCredentialId,
  ExecutionEnvironmentId,
  IsoDateTime,
  OrganizationId,
  UserId,
} from "./ids.ts";
import { decodeId, decodeIsoDateTime } from "./ids.ts";
import {
  decodeFailure,
  decodeInteger,
  decodeRecord,
  decodeString,
  decodeSuccess,
  type DecodeResult,
} from "./validation.ts";

export const environmentCredentialScope = "glass-connect" as const;
export const environmentPairingApprovalPath = "/#glass-connect-pair" as const;
export const environmentRotationApprovalPath = "/#glass-connect-rotate" as const;
export const maxEnvironmentDisplayNameLength = 120 as const;
export const maxEnvironmentPlatformLength = 80 as const;

export type EnvironmentPlatform = "linux" | "macos" | "windows";
export type EnvironmentPublicKey = string & Readonly<{ __brand: "EnvironmentPublicKey" }>;
export type EnvironmentProof = string & Readonly<{ __brand: "EnvironmentProof" }>;

export type ExecutionEnvironment = Readonly<{
  id: ExecutionEnvironmentId;
  organizationId: OrganizationId;
  displayName: string;
  platform: EnvironmentPlatform;
  publicKey: EnvironmentPublicKey;
  keyVersion: number;
  createdByUserId: UserId;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  revokedAt: IsoDateTime | null;
}>;

export type BeginEnvironmentPairingRequest = Readonly<{
  displayName: string;
  platform: EnvironmentPlatform;
  publicKey: EnvironmentPublicKey;
}>;

export type BeginEnvironmentPairingResponse = Readonly<{
  pairingId: EnvironmentChallengeId;
  pairingCode: string;
  pollingToken: string;
  approvalPath: string;
  expiresAt: IsoDateTime;
}>;

export type ApproveEnvironmentPairingRequest = Readonly<{
  organizationId: OrganizationId;
  pairingCode: string;
}>;

export type EnvironmentPairingStatusRequest = Readonly<{
  pairingId: EnvironmentChallengeId;
  pollingToken: string;
}>;

export type EnvironmentPairingStatus =
  | Readonly<{ status: "pending"; expiresAt: IsoDateTime }>
  | Readonly<{ status: "approved"; challenge: string; expiresAt: IsoDateTime }>;

export type BeginEnvironmentRotationRequest = Readonly<{
  environmentId: ExecutionEnvironmentId;
  organizationId: OrganizationId;
  publicKey: EnvironmentPublicKey;
  proofChallengeId: EnvironmentChallengeId;
  signature: EnvironmentProof;
}>;

export type BeginEnvironmentRotationResponse = Readonly<{
  rotationId: EnvironmentChallengeId;
  rotationCode: string;
  pollingToken: string;
  approvalPath: string;
  expiresAt: IsoDateTime;
}>;

export type ApproveEnvironmentRotationRequest = Readonly<{
  organizationId: OrganizationId;
  rotationCode: string;
}>;

export type EnvironmentRotationStatusRequest = Readonly<{
  rotationId: EnvironmentChallengeId;
  pollingToken: string;
}>;

export type EnvironmentRotationStatus =
  | Readonly<{ status: "pending"; expiresAt: IsoDateTime }>
  | Readonly<{ status: "approved"; challenge: string; expiresAt: IsoDateTime }>
  | Readonly<{ status: "completed"; environment: ExecutionEnvironment }>;

export type CompleteEnvironmentRotationRequest = Readonly<{
  rotationId: EnvironmentChallengeId;
  pollingToken: string;
  currentKeySignature: EnvironmentProof;
  replacementKeySignature: EnvironmentProof;
}>;

export type EnvironmentIdentityChallenge = Readonly<{
  challengeId: EnvironmentChallengeId;
  challenge: string;
  expiresAt: IsoDateTime;
}>;

export type CompleteEnvironmentProofRequest = Readonly<{
  challengeId: EnvironmentChallengeId;
  signature: EnvironmentProof;
  pollingToken?: string;
}>;

export type CreateCredentialChallengeRequest = Readonly<{
  environmentId: ExecutionEnvironmentId;
}>;

export type EnvironmentCredential = Readonly<{
  credentialId: EnvironmentCredentialId;
  environmentId: ExecutionEnvironmentId;
  organizationId: OrganizationId;
  token: string;
  scopes: readonly [typeof environmentCredentialScope];
  expiresAt: IsoDateTime;
}>;

const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

const rejectUnknown = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  path: string,
): DecodeResult<true> => {
  const allowed = new Set(keys);
  const key = Object.keys(value).find((candidate) => !allowed.has(candidate));
  return key === undefined
    ? decodeSuccess(true)
    : decodeFailure(`${path}.${key}`, "unknown_variant", "Unknown environment field.");
};

const decodePublicKey = (input: unknown, path: string): DecodeResult<EnvironmentPublicKey> => {
  const decoded = decodeString(input, path, { minLength: 43, maxLength: 43 });
  return decoded.ok && base64UrlPattern.test(decoded.value)
    ? decodeSuccess(decoded.value as EnvironmentPublicKey)
    : decoded.ok
      ? decodeFailure(path, "invalid_format", "Expected a base64url Ed25519 public key.")
      : decoded;
};

const decodeProof = (input: unknown, path: string): DecodeResult<EnvironmentProof> => {
  const decoded = decodeString(input, path, { minLength: 86, maxLength: 86 });
  return decoded.ok && base64UrlPattern.test(decoded.value)
    ? decodeSuccess(decoded.value as EnvironmentProof)
    : decoded.ok
      ? decodeFailure(path, "invalid_format", "Expected a base64url Ed25519 signature.")
      : decoded;
};

const decodePlatform = (input: unknown, path: string): DecodeResult<EnvironmentPlatform> =>
  input === "linux" || input === "macos" || input === "windows"
    ? decodeSuccess(input)
    : decodeFailure(path, "unknown_variant", "Expected linux, macos, or windows.");

export const decodeBeginEnvironmentPairingRequest = (
  input: unknown,
): DecodeResult<BeginEnvironmentPairingRequest> => {
  const record = decodeRecord(input, "$pairingChallenge");
  if (!record.ok) return record;
  const keys = rejectUnknown(
    record.value,
    ["displayName", "platform", "publicKey"],
    "$pairingChallenge",
  );
  if (!keys.ok) return keys;
  const displayName = decodeString(record.value.displayName, "$pairingChallenge.displayName", {
    minLength: 1,
    maxLength: maxEnvironmentDisplayNameLength,
  });
  const platform = decodePlatform(record.value.platform, "$pairingChallenge.platform");
  const publicKey = decodePublicKey(record.value.publicKey, "$pairingChallenge.publicKey");
  const issues = [displayName, platform, publicKey].flatMap((result) =>
    result.ok ? [] : result.issues,
  );
  if (issues.length > 0) return { ok: false, issues };
  if (!displayName.ok || !platform.ok || !publicKey.ok) {
    return decodeFailure("$pairingChallenge", "invalid_type", "Invalid pairing challenge request.");
  }
  return decodeSuccess({
    displayName: displayName.value.trim(),
    platform: platform.value,
    publicKey: publicKey.value,
  });
};

export const decodeApproveEnvironmentPairingRequest = (
  input: unknown,
): DecodeResult<ApproveEnvironmentPairingRequest> => {
  const record = decodeRecord(input, "$approvePairing");
  if (!record.ok) return record;
  const keys = rejectUnknown(record.value, ["organizationId", "pairingCode"], "$approvePairing");
  if (!keys.ok) return keys;
  const organizationId = decodeId<OrganizationId>(
    record.value.organizationId,
    "$approvePairing.organizationId",
  );
  const pairingCode = decodeString(record.value.pairingCode, "$approvePairing.pairingCode", {
    minLength: 11,
    maxLength: 11,
  });
  const issues = [organizationId, pairingCode].flatMap((result) =>
    result.ok ? [] : result.issues,
  );
  if (issues.length > 0) return { ok: false, issues };
  if (!organizationId.ok || !pairingCode.ok)
    return decodeFailure("$approvePairing", "invalid_type", "Invalid pairing approval.");
  return decodeSuccess({
    organizationId: organizationId.value,
    pairingCode: pairingCode.value.toUpperCase(),
  });
};

export const decodeEnvironmentPairingStatusRequest = (
  input: unknown,
): DecodeResult<EnvironmentPairingStatusRequest> => {
  const record = decodeRecord(input, "$pairingStatus");
  if (!record.ok) return record;
  const keys = rejectUnknown(record.value, ["pairingId", "pollingToken"], "$pairingStatus");
  if (!keys.ok) return keys;
  const pairingId = decodeId<EnvironmentChallengeId>(
    record.value.pairingId,
    "$pairingStatus.pairingId",
  );
  const pollingToken = decodeString(record.value.pollingToken, "$pairingStatus.pollingToken", {
    minLength: 43,
    maxLength: 128,
  });
  const issues = [pairingId, pollingToken].flatMap((result) => (result.ok ? [] : result.issues));
  if (issues.length > 0) return { ok: false, issues };
  if (!pairingId.ok || !pollingToken.ok)
    return decodeFailure("$pairingStatus", "invalid_type", "Invalid pairing status request.");
  return decodeSuccess({ pairingId: pairingId.value, pollingToken: pollingToken.value });
};

export const decodeBeginEnvironmentRotationRequest = (
  input: unknown,
): DecodeResult<BeginEnvironmentRotationRequest> => {
  const record = decodeRecord(input, "$beginRotation");
  if (!record.ok) return record;
  const keys = rejectUnknown(
    record.value,
    ["environmentId", "organizationId", "publicKey", "proofChallengeId", "signature"],
    "$beginRotation",
  );
  if (!keys.ok) return keys;
  const environmentId = decodeId<ExecutionEnvironmentId>(
    record.value.environmentId,
    "$beginRotation.environmentId",
  );
  const organizationId = decodeId<OrganizationId>(
    record.value.organizationId,
    "$beginRotation.organizationId",
  );
  const publicKey = decodePublicKey(record.value.publicKey, "$beginRotation.publicKey");
  const proofChallengeId = decodeId<EnvironmentChallengeId>(
    record.value.proofChallengeId,
    "$beginRotation.proofChallengeId",
  );
  const signature = decodeProof(record.value.signature, "$beginRotation.signature");
  const issues = [environmentId, organizationId, publicKey, proofChallengeId, signature].flatMap(
    (result) => (result.ok ? [] : result.issues),
  );
  if (issues.length > 0) return { ok: false, issues };
  if (
    !environmentId.ok ||
    !organizationId.ok ||
    !publicKey.ok ||
    !proofChallengeId.ok ||
    !signature.ok
  )
    return decodeFailure("$beginRotation", "invalid_type", "Invalid rotation request.");
  return decodeSuccess({
    environmentId: environmentId.value,
    organizationId: organizationId.value,
    publicKey: publicKey.value,
    proofChallengeId: proofChallengeId.value,
    signature: signature.value,
  });
};

export const decodeApproveEnvironmentRotationRequest = (
  input: unknown,
): DecodeResult<ApproveEnvironmentRotationRequest> => {
  const record = decodeRecord(input, "$approveRotation");
  if (!record.ok) return record;
  const keys = rejectUnknown(record.value, ["organizationId", "rotationCode"], "$approveRotation");
  if (!keys.ok) return keys;
  const organizationId = decodeId<OrganizationId>(
    record.value.organizationId,
    "$approveRotation.organizationId",
  );
  const rotationCode = decodeString(record.value.rotationCode, "$approveRotation.rotationCode", {
    minLength: 11,
    maxLength: 11,
  });
  const issues = [organizationId, rotationCode].flatMap((result) =>
    result.ok ? [] : result.issues,
  );
  if (issues.length > 0) return { ok: false, issues };
  if (!organizationId.ok || !rotationCode.ok)
    return decodeFailure("$approveRotation", "invalid_type", "Invalid rotation approval.");
  return decodeSuccess({
    organizationId: organizationId.value,
    rotationCode: rotationCode.value.toUpperCase(),
  });
};

export const decodeEnvironmentRotationStatusRequest = (
  input: unknown,
): DecodeResult<EnvironmentRotationStatusRequest> => {
  const record = decodeRecord(input, "$rotationStatus");
  if (!record.ok) return record;
  const keys = rejectUnknown(record.value, ["rotationId", "pollingToken"], "$rotationStatus");
  if (!keys.ok) return keys;
  const rotationId = decodeId<EnvironmentChallengeId>(
    record.value.rotationId,
    "$rotationStatus.rotationId",
  );
  const pollingToken = decodeString(record.value.pollingToken, "$rotationStatus.pollingToken", {
    minLength: 43,
    maxLength: 128,
  });
  const issues = [rotationId, pollingToken].flatMap((result) => (result.ok ? [] : result.issues));
  if (issues.length > 0) return { ok: false, issues };
  if (!rotationId.ok || !pollingToken.ok)
    return decodeFailure("$rotationStatus", "invalid_type", "Invalid rotation status request.");
  return decodeSuccess({ rotationId: rotationId.value, pollingToken: pollingToken.value });
};

export const decodeCompleteEnvironmentRotationRequest = (
  input: unknown,
): DecodeResult<CompleteEnvironmentRotationRequest> => {
  const record = decodeRecord(input, "$completeRotation");
  if (!record.ok) return record;
  const keys = rejectUnknown(
    record.value,
    ["rotationId", "pollingToken", "currentKeySignature", "replacementKeySignature"],
    "$completeRotation",
  );
  if (!keys.ok) return keys;
  const rotationId = decodeId<EnvironmentChallengeId>(
    record.value.rotationId,
    "$completeRotation.rotationId",
  );
  const pollingToken = decodeString(record.value.pollingToken, "$completeRotation.pollingToken", {
    minLength: 43,
    maxLength: 128,
  });
  const currentKeySignature = decodeProof(
    record.value.currentKeySignature,
    "$completeRotation.currentKeySignature",
  );
  const replacementKeySignature = decodeProof(
    record.value.replacementKeySignature,
    "$completeRotation.replacementKeySignature",
  );
  const issues = [rotationId, pollingToken, currentKeySignature, replacementKeySignature].flatMap(
    (result) => (result.ok ? [] : result.issues),
  );
  if (issues.length > 0) return { ok: false, issues };
  if (!rotationId.ok || !pollingToken.ok || !currentKeySignature.ok || !replacementKeySignature.ok)
    return decodeFailure("$completeRotation", "invalid_type", "Invalid rotation completion.");
  return decodeSuccess({
    rotationId: rotationId.value,
    pollingToken: pollingToken.value,
    currentKeySignature: currentKeySignature.value,
    replacementKeySignature: replacementKeySignature.value,
  });
};

export const decodeCompleteEnvironmentProofRequest = (
  input: unknown,
): DecodeResult<CompleteEnvironmentProofRequest> => {
  const record = decodeRecord(input, "$environmentProof");
  if (!record.ok) return record;
  const keys = rejectUnknown(
    record.value,
    ["challengeId", "signature", "pollingToken"],
    "$environmentProof",
  );
  if (!keys.ok) return keys;
  const challengeId = decodeId<EnvironmentChallengeId>(
    record.value.challengeId,
    "$environmentProof.challengeId",
  );
  const signature = decodeProof(record.value.signature, "$environmentProof.signature");
  const pollingToken =
    record.value.pollingToken === undefined
      ? decodeSuccess<string | undefined>(undefined)
      : decodeString(record.value.pollingToken, "$environmentProof.pollingToken", {
          minLength: 43,
          maxLength: 128,
        });
  const issues = [challengeId, signature, pollingToken].flatMap((result) =>
    result.ok ? [] : result.issues,
  );
  if (issues.length > 0) return { ok: false, issues };
  if (!challengeId.ok || !signature.ok || !pollingToken.ok) {
    return decodeFailure("$environmentProof", "invalid_type", "Invalid environment proof.");
  }
  return decodeSuccess({
    challengeId: challengeId.value,
    signature: signature.value,
    ...(pollingToken.value === undefined ? {} : { pollingToken: pollingToken.value }),
  });
};

export const decodeCreateCredentialChallengeRequest = (
  input: unknown,
): DecodeResult<CreateCredentialChallengeRequest> => {
  const record = decodeRecord(input, "$credentialChallenge");
  if (!record.ok) return record;
  const keys = rejectUnknown(record.value, ["environmentId"], "$credentialChallenge");
  if (!keys.ok) return keys;
  const environmentId = decodeId<ExecutionEnvironmentId>(
    record.value.environmentId,
    "$credentialChallenge.environmentId",
  );
  return environmentId.ok ? decodeSuccess({ environmentId: environmentId.value }) : environmentId;
};

export const decodeEnvironmentIdentityChallenge = (
  input: unknown,
): DecodeResult<EnvironmentIdentityChallenge> => {
  const record = decodeRecord(input, "$identityChallenge");
  if (!record.ok) return record;
  const keys = rejectUnknown(
    record.value,
    ["challengeId", "challenge", "expiresAt"],
    "$identityChallenge",
  );
  if (!keys.ok) return keys;
  const challengeId = decodeId<EnvironmentChallengeId>(
    record.value.challengeId,
    "$identityChallenge.challengeId",
  );
  const challenge = decodeString(record.value.challenge, "$identityChallenge.challenge", {
    minLength: 32,
    maxLength: 1024,
  });
  const expiresAt = decodeIsoDateTime(record.value.expiresAt, "$identityChallenge.expiresAt");
  const issues = [challengeId, challenge, expiresAt].flatMap((result) =>
    result.ok ? [] : result.issues,
  );
  if (issues.length > 0) return { ok: false, issues };
  if (!challengeId.ok || !challenge.ok || !expiresAt.ok)
    return decodeFailure("$identityChallenge", "invalid_type", "Invalid identity challenge.");
  return decodeSuccess({
    challengeId: challengeId.value,
    challenge: challenge.value,
    expiresAt: expiresAt.value,
  });
};

export const decodeExecutionEnvironment = (input: unknown): DecodeResult<ExecutionEnvironment> => {
  const record = decodeRecord(input, "$environment");
  if (!record.ok) return record;
  const keys = rejectUnknown(
    record.value,
    [
      "id",
      "organizationId",
      "displayName",
      "platform",
      "publicKey",
      "keyVersion",
      "createdByUserId",
      "createdAt",
      "updatedAt",
      "revokedAt",
    ],
    "$environment",
  );
  if (!keys.ok) return keys;
  const id = decodeId<ExecutionEnvironmentId>(record.value.id, "$environment.id");
  const organizationId = decodeId<OrganizationId>(
    record.value.organizationId,
    "$environment.organizationId",
  );
  const displayName = decodeString(record.value.displayName, "$environment.displayName", {
    minLength: 1,
    maxLength: maxEnvironmentDisplayNameLength,
  });
  const platform = decodePlatform(record.value.platform, "$environment.platform");
  const publicKey = decodePublicKey(record.value.publicKey, "$environment.publicKey");
  const keyVersion = decodeInteger(record.value.keyVersion, "$environment.keyVersion", { min: 1 });
  const createdByUserId = decodeId<UserId>(
    record.value.createdByUserId,
    "$environment.createdByUserId",
  );
  const createdAt = decodeIsoDateTime(record.value.createdAt, "$environment.createdAt");
  const updatedAt = decodeIsoDateTime(record.value.updatedAt, "$environment.updatedAt");
  const revokedAt =
    record.value.revokedAt === null
      ? decodeSuccess<null>(null)
      : decodeIsoDateTime(record.value.revokedAt, "$environment.revokedAt");
  const values = [
    id,
    organizationId,
    displayName,
    platform,
    publicKey,
    keyVersion,
    createdByUserId,
    createdAt,
    updatedAt,
    revokedAt,
  ];
  const issues = values.flatMap((result) => (result.ok ? [] : result.issues));
  if (issues.length > 0) return { ok: false, issues };
  if (
    !id.ok ||
    !organizationId.ok ||
    !displayName.ok ||
    !platform.ok ||
    !publicKey.ok ||
    !keyVersion.ok ||
    !createdByUserId.ok ||
    !createdAt.ok ||
    !updatedAt.ok ||
    !revokedAt.ok
  )
    return decodeFailure("$environment", "invalid_type", "Invalid execution environment.");
  return decodeSuccess({
    id: id.value,
    organizationId: organizationId.value,
    displayName: displayName.value,
    platform: platform.value,
    publicKey: publicKey.value,
    keyVersion: keyVersion.value,
    createdByUserId: createdByUserId.value,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
    revokedAt: revokedAt.value,
  });
};

export const decodeExecutionEnvironmentList = (
  input: unknown,
): DecodeResult<readonly ExecutionEnvironment[]> => {
  if (!Array.isArray(input) || input.length > 1_000)
    return decodeFailure("$environments", "out_of_range", "Expected at most 1,000 environments.");
  const environments: ExecutionEnvironment[] = [];
  for (const value of input) {
    const environment = decodeExecutionEnvironment(value);
    if (!environment.ok) return environment;
    environments.push(environment.value);
  }
  return decodeSuccess(environments);
};

const decodeApprovalResponse = (
  input: unknown,
  kind: "pairing" | "rotation",
): DecodeResult<BeginEnvironmentPairingResponse | BeginEnvironmentRotationResponse> => {
  const path = kind === "pairing" ? "$pairingResponse" : "$rotationResponse";
  const record = decodeRecord(input, path);
  if (!record.ok) return record;
  const idKey = kind === "pairing" ? "pairingId" : "rotationId";
  const codeKey = kind === "pairing" ? "pairingCode" : "rotationCode";
  const keys = rejectUnknown(
    record.value,
    [idKey, codeKey, "pollingToken", "approvalPath", "expiresAt"],
    path,
  );
  if (!keys.ok) return keys;
  const id = decodeId<EnvironmentChallengeId>(record.value[idKey], `${path}.${idKey}`);
  const code = decodeString(record.value[codeKey], `${path}.${codeKey}`, {
    minLength: 11,
    maxLength: 11,
  });
  const pollingToken = decodeString(record.value.pollingToken, `${path}.pollingToken`, {
    minLength: 43,
    maxLength: 128,
  });
  const expectedPath =
    kind === "pairing" ? environmentPairingApprovalPath : environmentRotationApprovalPath;
  const approvalPath =
    record.value.approvalPath === expectedPath
      ? decodeSuccess(expectedPath)
      : decodeFailure(`${path}.approvalPath`, "invalid_format", "Unexpected approval path.");
  const expiresAt = decodeIsoDateTime(record.value.expiresAt, `${path}.expiresAt`);
  const issues = [id, code, pollingToken, approvalPath, expiresAt].flatMap((result) =>
    result.ok ? [] : result.issues,
  );
  if (issues.length > 0) return { ok: false, issues };
  if (!id.ok || !code.ok || !pollingToken.ok || !approvalPath.ok || !expiresAt.ok)
    return decodeFailure(path, "invalid_type", "Invalid approval response.");
  return decodeSuccess(
    kind === "pairing"
      ? {
          pairingId: id.value,
          pairingCode: code.value,
          pollingToken: pollingToken.value,
          approvalPath: approvalPath.value,
          expiresAt: expiresAt.value,
        }
      : {
          rotationId: id.value,
          rotationCode: code.value,
          pollingToken: pollingToken.value,
          approvalPath: approvalPath.value,
          expiresAt: expiresAt.value,
        },
  );
};

export const decodeBeginEnvironmentPairingResponse = (
  input: unknown,
): DecodeResult<BeginEnvironmentPairingResponse> =>
  decodeApprovalResponse(input, "pairing") as DecodeResult<BeginEnvironmentPairingResponse>;

export const decodeBeginEnvironmentRotationResponse = (
  input: unknown,
): DecodeResult<BeginEnvironmentRotationResponse> =>
  decodeApprovalResponse(input, "rotation") as DecodeResult<BeginEnvironmentRotationResponse>;

export const decodeEnvironmentPairingStatus = (
  input: unknown,
): DecodeResult<EnvironmentPairingStatus> => {
  const record = decodeRecord(input, "$pairingStatusResponse");
  if (!record.ok) return record;
  const status = record.value.status;
  const keys = rejectUnknown(
    record.value,
    status === "approved" ? ["status", "challenge", "expiresAt"] : ["status", "expiresAt"],
    "$pairingStatusResponse",
  );
  if (!keys.ok) return keys;
  const expiresAt = decodeIsoDateTime(record.value.expiresAt, "$pairingStatusResponse.expiresAt");
  if (!expiresAt.ok) return expiresAt;
  if (status === "pending") return decodeSuccess({ status, expiresAt: expiresAt.value });
  if (status !== "approved")
    return decodeFailure(
      "$pairingStatusResponse.status",
      "unknown_variant",
      "Unknown pairing status.",
    );
  const challenge = decodeString(record.value.challenge, "$pairingStatusResponse.challenge", {
    minLength: 32,
    maxLength: 1_024,
  });
  return challenge.ok
    ? decodeSuccess({ status, challenge: challenge.value, expiresAt: expiresAt.value })
    : challenge;
};

export const decodeEnvironmentRotationStatus = (
  input: unknown,
): DecodeResult<EnvironmentRotationStatus> => {
  const record = decodeRecord(input, "$rotationStatusResponse");
  if (!record.ok) return record;
  if (record.value.status === "completed") {
    const keys = rejectUnknown(record.value, ["status", "environment"], "$rotationStatusResponse");
    if (!keys.ok) return keys;
    const environment = decodeExecutionEnvironment(record.value.environment);
    return environment.ok
      ? decodeSuccess({ status: "completed", environment: environment.value })
      : environment;
  }
  const paired = decodeEnvironmentPairingStatus(input);
  return paired.ok ? decodeSuccess(paired.value) : paired;
};

export const decodeEnvironmentCredential = (
  input: unknown,
): DecodeResult<EnvironmentCredential> => {
  const record = decodeRecord(input, "$environmentCredential");
  if (!record.ok) return record;
  const keys = rejectUnknown(
    record.value,
    ["credentialId", "environmentId", "organizationId", "token", "scopes", "expiresAt"],
    "$environmentCredential",
  );
  if (!keys.ok) return keys;
  const credentialId = decodeId<EnvironmentCredentialId>(
    record.value.credentialId,
    "$environmentCredential.credentialId",
  );
  const environmentId = decodeId<ExecutionEnvironmentId>(
    record.value.environmentId,
    "$environmentCredential.environmentId",
  );
  const organizationId = decodeId<OrganizationId>(
    record.value.organizationId,
    "$environmentCredential.organizationId",
  );
  const token = decodeString(record.value.token, "$environmentCredential.token", {
    minLength: 32,
    maxLength: 4_096,
  });
  const scopes =
    Array.isArray(record.value.scopes) &&
    record.value.scopes.length === 1 &&
    record.value.scopes[0] === environmentCredentialScope
      ? decodeSuccess([environmentCredentialScope] as const)
      : decodeFailure(
          "$environmentCredential.scopes",
          "invalid_format",
          "Unexpected credential scope.",
        );
  const expiresAt = decodeIsoDateTime(record.value.expiresAt, "$environmentCredential.expiresAt");
  const issues = [credentialId, environmentId, organizationId, token, scopes, expiresAt].flatMap(
    (result) => (result.ok ? [] : result.issues),
  );
  if (issues.length > 0) return { ok: false, issues };
  if (
    !credentialId.ok ||
    !environmentId.ok ||
    !organizationId.ok ||
    !token.ok ||
    !scopes.ok ||
    !expiresAt.ok
  )
    return decodeFailure(
      "$environmentCredential",
      "invalid_type",
      "Invalid environment credential.",
    );
  return decodeSuccess({
    credentialId: credentialId.value,
    environmentId: environmentId.value,
    organizationId: organizationId.value,
    token: token.value,
    scopes: scopes.value,
    expiresAt: expiresAt.value,
  });
};
