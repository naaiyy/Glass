import type {
  ApproveEnvironmentPairingRequest,
  ApproveEnvironmentRotationRequest,
  BeginEnvironmentRotationResponse,
  BeginEnvironmentPairingRequest,
  BeginEnvironmentPairingResponse,
  CompleteEnvironmentProofRequest,
  CreateCredentialChallengeRequest,
  EnvironmentCredential,
  EnvironmentIdentityChallenge,
  EnvironmentPairingStatus,
  EnvironmentPairingStatusRequest,
  EnvironmentRotationStatus,
  EnvironmentRotationStatusRequest,
  CompleteEnvironmentRotationRequest,
  EnvironmentPublicKey,
  ExecutionEnvironment,
} from "@glass/contracts/environments";
import {
  environmentCredentialScope,
  environmentPairingApprovalPath,
  environmentRotationApprovalPath,
} from "@glass/contracts/environments";
import type {
  EnvironmentChallengeId,
  EnvironmentCredentialId,
  ExecutionEnvironmentId,
  IsoDateTime,
  OrganizationId,
  UserId,
} from "@glass/contracts/ids";
import type { Client, QueryResultRow } from "pg";

export type EnvironmentFailureCode = "conflict" | "forbidden" | "invalid" | "not-found";

export class EnvironmentFailure extends Error {
  readonly retryable = false;
  readonly code: EnvironmentFailureCode;
  constructor(code: EnvironmentFailureCode, message: string) {
    super(message);
    this.code = code;
    this.name = "EnvironmentFailure";
  }
}

export type VerifiedEnvironmentCredential = Readonly<{
  credentialId: EnvironmentCredentialId;
  environmentId: ExecutionEnvironmentId;
  organizationId: OrganizationId;
  keyVersion: number;
  scopes: readonly string[];
}>;

export interface EnvironmentService {
  beginPairing(request: BeginEnvironmentPairingRequest): Promise<BeginEnvironmentPairingResponse>;
  approvePairing(userId: string, request: ApproveEnvironmentPairingRequest): Promise<void>;
  pairingStatus(request: EnvironmentPairingStatusRequest): Promise<EnvironmentPairingStatus>;
  completePairing(request: CompleteEnvironmentProofRequest): Promise<ExecutionEnvironment>;
  beginRotation(
    credential: VerifiedEnvironmentCredential,
    publicKey: EnvironmentPublicKey,
  ): Promise<BeginEnvironmentRotationResponse>;
  approveRotation(userId: string, request: ApproveEnvironmentRotationRequest): Promise<void>;
  rotationStatus(request: EnvironmentRotationStatusRequest): Promise<EnvironmentRotationStatus>;
  completeRotation(request: CompleteEnvironmentRotationRequest): Promise<ExecutionEnvironment>;
  list(userId: string, organizationId: OrganizationId): Promise<readonly ExecutionEnvironment[]>;
  createCredentialChallenge(
    request: CreateCredentialChallengeRequest,
  ): Promise<EnvironmentIdentityChallenge>;
  exchangeCredential(request: CompleteEnvironmentProofRequest): Promise<EnvironmentCredential>;
  revoke(userId: string, environmentId: ExecutionEnvironmentId): Promise<ExecutionEnvironment>;
  authorizeUserEnvironment(
    userId: string,
    organizationId: OrganizationId,
    environmentId: ExecutionEnvironmentId,
  ): Promise<ExecutionEnvironment | null>;
  hasActiveEnvironment(
    organizationId: OrganizationId,
    environmentId: ExecutionEnvironmentId,
  ): Promise<boolean>;
  authenticateCredential(
    token: string,
    requiredScope: string,
  ): Promise<VerifiedEnvironmentCredential | null>;
  verifyCredentialProof(
    token: string,
    requiredScope: string,
    challenge: string,
    signature: string,
  ): Promise<VerifiedEnvironmentCredential | null>;
}

type ChallengeRow = QueryResultRow & {
  id: string;
  organization_id: string | null;
  environment_id: string | null;
  purpose: "pair" | "credential" | "rotate";
  challenge: string | null;
  polling_token_hash: string | null;
  verification_public_key: string;
  requested_public_key: string | null;
  display_name: string | null;
  platform: "linux" | "macos" | "windows" | null;
  requested_by_user_id: string | null;
  expires_at: Date | string;
  consumed_at: Date | string | null;
};

