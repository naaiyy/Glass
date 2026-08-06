import { createPublicKey, verify } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  beginKeyRotation,
  createNodeIdentity,
  finishKeyRotation,
  loadNodeIdentity,
  saveNodeIdentity,
  signChallenge,
  stageKeyRotation,
} from "./identity.ts";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))).finally(
    () => vi.unstubAllGlobals(),
  ),
);

const environment = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  displayName: "Build Mac",
  platform: "macos",
  publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  keyVersion: 1,
  createdByUserId: "33333333-3333-4333-8333-333333333333",
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
  revokedAt: null,
} as const;

describe("execution environment identity", () => {
  it("persists a machine-held Ed25519 key with owner-only permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "glass-identity-"));
    roots.push(root);
    const path = join(root, "nested", "identity.json");
    const identity = createNodeIdentity("https://glass.example.test/path");
    await saveNodeIdentity(identity, path);
    expect(await loadNodeIdentity(path)).toEqual(identity);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).not.toContain("BEGIN PRIVATE KEY");
  });

  it("signs a challenge that verifies against the published raw public key", () => {
    const identity = createNodeIdentity("https://glass.example.test");
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const publicKey = createPublicKey({
      key: Buffer.concat([spkiPrefix, Buffer.from(identity.publicKey, "base64url")]),
      format: "der",
      type: "spki",
    });
    const challenge = "glass-environment-pair-v1\nchallenge";
    expect(
      verify(
        null,
        Buffer.from(challenge),
        publicKey,
        Buffer.from(signChallenge(identity, challenge), "base64url"),
      ),
    ).toBe(true);
  });

  it("authenticates the node challenge used for key rotation", async () => {
    const base = createNodeIdentity("https://glass.example.test");
    const credential = {
      credentialId: "44444444-4444-4444-8444-444444444444",
      environmentId: environment.id,
      organizationId: environment.organizationId,
      token: "environment-credential",
      scopes: ["connect:node"],
      expiresAt: "2030-01-01T00:00:00.000Z",
    } as const;
    const identity = stageKeyRotation({
      ...base,
      environment: environment as never,
      credential: credential as never,
    });
    const authorizations: Array<string | null> = [];
    let requestNumber = 0;
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      requestNumber += 1;
      authorizations.push(new Headers(init?.headers).get("authorization"));
      if (requestNumber === 1)
        return Response.json({
          challengeId: "55555555-5555-4555-8555-555555555555",
          challenge: "glass-connect-node-challenge-v1\nproof",
          expiresAt: "2030-01-01T00:00:00.000Z",
        });
      if (requestNumber === 2)
        return Response.json({
          rotationId: "66666666-6666-4666-8666-666666666666",
          rotationCode: "ABCDE-FGHIJ",
          pollingToken: "p".repeat(43),
          approvalPath: "/#glass-connect-rotate",
          expiresAt: "2030-01-01T00:00:00.000Z",
        });
      throw new Error("unexpected request");
    });

    await beginKeyRotation(identity);

    expect(authorizations).toEqual([
      "Bearer environment-credential",
      "Bearer environment-credential",
    ]);
  });

  it("retains the active key and a durable staged replacement when Cloud completion fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "glass-rotation-"));
    roots.push(root);
    const path = join(root, "identity.json");
    const original = createNodeIdentity("https://glass.example.test");
    const staged = stageKeyRotation({ ...original, environment: environment as never });
    const pending = staged.pendingRotation;
    if (pending === undefined) throw new Error("replacement was not staged");
    const ready = {
      ...staged,
      pendingRotation: {
        ...pending,
        rotation: {
          rotationId: "44444444-4444-4444-8444-444444444444",
          rotationCode: "ABCDE-FGHIJ",
          pollingToken: "p".repeat(43),
          approvalPath: "/#glass-connect-rotate",
          expiresAt: "2026-08-03T00:05:00.000Z",
        },
      },
    } as never;
    await saveNodeIdentity(ready, path);
    let requests = 0;
    vi.stubGlobal("fetch", async () => {
      requests += 1;
      return requests === 1
        ? Response.json({
            status: "approved",
            challenge: "glass-environment-rotation-challenge-v2",
            expiresAt: "2026-08-03T00:05:00.000Z",
          })
        : Response.json({ message: "database unavailable" }, { status: 503 });
    });

    await expect(finishKeyRotation(ready)).rejects.toThrow("database unavailable");
    const persisted = await loadNodeIdentity(path);
    expect(persisted?.publicKey).toBe(original.publicKey);
    expect(persisted?.privateKeyDer).toBe(original.privateKeyDer);
    expect(persisted?.pendingRotation?.publicKey).toBe(pending.publicKey);
  });

  it("proves both keys and promotes only the staged key after confirmed Cloud success", async () => {
    const original = createNodeIdentity("https://glass.example.test");
    const staged = stageKeyRotation({ ...original, environment: environment as never });
    const pending = staged.pendingRotation;
    if (pending === undefined) throw new Error("replacement was not staged");
    const ready = {
      ...staged,
      pendingRotation: {
        ...pending,
        rotation: {
          rotationId: "44444444-4444-4444-8444-444444444444",
          rotationCode: "ABCDE-FGHIJ",
          pollingToken: "p".repeat(43),
          approvalPath: "/#glass-connect-rotate",
          expiresAt: "2026-08-03T00:05:00.000Z",
        },
      },
    } as never;
    const challenge = "glass-environment-rotate-v2\nproof";
    const completionBody: { value: Record<string, string> | null } = { value: null };
    let requests = 0;
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      requests += 1;
      if (requests === 1)
        return Response.json({
          status: "approved",
          challenge,
          expiresAt: "2026-08-03T00:05:00.000Z",
        });
      completionBody.value = JSON.parse(String(init?.body)) as Record<string, string>;
      return Response.json({ ...environment, publicKey: pending.publicKey, keyVersion: 2 });
    });
    const promoted = await finishKeyRotation(ready);
    expect(promoted.publicKey).toBe(pending.publicKey);
    expect(promoted.privateKeyDer).toBe(pending.privateKeyDer);
    expect(promoted.credential).toBeNull();
    expect(promoted.pendingRotation).toBeUndefined();
    expect(completionBody.value?.currentKeySignature).toHaveLength(86);
    expect(completionBody.value?.replacementKeySignature).toHaveLength(86);
  });
});
