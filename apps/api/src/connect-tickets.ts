import type { ConnectClientFrame } from "@glass/contracts/connect";
import { sha256 } from "@noble/hashes/sha256";
import { base64url, jwtVerify, SignJWT } from "jose";

const encoder = new TextEncoder();

export const hasValidConnectTicketSecret = (secret: unknown): secret is string =>
  typeof secret === "string" && new TextEncoder().encode(secret).byteLength >= 32;

export type ConnectDispatchGrantClaims = Readonly<{
  audience: "glass-connect-dispatch";
  capability: string;
  environmentId: string;
  expiresAt: number;
  intentId: string;
  operationId: string;
  organizationId: string;
  purpose: "cancel" | "request";
  projectId: string;
  requestId: string;
  requestDigest: string;
  workspaceId: string;
}>;

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const digestConnectDispatchPayload = async (payload: unknown): Promise<string> => {
  return base64url.encode(sha256(encoder.encode(canonicalJson(payload))));
};

/**
 * A valid signature authorizes one exact wire frame, not merely an operation
 * row. This check must run before a node is allowed to claim the dispatch.
 */
export const dispatchFrameMatchesGrant = async (
  frame: ConnectClientFrame,
  claims: ConnectDispatchGrantClaims,
): Promise<boolean> => {
  if (frame.operationId !== claims.operationId || frame.requestId !== claims.requestId)
    return false;
  if (frame.type === "operation.cancel") return claims.purpose === "cancel";
  if (
    claims.purpose !== "request" ||
    frame.capability !== claims.capability ||
    typeof frame.payload !== "object" ||
    frame.payload === null ||
    !("workspaceId" in frame.payload) ||
    frame.payload.workspaceId !== claims.workspaceId
  )
    return false;
  return (await digestConnectDispatchPayload(frame.payload)) === claims.requestDigest;
};

export const issueConnectDispatchGrant = async (
  claims: Omit<ConnectDispatchGrantClaims, "audience">,
  secret: string,
): Promise<string> => {
  if (!hasValidConnectTicketSecret(secret))
    throw new Error("CONNECT_TICKET_SECRET must contain at least 32 bytes.");
  const { expiresAt, ...payload } = claims;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setAudience("glass-connect-dispatch")
    .setExpirationTime(expiresAt)
    .sign(encoder.encode(secret));
};

export const verifyConnectDispatchGrant = async (
  token: string,
  secret: string,
  now = Date.now(),
): Promise<ConnectDispatchGrantClaims | null> => {
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload } = await jwtVerify(token, encoder.encode(secret), {
      algorithms: ["HS256"],
      audience: "glass-connect-dispatch",
      currentDate: new Date(now),
    }));
  } catch {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const requiredStrings = [
    "capability",
    "environmentId",
    "intentId",
    "operationId",
    "organizationId",
    "projectId",
    "requestId",
    "requestDigest",
    "workspaceId",
  ] as const;
  if (
    requiredStrings.some((field) => typeof record[field] !== "string") ||
    (record.purpose !== "request" && record.purpose !== "cancel") ||
    typeof payload.exp !== "number" ||
    !Number.isSafeInteger(payload.exp)
  )
    return null;
  const { aud: _audience, exp: _expiresAt, ...claims } = payload;
  return {
    ...(claims as Omit<ConnectDispatchGrantClaims, "audience" | "expiresAt">),
    audience: "glass-connect-dispatch",
    expiresAt: payload.exp,
  };
};
