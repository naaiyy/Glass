import { describe, expect, it } from "vite-plus/test";

import {
  decodeApproveEnvironmentPairingRequest,
  decodeBeginEnvironmentPairingRequest,
  decodeCompleteEnvironmentProofRequest,
  decodeEnvironmentPairingStatusRequest,
  environmentPairingApprovalPath,
} from "./environments.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const challengeId = "22222222-2222-4222-8222-222222222222";
const publicKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const signature = "A".repeat(86);

describe("execution environment identity contracts", () => {
  it("uses the deployed SPA entry and a non-secret fragment for pairing approval", () => {
    const url = new URL(environmentPairingApprovalPath, "https://glass.example.test");
    expect(url.pathname).toBe("/");
    expect(url.hash).toBe("#glass-connect-pair");
    expect(url.search).toBe("");
  });
  it("accepts a bounded headless pairing request without cloud identity claims", () => {
    expect(
      decodeBeginEnvironmentPairingRequest({
        displayName: "Build Mac",
        platform: "macos",
        publicKey,
      }),
    ).toEqual({
      ok: true,
      value: { displayName: "Build Mac", platform: "macos", publicKey },
    });
  });

  it("requires the signed-in approval to select a canonical organization", () => {
    expect(
      decodeApproveEnvironmentPairingRequest({
        organizationId,
        pairingCode: "abcde-23456",
      }),
    ).toEqual({
      ok: true,
      value: { organizationId, pairingCode: "ABCDE-23456" },
    });
  });

  it("keeps the high-entropy polling secret out of the human approval code", () => {
    expect(
      decodeEnvironmentPairingStatusRequest({
        pairingId: challengeId,
        pollingToken: "p".repeat(43),
      }).ok,
    ).toBe(true);
    expect(
      decodeEnvironmentPairingStatusRequest({
        pairingId: challengeId,
        pollingToken: "short",
      }).ok,
    ).toBe(false);
  });

  it("requires a canonical Ed25519 signature and permits a pairing polling proof", () => {
    expect(
      decodeCompleteEnvironmentProofRequest({
        challengeId,
        signature,
        pollingToken: "p".repeat(43),
      }).ok,
    ).toBe(true);
    expect(
      decodeCompleteEnvironmentProofRequest({ challengeId, signature: "not-a-proof" }).ok,
    ).toBe(false);
  });

  it("rejects unknown fields at the execution trust boundary", () => {
    expect(
      decodeBeginEnvironmentPairingRequest({
        displayName: "Build Mac",
        platform: "macos",
        publicKey,
        ownerUserId: "attacker-controlled",
      }).ok,
    ).toBe(false);
  });
});
