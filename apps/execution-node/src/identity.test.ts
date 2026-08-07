import { createPublicKey, verify } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  createNodeIdentity,
  loadNodeIdentity,
  saveNodeIdentity,
  signChallenge,
} from "./identity.ts";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

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
});