const challengeLifetimeMs = 5 * 60 * 1_000;
const credentialLifetimeMs = 15 * 60 * 1_000;
const encoder = new TextEncoder();

const asIso = (value: Date | string): IsoDateTime =>
  (value instanceof Date ? value : new Date(value)).toISOString() as IsoDateTime;

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const randomToken = (bytes = 32): string => {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64Url(value);
};

const digest = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return base64Url(new Uint8Array(bytes));
};

const constantTimeEqual = (left: string, right: string): boolean => {
  const maximum = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximum; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
};

const verifyProof = async (
  publicKey: string,
  challenge: string,
  signature: string,
): Promise<boolean> => {
  try {
    const publicKeyBytes = Uint8Array.from(fromBase64Url(publicKey)).buffer;
    const signatureBytes = Uint8Array.from(fromBase64Url(signature)).buffer;
    const challengeBytes = Uint8Array.from(encoder.encode(challenge)).buffer;
    const key = await crypto.subtle.importKey("raw", publicKeyBytes, { name: "Ed25519" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify("Ed25519", key, signatureBytes, challengeBytes);
  } catch {
    return false;
  }
};

const pairingCode = (): string => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const characters = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
  return `${characters.slice(0, 5)}-${characters.slice(5)}`;
};

const queryOne = async <Row extends QueryResultRow>(
  client: Client,
  text: string,
  values: readonly unknown[] = [],
): Promise<Row | null> => {
  const result = await client.query<Row>(text, [...values]);
  return result.rows[0] ?? null;
};

type EnvironmentSecurityEventType =
  | "credential-issued"
  | "environment-revoked"
  | "key-rotation-approved"
  | "key-rotation-requested"
  | "key-rotated"
  | "pairing-approved"
  | "pairing-completed"
  | "pairing-requested";

const appendSecurityEvent = (
  client: Client,
  event: Readonly<{
    actorUserId: string | null;
    correlationId: string;
    environmentId: string | null;
    metadata: Readonly<Record<string, boolean | number | string | readonly string[] | null>>;
    organizationId: string | null;
    type: EnvironmentSecurityEventType;
  }>,
): Promise<unknown> =>
  client.query(
    `insert into environment_security_events
      (id, organization_id, environment_id, type, actor_user_id, correlation_id, metadata)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      crypto.randomUUID(),
      event.organizationId,
      event.environmentId,
      event.type,
      event.actorUserId,
      event.correlationId,
      event.metadata,
    ],
  );

const transaction = async <Value>(
  client: Client,
  operation: () => Promise<Value>,
): Promise<Value> => {
  await client.query("begin");
  try {
    const result = await operation();
    await client.query("commit");
    return result;
  } catch (cause) {
    await client.query("rollback");
    throw cause;
  }
};

const requireAdministrator = async (
  client: Client,
  organizationId: string,
  userId: string,
): Promise<void> => {
  const row = await queryOne(
    client,
    `select role from organization_members where organization_id = $1 and user_id = $2 and removed_at is null`,
    [organizationId, userId],
  );
  if (row === null || (row.role !== "owner" && row.role !== "admin")) {
    throw new EnvironmentFailure(
      "forbidden",
      "An organization administrator must approve execution environments.",
    );
  }
};

const environmentFromRow = (row: QueryResultRow): ExecutionEnvironment => ({
  id: String(row.id) as ExecutionEnvironmentId,
  organizationId: String(row.organization_id) as OrganizationId,
  displayName: String(row.display_name),
  platform: row.platform as ExecutionEnvironment["platform"],
  publicKey: row.public_key as ExecutionEnvironment["publicKey"],
  keyVersion: Number(row.key_version),
  createdByUserId: String(row.created_by_user_id) as UserId,
  createdAt: asIso(row.created_at as Date | string),
  updatedAt: asIso(row.updated_at as Date | string),
  revokedAt: row.revoked_at === null ? null : asIso(row.revoked_at as Date | string),
});

const readChallenge = (client: Client, id: string): Promise<ChallengeRow | null> =>
  queryOne<ChallengeRow>(
    client,
    `select * from environment_identity_challenges where id = $1 for update`,
    [id],
  );

const requireLiveChallenge = (
  row: ChallengeRow | null,
  purpose: ChallengeRow["purpose"],
): ChallengeRow => {
  if (row === null || row.purpose !== purpose)
    throw new EnvironmentFailure("not-found", "The environment challenge does not exist.");
  if (row.consumed_at !== null)
    throw new EnvironmentFailure("conflict", "The environment challenge was already consumed.");
  if (new Date(row.expires_at).getTime() <= Date.now())
    throw new EnvironmentFailure("conflict", "The environment challenge expired.");
  return row;
};

export const createPostgresEnvironmentService = (client: Client): EnvironmentService => ({
  beginPairing: (request) =>
    transaction(client, async () => {
      await client.query(`delete from environment_identity_challenges where expires_at <= now()`);
      // The key-specific advisory lock makes the active-request bound race safe across API workers.
      await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [request.publicKey]);
      const activePairings = await queryOne(
        client,
        `select count(*)::integer as count
           from environment_identity_challenges
          where purpose = 'pair' and verification_public_key = $1
            and consumed_at is null and expires_at > now()`,
        [request.publicKey],
      );
      if (Number(activePairings?.count ?? 0) >= 3)
        throw new EnvironmentFailure(
          "conflict",
          "Too many pairing requests are active for this environment key.",
        );
      const id = crypto.randomUUID();
      const code = pairingCode();
      const poll = randomToken();
      const expiresAt = new Date(Date.now() + challengeLifetimeMs);
      await client.query(
        `insert into environment_identity_challenges
        (id, purpose, verification_public_key, requested_public_key, display_name, platform, pairing_code_hash, polling_token_hash, expires_at)
       values ($1, 'pair', $2, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          request.publicKey,
          request.displayName,
          request.platform,
          await digest(code),
          await digest(poll),
          expiresAt,
        ],
      );
      await appendSecurityEvent(client, {
        actorUserId: null,
        correlationId: id,
        environmentId: null,
        metadata: { displayName: request.displayName, platform: request.platform },
        organizationId: null,
        type: "pairing-requested",
      });
      return {
        pairingId: id as EnvironmentChallengeId,
        pairingCode: code,
        pollingToken: poll,
        approvalPath: environmentPairingApprovalPath,
        expiresAt: expiresAt.toISOString() as IsoDateTime,
      };
    }),

  approvePairing: (userId, request) =>
    transaction(client, async () => {
      await requireAdministrator(client, request.organizationId, userId);
      const row = await queryOne<ChallengeRow>(
        client,
        `select * from environment_identity_challenges where purpose = 'pair' and pairing_code_hash = $1 for update`,
        [await digest(request.pairingCode)],
      );
      const challengeRow = requireLiveChallenge(row, "pair");
      if (challengeRow.requested_by_user_id !== null)
        throw new EnvironmentFailure("conflict", "The pairing request was already approved.");
      const challenge = [
        "glass-environment-pair-v1",
        challengeRow.id,
        request.organizationId,
        challengeRow.verification_public_key,
        challengeRow.display_name,
        challengeRow.platform,
      ].join("\n");
      await client.query(
        `update environment_identity_challenges set organization_id = $1, requested_by_user_id = $2, challenge = $3 where id = $4`,
        [request.organizationId, userId, challenge, challengeRow.id],
      );
      await appendSecurityEvent(client, {
        actorUserId: userId,
        correlationId: challengeRow.id,
        environmentId: null,
        metadata: {
          displayName: challengeRow.display_name,
          platform: challengeRow.platform,
        },
        organizationId: request.organizationId,
        type: "pairing-approved",
      });
    }),

  pairingStatus: (request) =>
    transaction(client, async () => {
      const row = requireLiveChallenge(await readChallenge(client, request.pairingId), "pair");
      if (!constantTimeEqual(row.polling_token_hash ?? "", await digest(request.pollingToken)))
        throw new EnvironmentFailure("not-found", "The pairing request does not exist.");
      return row.challenge === null
        ? { status: "pending", expiresAt: asIso(row.expires_at) }
        : { status: "approved", challenge: row.challenge, expiresAt: asIso(row.expires_at) };
    }),

  completePairing: (request) =>
    transaction(client, async () => {
      if (request.pollingToken === undefined)
        throw new EnvironmentFailure("invalid", "The pairing polling token is required.");
      const row = requireLiveChallenge(await readChallenge(client, request.challengeId), "pair");
      if (!constantTimeEqual(row.polling_token_hash ?? "", await digest(request.pollingToken)))
        throw new EnvironmentFailure("not-found", "The pairing request does not exist.");
      if (
        row.organization_id === null ||
        row.requested_by_user_id === null ||
        row.challenge === null ||
        row.display_name === null ||
        row.platform === null
      ) {
        throw new EnvironmentFailure("conflict", "The pairing request has not been approved.");
      }
      if (!(await verifyProof(row.verification_public_key, row.challenge, request.signature)))
        throw new EnvironmentFailure(
          "forbidden",
          "The environment did not prove possession of its private key.",
        );
      const id = crypto.randomUUID();
      const result = await client.query<QueryResultRow>(
        `insert into execution_environments (id, organization_id, display_name, platform, public_key, created_by_user_id)
       values ($1, $2, $3, $4, $5, $6) returning *`,
        [
          id,
          row.organization_id,
          row.display_name,
          row.platform,
          row.verification_public_key,
          row.requested_by_user_id,
        ],
      );
      await client.query(
        `update environment_identity_challenges set consumed_at = now() where id = $1`,
        [row.id],
      );
      await appendSecurityEvent(client, {
        actorUserId: null,
        correlationId: row.id,
        environmentId: id,
        metadata: { keyVersion: 1, platform: row.platform },
        organizationId: row.organization_id,
        type: "pairing-completed",
      });
      return environmentFromRow(result.rows[0]!);
    }),

  beginRotation: (credential, publicKey) =>
    transaction(client, async () => {
      const environment = await queryOne(
        client,
        `select * from execution_environments where id = $1 and organization_id = $2 and revoked_at is null for update`,
        [credential.environmentId, credential.organizationId],
      );
      if (environment === null || Number(environment.key_version) !== credential.keyVersion)
        throw new EnvironmentFailure(
          "forbidden",
          "The environment credential is no longer current.",
        );
      if (environment.public_key === publicKey)
        throw new EnvironmentFailure(
          "conflict",
          "The replacement key must differ from the active key.",
        );
      const active = await queryOne(
        client,
        `select count(*)::integer as count from environment_identity_challenges where environment_id = $1 and purpose = 'rotate' and consumed_at is null and expires_at > now()`,
        [credential.environmentId],
      );
      if (Number(active?.count ?? 0) >= 2)
        throw new EnvironmentFailure(
          "conflict",
          "Too many key rotations are active for this environment.",
        );
      const id = crypto.randomUUID();
      const code = pairingCode();
      const poll = randomToken();
      const expiresAt = new Date(Date.now() + challengeLifetimeMs);
      await client.query(
        `insert into environment_identity_challenges
          (id, organization_id, environment_id, purpose, verification_public_key, requested_public_key, pairing_code_hash, polling_token_hash, expires_at)
         values ($1, $2, $3, 'rotate', $4, $5, $6, $7, $8)`,
        [
          id,
          credential.organizationId,
          credential.environmentId,
          environment.public_key,
          publicKey,
          await digest(code),
          await digest(poll),
          expiresAt,
        ],
      );
      await appendSecurityEvent(client, {
        actorUserId: null,
        correlationId: id,
        environmentId: credential.environmentId,
        metadata: { keyVersion: credential.keyVersion },
        organizationId: credential.organizationId,
        type: "key-rotation-requested",
      });
      return {
        rotationId: id as EnvironmentChallengeId,
        rotationCode: code,
        pollingToken: poll,
        approvalPath: environmentRotationApprovalPath,
        expiresAt: expiresAt.toISOString() as IsoDateTime,
      };
    }),

  approveRotation: (userId, request) =>
    transaction(client, async () => {
      await requireAdministrator(client, request.organizationId, userId);
      const row = requireLiveChallenge(
        await queryOne<ChallengeRow>(
          client,
          `select * from environment_identity_challenges where purpose = 'rotate' and pairing_code_hash = $1 for update`,
          [await digest(request.rotationCode)],
        ),
        "rotate",
      );
      if (row.organization_id !== request.organizationId)
        throw new EnvironmentFailure(
          "forbidden",
          "The rotation request belongs to another organization.",
        );
      if (row.requested_by_user_id !== null)
        throw new EnvironmentFailure("conflict", "The rotation request was already approved.");
      const challenge = [
        "glass-environment-rotate-v2",
        row.id,
        row.environment_id,
        row.organization_id,
        row.verification_public_key,
        row.requested_public_key,
        randomToken(),
      ].join("\n");
      await client.query(
        `update environment_identity_challenges set requested_by_user_id = $1, challenge = $2 where id = $3`,
        [userId, challenge, row.id],
      );
      await appendSecurityEvent(client, {
        actorUserId: userId,
        correlationId: row.id,
        environmentId: row.environment_id,
        metadata: {},
        organizationId: request.organizationId,
        type: "key-rotation-approved",
      });
    }),

  rotationStatus: (request) =>
    transaction(client, async () => {
      const row = await readChallenge(client, request.rotationId);
      if (
        row === null ||
        row.purpose !== "rotate" ||
        !constantTimeEqual(row.polling_token_hash ?? "", await digest(request.pollingToken))
      )
        throw new EnvironmentFailure("not-found", "The rotation request does not exist.");
      if (row.consumed_at !== null) {
        const environment = await queryOne(
          client,
          `select * from execution_environments where id = $1 and public_key = $2`,
          [row.environment_id, row.requested_public_key],
        );
        if (environment === null)
          throw new EnvironmentFailure("conflict", "The completed rotation state is unavailable.");
        return { status: "completed", environment: environmentFromRow(environment) };
      }
      if (new Date(row.expires_at).getTime() <= Date.now())
        throw new EnvironmentFailure("conflict", "The rotation request expired.");
      return row.challenge === null
        ? { status: "pending", expiresAt: asIso(row.expires_at) }
        : { status: "approved", challenge: row.challenge, expiresAt: asIso(row.expires_at) };
    }),

  completeRotation: (request) =>
    transaction(client, async () => {
      const row = await readChallenge(client, request.rotationId);
      if (
        row === null ||
        row.purpose !== "rotate" ||
        !constantTimeEqual(row.polling_token_hash ?? "", await digest(request.pollingToken))
      )
        throw new EnvironmentFailure("not-found", "The rotation request does not exist.");
      if (row.consumed_at !== null) {
        const completed = await queryOne(
          client,
          `select * from execution_environments where id = $1 and public_key = $2`,
          [row.environment_id, row.requested_public_key],
        );
        if (completed === null)
          throw new EnvironmentFailure("conflict", "The completed rotation state is unavailable.");
        return environmentFromRow(completed);
      }
      const live = requireLiveChallenge(row, "rotate");
      if (
        live.environment_id === null ||
        live.organization_id === null ||
        live.challenge === null ||
        live.requested_public_key === null ||
        live.requested_by_user_id === null
      )
        throw new EnvironmentFailure("conflict", "The rotation request has not been approved.");
      await requireAdministrator(client, live.organization_id, live.requested_by_user_id);
      const [currentProof, replacementProof] = await Promise.all([
        verifyProof(live.verification_public_key, live.challenge, request.currentKeySignature),
        verifyProof(live.requested_public_key, live.challenge, request.replacementKeySignature),
      ]);
      if (!currentProof || !replacementProof)
        throw new EnvironmentFailure(
          "forbidden",
          "Both the current and replacement environment keys must prove possession.",
        );
      const result = await client.query<QueryResultRow>(
        `update execution_environments set public_key = $1, key_version = key_version + 1, updated_at = now() where id = $2 and public_key = $3 and revoked_at is null returning *`,
        [live.requested_public_key, live.environment_id, live.verification_public_key],
      );
      if (result.rows.length !== 1)
        throw new EnvironmentFailure(
          "conflict",
          "The environment key changed before rotation completed.",
        );
      await client.query(
        `update environment_credentials set revoked_at = now() where environment_id = $1 and revoked_at is null`,
        [live.environment_id],
      );
      await client.query(
        `update environment_identity_challenges set consumed_at = now() where id = $1`,
        [live.id],
      );
      const rotated = result.rows[0]!;
      await appendSecurityEvent(client, {
        actorUserId: live.requested_by_user_id,
        correlationId: live.id,
        environmentId: live.environment_id,
        metadata: { keyVersion: Number(rotated.key_version) },
        organizationId: live.organization_id,
        type: "key-rotated",
      });
      return environmentFromRow(rotated);
    }),

  list: async (userId, organizationId) => {
    const member = await queryOne(
      client,
      `select 1 from organization_members where organization_id = $1 and user_id = $2 and removed_at is null`,
      [organizationId, userId],
    );
    if (member === null)
      throw new EnvironmentFailure("forbidden", "The organization is not available to this user.");
    const result = await client.query<QueryResultRow>(
      `select * from execution_environments where organization_id = $1 order by id asc`,
      [organizationId],
    );
    return result.rows.map(environmentFromRow);
  },

  createCredentialChallenge: (request) =>
    transaction(client, async () => {
      const environment = await queryOne(
        client,
        `select * from execution_environments where id = $1 and revoked_at is null for update`,
        [request.environmentId],
      );
      if (environment === null)
        throw new EnvironmentFailure("not-found", "The execution environment does not exist.");
      const active = await queryOne(
        client,
        `select count(*)::integer as count from environment_identity_challenges where environment_id = $1 and purpose = 'credential' and consumed_at is null and expires_at > now()`,
        [request.environmentId],
      );
      if (Number(active?.count ?? 0) >= 5)
        throw new EnvironmentFailure(
          "conflict",
          "Too many credential challenges are active for this environment.",
        );
      const id = crypto.randomUUID();
      const nonce = randomToken();
      const expiresAt = new Date(Date.now() + challengeLifetimeMs);
      const challenge = [
        "glass-environment-credential-v1",
        id,
        request.environmentId,
        environment.organization_id,
        environment.key_version,
        nonce,
      ].join("\n");
      await client.query(
        `insert into environment_identity_challenges (id, organization_id, environment_id, purpose, challenge, verification_public_key, expires_at) values ($1, $2, $3, 'credential', $4, $5, $6)`,
        [
          id,
          environment.organization_id,
          request.environmentId,
          challenge,
          environment.public_key,
          expiresAt,
        ],
      );
      return {
        challengeId: id as EnvironmentChallengeId,
        challenge,
        expiresAt: expiresAt.toISOString() as IsoDateTime,
      };
    }),

  exchangeCredential: (request) =>
    transaction(client, async () => {
      const row = requireLiveChallenge(
        await readChallenge(client, request.challengeId),
        "credential",
      );
      if (row.challenge === null || row.environment_id === null || row.organization_id === null)
        throw new EnvironmentFailure("invalid", "The credential challenge is incomplete.");
      if (!(await verifyProof(row.verification_public_key, row.challenge, request.signature)))
        throw new EnvironmentFailure(
          "forbidden",
          "The environment did not prove possession of its private key.",
        );
      const environment = await queryOne(
        client,
        `select key_version from execution_environments where id = $1 and organization_id = $2 and public_key = $3 and revoked_at is null for update`,
        [row.environment_id, row.organization_id, row.verification_public_key],
      );
      if (environment === null)
        throw new EnvironmentFailure("forbidden", "The environment identity is no longer active.");
      const id = crypto.randomUUID();
      const token = `gec_${id.replaceAll("-", "")}_${randomToken()}`;
      const expiresAt = new Date(Date.now() + credentialLifetimeMs);
      await client.query(
        `insert into environment_credentials (id, environment_id, organization_id, secret_hash, scopes, issued_key_version, expires_at) values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          row.environment_id,
          row.organization_id,
          await digest(token),
          [environmentCredentialScope],
          environment.key_version,
          expiresAt,
        ],
      );
      await client.query(
        `update environment_identity_challenges set consumed_at = now() where id = $1`,
        [row.id],
      );
      await appendSecurityEvent(client, {
        actorUserId: null,
        correlationId: id,
        environmentId: row.environment_id,
        metadata: {
          expiresAt: expiresAt.toISOString(),
          keyVersion: Number(environment.key_version),
          scopes: [environmentCredentialScope],
        },
        organizationId: row.organization_id,
        type: "credential-issued",
      });
      return {
        credentialId: id as EnvironmentCredentialId,
        environmentId: row.environment_id as ExecutionEnvironmentId,
        organizationId: row.organization_id as OrganizationId,
        token,
        scopes: [environmentCredentialScope],
        expiresAt: expiresAt.toISOString() as IsoDateTime,
      };
    }),

  revoke: (userId, environmentId) =>
    transaction(client, async () => {
      const environment = await queryOne(
        client,
        `select organization_id, revoked_at from execution_environments where id = $1 for update`,
        [environmentId],
      );
      if (environment === null)
        throw new EnvironmentFailure("not-found", "The execution environment does not exist.");
      await requireAdministrator(client, String(environment.organization_id), userId);
      if (environment.revoked_at === null) {
        await client.query(
          `update execution_environments set revoked_at = now(), key_version = key_version + 1, updated_at = now() where id = $1`,
          [environmentId],
        );
        await client.query(
          `update environment_credentials set revoked_at = now() where environment_id = $1 and revoked_at is null`,
          [environmentId],
        );
        await client.query(
          `update environment_identity_challenges set consumed_at = now() where environment_id = $1 and consumed_at is null`,
          [environmentId],
        );
        const revoked = await queryOne(
          client,
          `select * from execution_environments where id = $1`,
          [environmentId],
        );
        if (revoked === null)
          throw new EnvironmentFailure("not-found", "The execution environment does not exist.");
        await appendSecurityEvent(client, {
          actorUserId: userId,
          correlationId: environmentId,
          environmentId,
          metadata: { keyVersion: Number(revoked.key_version) },
          organizationId: String(revoked.organization_id),
          type: "environment-revoked",
        });
      }
      const result = await queryOne(client, `select * from execution_environments where id = $1`, [
        environmentId,
      ]);
      if (result === null)
        throw new EnvironmentFailure("not-found", "The execution environment does not exist.");
      return environmentFromRow(result);
    }),

  authorizeUserEnvironment: async (userId, organizationId, environmentId) => {
    const row = await queryOne(
      client,
      `select e.* from execution_environments e join organization_members m on m.organization_id = e.organization_id and m.user_id = $1 and m.removed_at is null where e.organization_id = $2 and e.id = $3 and e.revoked_at is null`,
      [userId, organizationId, environmentId],
    );
    return row === null ? null : environmentFromRow(row);
  },

  hasActiveEnvironment: async (organizationId, environmentId) => {
    const row = await queryOne(
      client,
      `select 1 from execution_environments where organization_id = $1 and id = $2 and revoked_at is null`,
      [organizationId, environmentId],
    );
    return row !== null;
  },

  authenticateCredential: async (token, requiredScope) => {
    if (!token.startsWith("gec_") || token.length > 256) return null;
    const row = await queryOne(
      client,
      `select c.id, c.environment_id, c.organization_id, c.issued_key_version, c.scopes
       from environment_credentials c
       join execution_environments e on e.id = c.environment_id and e.organization_id = c.organization_id
       where c.secret_hash = $1 and c.revoked_at is null and c.expires_at > now()
         and e.revoked_at is null and e.key_version = c.issued_key_version`,
      [await digest(token)],
    );
    if (row === null || !Array.isArray(row.scopes) || !row.scopes.includes(requiredScope))
      return null;
    return {
      credentialId: String(row.id) as EnvironmentCredentialId,
      environmentId: String(row.environment_id) as ExecutionEnvironmentId,
      organizationId: String(row.organization_id) as OrganizationId,
      keyVersion: Number(row.issued_key_version),
      scopes: row.scopes as string[],
    };
  },

  verifyCredentialProof: async (token, requiredScope, challenge, signature) => {
    if (
      !token.startsWith("gec_") ||
      token.length > 256 ||
      challenge.length < 32 ||
      challenge.length > 2048
    )
      return null;
    const row = await queryOne(
      client,
      `select c.id, c.environment_id, c.organization_id, c.issued_key_version, c.scopes, e.public_key from environment_credentials c join execution_environments e on e.id = c.environment_id and e.organization_id = c.organization_id where c.secret_hash = $1 and c.revoked_at is null and c.expires_at > now() and e.revoked_at is null and e.key_version = c.issued_key_version`,
      [await digest(token)],
    );
    if (row === null || !Array.isArray(row.scopes) || !row.scopes.includes(requiredScope))
      return null;
    if (!(await verifyProof(String(row.public_key), challenge, signature))) return null;
    return {
      credentialId: String(row.id) as EnvironmentCredentialId,
      environmentId: String(row.environment_id) as ExecutionEnvironmentId,
      organizationId: String(row.organization_id) as OrganizationId,
      keyVersion: Number(row.issued_key_version),
      scopes: row.scopes as string[],
    };
  },
});
