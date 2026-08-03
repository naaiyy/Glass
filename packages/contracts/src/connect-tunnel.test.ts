import { describe, expect, it } from "vite-plus/test";

import {
  cloudflaredReleaseManifest,
  decodeTunnelConfigurationRequest,
  decodeValidateClientTicketResponse,
} from "./connect-tunnel.ts";

const proof = {
  environmentId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  proofChallengeId: "33333333-3333-4333-8333-333333333333",
  signature: "s".repeat(86),
};

describe("managed tunnel contracts", () => {
  it("accepts only an exact IPv4 loopback origin", () => {
    expect(
      decodeTunnelConfigurationRequest({ ...proof, localOrigin: "http://127.0.0.1:4321" }).ok,
    ).toBe(true);
    for (const localOrigin of [
      "http://localhost:4321",
      "http://127.0.0.1:4321/path",
      "http://127.0.0.1:4321?secret=x",
      "https://127.0.0.1:4321",
    ])
      expect(decodeTunnelConfigurationRequest({ ...proof, localOrigin }).ok).toBe(false);
  });

  it("pins every connector asset to the official release", () => {
    expect(cloudflaredReleaseManifest).toHaveLength(5);
    expect(
      cloudflaredReleaseManifest.every(
        (asset) =>
          asset.version === "2026.7.3" &&
          asset.downloadUrl.startsWith(
            "https://github.com/cloudflare/cloudflared/releases/download/2026.7.3/",
          ) &&
          /^[a-f0-9]{64}$/u.test(asset.sha256),
      ),
    ).toBe(true);
  });

  it("rejects incomplete ticket-consumption state", () => {
    expect(decodeValidateClientTicketResponse({ sessionId: "session-1" }).ok).toBe(false);
  });
});
