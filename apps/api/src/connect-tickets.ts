import type { ConnectClientFrame } from "@glass/contracts/connect";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const hasValidConnectTicketSecret = (secret: unknown): secret is string =>
  typeof secret === "string" && new TextEncoder().encode(secret).byteLength >= 32;

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const base64UrlDecode = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
};

const signingKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

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
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(canonicalJson(payload))),
  );
  return base64UrlEncode(digest);
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

const signClaims = async (claims: unknown, secret: string): Promise<string> => {
  const encodedClaims = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(encodedClaims)),
  );
  return `${encodedClaims}.${base64UrlEncode(signature)}`;
};

const verifySignedClaims = async (token: string, secret: string): Promise<unknown | null> => {
  const [encodedClaims, encodedSignature, extra] = token.split(".");
  if (encodedClaims === undefined || encodedSignature === undefined || extra !== undefined)
    return null;
  const claimsBytes = base64UrlDecode(encodedClaims);
  const signature = base64UrlDecode(encodedSignature);
  if (claimsBytes === null || signature === null) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    new Uint8Array(signature).buffer as ArrayBuffer,
    encoder.encode(encodedClaims),
  );
  if (!valid) return null;
  try {
    return JSON.parse(decoder.decode(claimsBytes)) as unknown;
  } catch {
    return null;
  }
};

export const issueConnectDispatchGrant = async (
  claims: Omit<ConnectDispatchGrantClaims, "audience">,
  secret: string,
): Promise<string> => {
  if (!hasValidConnectTicketSecret(secret))
    throw new Error("CONNECT_TICKET_SECRET must contain at least 32 bytes.");
  return await signClaims({ ...claims, audience: "glass-connect-dispatch" }, secret);
};

export const verifyConnectDispatchGrant = async (
  token: string,
  secret: string,
  now = Date.now(),
): Promise<ConnectDispatchGrantClaims | null> => {
  const claims = await verifySignedClaims(token, secret);
  if (typeof claims !== "object" || claims === null) return null;
  const record = claims as Record<string, unknown>;
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
    !("audience" in claims) ||
    claims.audience !== "glass-connect-dispatch" ||
    requiredStrings.some((field) => typeof record[field] !== "string") ||
    (record.purpose !== "request" && record.purpose !== "cancel") ||
    !("expiresAt" in claims) ||
    typeof claims.expiresAt !== "number" ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= Math.floor(now / 1000)
  )
    return null;
  return claims as ConnectDispatchGrantClaims;
};
