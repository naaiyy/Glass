import {
  decodeBeginEnvironmentPairingResponse,
  decodeEnvironmentCredential,
  decodeEnvironmentIdentityChallenge,
  decodeEnvironmentPairingStatus,
  decodeExecutionEnvironment,
  type BeginEnvironmentPairingResponse,
  type EnvironmentCredential,
  type EnvironmentPairingStatus,
  type ExecutionEnvironment,
} from "@glass/contracts/environments";
import type { DecodeResult } from "@glass/contracts/validation";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type StoredNodeIdentity = Readonly<{
  apiOrigin: string;
  credential: EnvironmentCredential | null;
  environment: ExecutionEnvironment | null;
  privateKeyDer: string;
  publicKey: string;
  version: 1;
}>;

export class EnvironmentRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "EnvironmentRequestError";
    this.status = status;
  }
}

export const defaultIdentityPath = (): string =>
  process.env.GLASS_NODE_IDENTITY_PATH?.trim() || join(homedir(), ".glass", "execution-node.json");

export const createNodeIdentity = (apiOrigin: string): StoredNodeIdentity => {
  const origin = new URL(apiOrigin);
  if (
    origin.protocol !== "https:" &&
    !(origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname))
  ) {
    throw new Error("Glass Cloud must use HTTPS outside local development.");
  }
  const pair = generateKeyPairSync("ed25519");
  const publicDer = pair.publicKey.export({ format: "der", type: "spki" });
  const privateDer = pair.privateKey.export({ format: "der", type: "pkcs8" });
  return {
    version: 1,
    apiOrigin: origin.origin,
    environment: null,
    credential: null,
    publicKey: publicDer.subarray(-32).toString("base64url"),
    privateKeyDer: privateDer.toString("base64url"),
  };
};

export const loadNodeIdentity = async (
  path = defaultIdentityPath(),
): Promise<StoredNodeIdentity | null> => {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as StoredNodeIdentity;
    if (
      parsed.version !== 1 ||
      typeof parsed.privateKeyDer !== "string" ||
      typeof parsed.publicKey !== "string"
    )
      throw new Error("The Glass execution identity file is invalid.");
    return parsed;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
};

export const saveNodeIdentity = async (
  identity: StoredNodeIdentity,
  path = defaultIdentityPath(),
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
};

export const signChallenge = (identity: StoredNodeIdentity, challenge: string): string => {
  return signPrivateKey(identity.privateKeyDer, challenge);
};

const signPrivateKey = (privateKeyDer: string, challenge: string): string => {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyDer, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, Buffer.from(challenge, "utf8"), key).toString("base64url");
};

const request = async <Value>(
  identity: StoredNodeIdentity,
  path: string,
  body: unknown,
  decode: (input: unknown) => DecodeResult<Value>,
  token?: string,
): Promise<Value> => {
  const response = await fetch(new URL(path, identity.apiOrigin), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  const value = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      typeof value === "object" && value !== null && "message" in value
        ? String(value.message)
        : `Glass Cloud returned ${response.status}.`;
    throw new EnvironmentRequestError(response.status, message);
  }
  const decoded = decode(value);
  if (!decoded.ok) throw new Error("Glass Cloud returned a malformed environment response.");
  return decoded.value;
};

export const beginPairing = (
  identity: StoredNodeIdentity,
  displayName: string,
  platform: "linux" | "macos" | "windows",
) =>
  request(
    identity,
    "/v1/environment-pairings",
    { displayName, platform, publicKey: identity.publicKey },
    decodeBeginEnvironmentPairingResponse,
  );

export const finishPairing = async (
  identity: StoredNodeIdentity,
  pairing: BeginEnvironmentPairingResponse,
): Promise<StoredNodeIdentity> => {
  const waitForApproval = async (): Promise<
    Extract<EnvironmentPairingStatus, { status: "approved" }>
  > => {
    const status = await request(
      identity,
      "/v1/environment-pairings/status",
      {
        pairingId: pairing.pairingId,
        pollingToken: pairing.pollingToken,
      },
      decodeEnvironmentPairingStatus,
    );
    if (status.status === "approved") return status;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return waitForApproval();
  };
  const status = await waitForApproval();
  const environment = await request(
    identity,
    "/v1/environment-pairings/complete",
    {
      challengeId: pairing.pairingId,
      pollingToken: pairing.pollingToken,
      signature: signChallenge(identity, status.challenge),
    },
    decodeExecutionEnvironment,
  );
  return { ...identity, environment };
};

export const refreshCredential = async (
  identity: StoredNodeIdentity,
): Promise<StoredNodeIdentity> => {
  if (identity.environment === null)
    throw new Error("Publish this execution environment before connecting.");
  if (
    identity.credential !== null &&
    Date.parse(identity.credential.expiresAt) > Date.now() + 30_000
  )
    return identity;
  const challenge = await request(
    identity,
    "/v1/environment-credentials/challenges",
    { environmentId: identity.environment.id },
    decodeEnvironmentIdentityChallenge,
  );
  const credential = await request(
    identity,
    "/v1/environment-credentials/exchange",
    { challengeId: challenge.challengeId, signature: signChallenge(identity, challenge.challenge) },
    decodeEnvironmentCredential,
  );
  return { ...identity, credential };
};
