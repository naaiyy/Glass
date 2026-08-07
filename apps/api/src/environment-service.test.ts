import type { Client, QueryResult } from "pg";
import { describe, expect, it } from "vite-plus/test";

import { createPostgresEnvironmentService, EnvironmentFailure } from "./environment-service.ts";

const publicKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as never;
const organizationId = "11111111-1111-4111-8111-111111111111" as never;
const environmentId = "22222222-2222-4222-8222-222222222222" as never;
const challengeId = "33333333-3333-4333-8333-333333333333" as never;
const userId = "44444444-4444-4444-8444-444444444444";
type Call = { text: string; values: readonly unknown[] };

const fakeClient = (
  activePairings: number,
  calls: { text: string; values: readonly unknown[] }[],
): Client =>
  ({
    query: async (text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values });
      return {
        rows: text.includes("count(*)::integer") ? [{ count: activePairings }] : [],
      } as unknown as QueryResult;
    },
  }) as Client;

describe("durable environment security boundary", () => {
  it("serializes and bounds active unauthenticated pairing requests per public key", async () => {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const service = createPostgresEnvironmentService(fakeClient(3, calls));

    await expect(
      service.beginPairing({ displayName: "Build Mac", platform: "macos", publicKey }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<EnvironmentFailure>>({
        code: "conflict",
        message: "Too many pairing requests are active for this environment key.",
      }),
    );

    expect(calls.some((call) => call.text.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(
      calls.some((call) => call.text.includes("insert into environment_identity_challenges")),
    ).toBe(false);
    expect(calls.at(-1)?.text).toBe("rollback");
  });

  it("bounds unauthenticated credential challenges per locked environment", async () => {
    const calls: Call[] = [];
    const client = {
      query: async (text: string, values: readonly unknown[] = []) => {
        calls.push({ text, values });
        if (text.includes("select * from execution_environments"))
          return {
            rows: [
              {
                id: environmentId,
                organization_id: organizationId,
                public_key: publicKey,
                key_version: 1,
                revoked_at: null,
              },
            ],
          };
        if (text.includes("count(*)::integer")) return { rows: [{ count: 5 }] };
        return { rows: [] };
      },
    } as unknown as Client;
    await expect(
      createPostgresEnvironmentService(client).createCredentialChallenge({ environmentId }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "conflict",
        message: "Too many credential challenges are active for this environment.",
      }),
    );
    expect(calls.some((call) => call.text.includes("for update"))).toBe(true);
    expect(
      calls.some((call) => call.text.includes("insert into environment_identity_challenges")),
    ).toBe(false);
  });

  it("rejects expired approvals and consumed polling proofs before state changes", async () => {
    const baseChallenge = {
      id: challengeId,
      purpose: "pair",
      organization_id: null,
      environment_id: null,
      challenge: null,
      polling_token_hash: "unused",
      verification_public_key: publicKey,
      requested_public_key: publicKey,
      display_name: "Build Mac",
      platform: "macos",
      requested_by_user_id: null,
      expires_at: new Date(Date.now() - 1_000),
      consumed_at: null,
    };
    const approvalCalls: Call[] = [];
    const approvalClient = {
      query: async (text: string, values: readonly unknown[] = []) => {
        approvalCalls.push({ text, values });
        if (text.includes("select role")) return { rows: [{ role: "owner" }] };
        if (text.includes("pairing_code_hash")) return { rows: [baseChallenge] };
        return { rows: [] };
      },
    } as unknown as Client;
    await expect(
      createPostgresEnvironmentService(approvalClient).approvePairing(userId, {
        organizationId,
        pairingCode: "ABCDE-23456",
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "conflict" }));
    expect(approvalCalls.some((call) => call.text.startsWith("update "))).toBe(false);

    const statusCalls: Call[] = [];
    const statusClient = {
      query: async (text: string, values: readonly unknown[] = []) => {
        statusCalls.push({ text, values });
        return text.includes("for update")
          ? {
              rows: [
                {
                  ...baseChallenge,
                  expires_at: new Date(Date.now() + 60_000),
                  consumed_at: new Date(),
                },
              ],
            }
          : { rows: [] };
      },
    } as unknown as Client;
    await expect(
      createPostgresEnvironmentService(statusClient).pairingStatus({
        pairingId: challengeId,
        pollingToken: "p".repeat(43),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "conflict" }));
    expect(statusCalls.at(-1)?.text).toBe("rollback");
  });

  it("requires current administrator authority for approval and revocation", async () => {
    const environment = {
      id: environmentId,
      organization_id: organizationId,
      public_key: publicKey,
      key_version: 1,
      revoked_at: null,
    };
    const makeMemberClient = (calls: Call[]) =>
      ({
        query: async (text: string, values: readonly unknown[] = []) => {
          calls.push({ text, values });
          if (text.includes("select role")) return { rows: [{ role: "member" }] };
          if (text.includes("from execution_environments")) return { rows: [environment] };
          return { rows: [] };
        },
      }) as unknown as Client;

    const approvalCalls: Call[] = [];
    await expect(
      createPostgresEnvironmentService(makeMemberClient(approvalCalls)).approvePairing(userId, {
        organizationId,
        pairingCode: "ABCDE-23456",
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "forbidden" }));

    const revocationCalls: Call[] = [];
    await expect(
      createPostgresEnvironmentService(makeMemberClient(revocationCalls)).revoke(
        userId,
        environmentId,
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "forbidden" }));
    expect(
      [...approvalCalls, ...revocationCalls].some((call) =>
        call.text.includes("insert into environment_security_events"),
      ),
    ).toBe(false);
  });

  it("keeps member authorization scoped to the requested organization and environment", async () => {
    const calls: Call[] = [];
    const client = {
      query: async (text: string, values: readonly unknown[] = []) => {
        calls.push({ text, values });
        return { rows: [] };
      },
    } as unknown as Client;
    await expect(
      createPostgresEnvironmentService(client).authorizeUserEnvironment(
        userId,
        organizationId,
        environmentId,
      ),
    ).resolves.toBeNull();
    expect(calls[0]?.values).toEqual([userId, organizationId, environmentId]);
    expect(calls[0]?.text).toContain("m.organization_id = e.organization_id");
    expect(calls[0]?.text).toContain("e.organization_id = $2 and e.id = $3");
  });

  it("invalidates credentials on revocation and records only the resulting key revision", async () => {
    const calls: Call[] = [];
    const revokedEnvironment = {
      id: environmentId,
      organization_id: organizationId,
      display_name: "Build Mac",
      platform: "macos",
      public_key: publicKey,
      key_version: 2,
      created_by_user_id: userId,
      created_at: new Date(),
      updated_at: new Date(),
      revoked_at: new Date(),
    };
    const client = {
      query: async (text: string, values: readonly unknown[] = []) => {
        calls.push({ text, values });
        if (text.includes("select organization_id, revoked_at"))
          return { rows: [{ organization_id: organizationId, revoked_at: null }] };
        if (text.includes("select role")) return { rows: [{ role: "owner" }] };
        if (text.includes("select * from execution_environments"))
          return { rows: [revokedEnvironment] };
        return { rows: [] };
      },
    } as unknown as Client;

    await createPostgresEnvironmentService(client).revoke(userId, environmentId);
    expect(
      calls.some(
        (call) =>
          call.text.includes("key_version = key_version + 1") && call.text.includes("revoked_at"),
      ),
    ).toBe(true);
    expect(
      calls.some((call) => call.text.includes("update environment_credentials set revoked_at")),
    ).toBe(true);
    const audit = calls.find((call) =>
      call.text.includes("insert into environment_security_events"),
    );
    expect(audit?.values[3]).toBe("environment-revoked");
    expect(audit?.values[6]).toEqual({ keyVersion: 2 });
    expect(JSON.stringify(audit?.values[6])).not.toContain(publicKey);
  });

  it("requires current key revision and non-revoked rows when verifying credential proofs", async () => {
    const calls: Call[] = [];
    const client = {
      query: async (text: string, values: readonly unknown[] = []) => {
        calls.push({ text, values });
        return { rows: [] };
      },
    } as unknown as Client;
    await expect(
      createPostgresEnvironmentService(client).verifyCredentialProof(
        `gec_${"a".repeat(32)}_${"b".repeat(43)}`,
        "glass-connect",
        "challenge".repeat(4),
        "A".repeat(86),
      ),
    ).resolves.toBeNull();
    expect(calls[0]?.text).toContain("c.revoked_at is null");
    expect(calls[0]?.text).toContain("e.revoked_at is null");
    expect(calls[0]?.text).toContain("e.key_version = c.issued_key_version");
  });

  it("audits an accepted request using safe metadata rather than pairing secrets or keys", async () => {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const service = createPostgresEnvironmentService(fakeClient(0, calls));

    const result = await service.beginPairing({
      displayName: "Build Mac",
      platform: "macos",
      publicKey,
    });

    const audit = calls.find((call) =>
      call.text.includes("insert into environment_security_events"),
    );
    expect(audit?.values[3]).toBe("pairing-requested");
    expect(audit?.values[6]).toEqual({ displayName: "Build Mac", platform: "macos" });
    expect(JSON.stringify(audit?.values[6])).not.toContain(result.pairingCode);
    expect(JSON.stringify(audit?.values[6])).not.toContain(result.pollingToken);
    expect(JSON.stringify(audit?.values[6])).not.toContain(publicKey);
    expect(calls.at(-1)?.text).toBe("commit");
  });
});
