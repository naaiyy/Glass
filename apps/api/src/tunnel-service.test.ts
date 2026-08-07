import type { Client } from "pg";
import { describe, expect, it } from "vite-plus/test";
import type { ManagedTunnelControl } from "./env.ts";
import { createPostgresTunnelService, TunnelServiceFailure } from "./tunnel-service.ts";

const control: ManagedTunnelControl = {
  provision: async () => ({ dnsRecordId: "dns-1", tunnelId: "tunnel-1" }),
  disconnect: async () => undefined,
  delete: async () => undefined,
  token: async () => "token",
};

describe("managed tunnel ticket readiness", () => {
  it("does not resurrect a tunnel while durable cleanup is pending", async () => {
    let provisioned = false;
    let upsertSql = "";
    const client = {
      query: async (sql: string) => {
        upsertSql = sql;
        return {
          rows: [
            {
              status: "cleanup_pending",
              generation: 4,
              tunnel_id: "old-tunnel",
              dns_record_id: "old-dns",
              provider_ownership_id: "old-owner",
            },
          ],
        };
      },
    } as unknown as Client;
    const service = createPostgresTunnelService(
      client,
      {
        ...control,
        provision: async (input) => {
          provisioned = true;
          return await control.provision(input);
        },
      },
      "glass.test",
      "prod",
      async () => undefined,
    );
    await expect(
      service.configure({
        environmentId: "environment-1",
        organizationId: "organization-1",
        localOrigin: "http://127.0.0.1:4321",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(provisioned).toBe(false);
    expect(upsertSql).toContain("then 'cleanup_pending'::managed_tunnel_status");
    expect(upsertSql).toContain("when managed_environment_tunnels.status = 'revoked'");
  });

  it("durably retries cleanup when revoke races provisioning and provider deletion fails", async () => {
    const state: Record<string, unknown> = {
      status: "absent",
      tunnel_id: null,
      dns_record_id: null,
      provider_ownership_id: null,
    };
    let releaseProvision: () => void = () => {};
    let signalProvisionStarted: () => void = () => {};
    const provisionStarted = new Promise<void>((resolve) => {
      signalProvisionStarted = resolve;
    });
    const provisionBlocked = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    let deleteAttempts = 0;
    const racingControl: ManagedTunnelControl = {
      ...control,
      provision: async () => {
        signalProvisionStarted();
        await provisionBlocked;
        return { dnsRecordId: "dns-race", tunnelId: "tunnel-race" };
      },
      delete: async () => {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error("provider delete unavailable");
      },
    };
    const client = {
      query: async (sql: string, values?: readonly unknown[]) => {
        if (sql.includes("insert into managed_environment_tunnels")) {
          state.status = "provisioning";
          state.provider_ownership_id = values?.[4];
          return { rows: [{ ...state, generation: 1 }] };
        }
        if (sql.includes("update managed_environment_tunnels t set tunnel_id")) return { rows: [] };
        if (sql.includes("where environment_id = $1 and status = 'active'")) return { rows: [] };
        if (sql.includes("superseded-provider-cleanup-pending")) {
          state.status = "cleanup_pending";
          state.tunnel_id = values?.[1];
          state.dns_record_id = values?.[2];
          return { rows: [{ environment_id: values?.[0] }] };
        }
        if (sql.includes("set status = 'cleanup_pending'")) {
          state.status = "cleanup_pending";
          return { rows: [{ ...state }] };
        }
        if (sql.includes("select environment_id, organization_id"))
          return {
            rows: [
              {
                ...state,
                environment_id: "environment-1",
                organization_id: "organization-1",
                hostname: "connect-environment-1.glass.test",
                local_origin: "http://127.0.0.1:4321",
              },
            ],
          };
        if (sql.includes("set status = 'revoked'")) {
          state.status = "revoked";
          return { rows: [] };
        }
        return { rows: [] };
      },
    } as unknown as Client;
    const service = createPostgresTunnelService(
      client,
      racingControl,
      "glass.test",
      "prod",
      async () => undefined,
    );
    const configuring = service.configure({
      environmentId: "environment-1",
      organizationId: "organization-1",
      localOrigin: "http://127.0.0.1:4321",
    });
    await provisionStarted;
    await service.revoke("environment-1");
    expect(state.status).toBe("cleanup_pending");
    expect(state.tunnel_id).toBeNull();
    releaseProvision();
    await expect(configuring).rejects.toThrow("provider delete unavailable");
    expect(state).toMatchObject({
      status: "cleanup_pending",
      tunnel_id: "tunnel-race",
      dns_record_id: "dns-race",
    });
    await service.reconcilePending();
    expect(deleteAttempts).toBe(2);
    expect(state.status).toBe("revoked");
  });

  it("issues the exact WebSocket path served by the loopback tunnel origin", async () => {
    let calls = 0;
    const client = {
      query: async () => {
        calls += 1;
        return calls === 1
          ? {
              rows: [
                {
                  generation: 1,
                  hostname: "connect-environment-1.glass.test",
                  key_version: 1,
                  public_key: "public-key",
                },
              ],
            }
          : { rows: [] };
      },
    } as unknown as Client;
    const service = createPostgresTunnelService(
      client,
      control,
      "glass.test",
      "prod",
      async () => undefined,
    );
    const ticket = await service.issueClientTicket(
      "user-1",
      "environment-1",
      "organization-1",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(ticket.websocketUrl).toBe("wss://connect-environment-1.glass.test/v1/connect");
  });

  it.each([
    ["prod", "connect-environment-1.glass.test"],
    ["staging", "connect-staging-environment-1.glass.test"],
    ["local", "connect-local-environment-1.glass.test"],
  ] as const)(
    "keeps the %s Connect hostname within one TLS wildcard label",
    async (stage, expected) => {
      let provisionedHostname = "";
      let calls = 0;
      const client = {
        query: async () => {
          calls += 1;
          return calls === 1
            ? {
                rows: [
                  {
                    status: "provisioning",
                    generation: 1,
                    tunnel_id: null,
                    dns_record_id: null,
                    provider_ownership_id: "owner-1",
                  },
                ],
              }
            : { rows: [{ tunnel_id: "tunnel-1" }] };
        },
      } as unknown as Client;
      const service = createPostgresTunnelService(
        client,
        {
          ...control,
          provision: async (input) => {
            provisionedHostname = input.hostname;
            return await control.provision(input);
          },
        },
        "glass.test",
        stage,
        async () => undefined,
      );

      await service.configure({
        environmentId: "environment-1",
        organizationId: "organization-1",
        localOrigin: "http://127.0.0.1:4321",
      });

      expect(provisionedHostname).toBe(expected);
      expect(provisionedHostname.split(".")[0]?.length).toBeLessThanOrEqual(63);
    },
  );

  it.each(["offline", "stale heartbeat", "connector crash"])(
    "rejects ticket issuance when node readiness is %s",
    async () => {
      let scopeSql = "";
      const client = {
        query: async (sql: string) => {
          scopeSql = sql;
          return { rows: [] };
        },
      } as unknown as Client;
      const service = createPostgresTunnelService(
        client,
        control,
        "glass.test",
        "prod",
        async () => undefined,
      );
      await expect(
        service.issueClientTicket(
          "user-1",
          "environment-1",
          "organization-1",
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ),
      ).rejects.toBeInstanceOf(TunnelServiceFailure);
      expect(scopeSql).toContain("p.status = 'online'");
      expect(scopeSql).toContain("p.last_seen_at > now() - interval '45 seconds'");
    },
  );
});
