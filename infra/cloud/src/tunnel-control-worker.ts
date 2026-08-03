import type * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Output from "alchemy/Output";
import { glassCloudProductionStage } from "./environments.ts";
import { tunnelRequiresDeletion } from "./tunnel-cleanup.ts";

export type TunnelControlShape = {
  provision: (input: {
    hostname: string;
    name: string;
    ownershipId: string;
    service: string;
  }) => Effect.Effect<{ dnsRecordId: string; tunnelId: string }, unknown, Alchemy.RuntimeContext>;
  disconnect: (tunnelId: string) => Effect.Effect<void, unknown, Alchemy.RuntimeContext>;
  delete: (input: {
    dnsRecordId: string;
    ownershipId: string;
    tunnelId: string;
  }) => Effect.Effect<void, unknown, Alchemy.RuntimeContext>;
  token: (tunnelId: string) => Effect.Effect<string, unknown, Alchemy.RuntimeContext>;
};

export class TunnelControlWorker extends Cloudflare.Worker<
  TunnelControlWorker,
  TunnelControlShape
>()("TunnelControl") {}

type ProviderTunnel = Readonly<{
  account_tag?: string | null;
  config_src?: string | null;
  deleted_at?: string | null;
  id?: string | null;
  name?: string | null;
}>;

type ProviderDnsRecord = Readonly<{
  comment?: string | null;
  id?: string | null;
  name?: string | null;
}>;

type ProviderRequestInit = Readonly<{
  allowNotFound?: boolean;
  body?: unknown;
  method?: "DELETE" | "GET" | "POST" | "PUT";
}>;

const providerRequestTimeoutMilliseconds = 15_000;

const providerAccountMatches = (tunnel: ProviderTunnel, accountId: string): boolean =>
  tunnel.account_tag === undefined ||
  tunnel.account_tag === null ||
  tunnel.account_tag === accountId;

const tunnelZone = Cloudflare.Zone.Zone.ref("ConnectTunnelZone", {
  stage: glassCloudProductionStage,
});

export default TunnelControlWorker.make(
  {
    compatibility: { date: "2026-08-01", flags: ["nodejs_compat"] },
    main: import.meta.url,
    workersDev: false,
  },
  Effect.gen(function* () {
    const workerEnvironment = yield* Cloudflare.WorkerEnvironment;
    const stage = String(workerEnvironment.ALCHEMY_STAGE);
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const zone = yield* tunnelZone;
    const zoneIdValue = yield* zone.zoneId;
    // Keep this logical name stable so changing the control implementation does not rotate a
    // provider credential solely because its consumer changed.
    const tunnelProviderToken = yield* Cloudflare.ApiToken.AccountApiToken(
      "TunnelConnectionCleanupToken",
      {
        accountId,
        policies: [
          {
            effect: "allow",
            permissionGroups: ["Cloudflare Tunnel Write"],
            resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
          },
        ],
      },
    );
    const dnsProviderToken = yield* Cloudflare.ApiToken.AccountApiToken("TunnelDnsProviderToken", {
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: ["DNS Read", "DNS Write"],
          resources: zone.zoneId.pipe(
            Output.map((zoneId) => ({ [`com.cloudflare.api.account.zone.${zoneId}`]: "*" })),
          ),
        },
      ],
    });
    const tunnelProviderTokenValue = yield* tunnelProviderToken.value;
    const tunnelProviderAccountId = yield* tunnelProviderToken.accountId;
    const dnsProviderTokenValue = yield* dnsProviderToken.value;

    const providerRequest = <Value>(path: string, init: ProviderRequestInit = {}) =>
      Effect.gen(function* () {
        console.log("Tunnel provider request started.", { method: init.method ?? "GET" });
        const token = Redacted.value(yield* tunnelProviderTokenValue);
        const boundAccountId = yield* tunnelProviderAccountId;
        const response = yield* Effect.tryPromise(() =>
          fetch(
            `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(boundAccountId)}${path}`,
            {
              method: init.method ?? "GET",
              signal: AbortSignal.timeout(providerRequestTimeoutMilliseconds),
              headers: {
                authorization: `Bearer ${token}`,
                ...(init.body === undefined ? {} : { "content-type": "application/json" }),
              },
              ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
            },
          ),
        );
        console.log("Tunnel provider response received.", {
          method: init.method ?? "GET",
          status: response.status,
        });
        if (response.status === 404 && init.allowNotFound === true) return null;
        const envelope = yield* Effect.tryPromise(() => response.json() as Promise<unknown>);
        if (
          !response.ok ||
          typeof envelope !== "object" ||
          envelope === null ||
          !("success" in envelope) ||
          envelope.success !== true ||
          !("result" in envelope)
        )
          return yield* Effect.die("Cloudflare rejected a tunnel-control request.");
        return envelope.result as Value;
      });

    const dnsRequest = <Value>(path: string, init: ProviderRequestInit = {}) =>
      Effect.gen(function* () {
        console.log("Tunnel DNS request started.", { method: init.method ?? "GET" });
        const token = Redacted.value(yield* dnsProviderTokenValue);
        const zoneId = yield* zoneIdValue;
        const response = yield* Effect.tryPromise(() =>
          fetch(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}${path}`, {
            method: init.method ?? "GET",
            signal: AbortSignal.timeout(providerRequestTimeoutMilliseconds),
            headers: {
              authorization: `Bearer ${token}`,
              ...(init.body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          }),
        );
        console.log("Tunnel DNS response received.", {
          method: init.method ?? "GET",
          status: response.status,
        });
        if (response.status === 404 && init.allowNotFound === true) return null;
        const envelope = yield* Effect.tryPromise(() => response.json() as Promise<unknown>);
        if (
          !response.ok ||
          typeof envelope !== "object" ||
          envelope === null ||
          !("success" in envelope) ||
          envelope.success !== true ||
          !("result" in envelope)
        )
          return yield* Effect.die("Cloudflare rejected a tunnel DNS request.");
        return envelope.result as Value;
      });

    return {
      provision: (input) =>
        Effect.gen(function* () {
          const listed = yield* providerRequest<readonly ProviderTunnel[]>(
            `/cfd_tunnel?is_deleted=false&per_page=100&name=${encodeURIComponent(input.name)}`,
          );
          if (!Array.isArray(listed))
            return yield* Effect.die("Cloudflare returned an invalid tunnel list.");
          const matchingTunnels = listed.filter((candidate) => candidate.name === input.name);
          if (matchingTunnels.length > 1)
            return yield* Effect.die("Cloudflare returned duplicate tunnels for one owner.");
          const existing = matchingTunnels[0];
          if (
            existing !== undefined &&
            (existing.config_src !== "cloudflare" || !providerAccountMatches(existing, accountId))
          )
            return yield* Effect.die("Tunnel ownership verification failed.");
          const tunnel =
            existing?.id === undefined
              ? yield* providerRequest<ProviderTunnel>("/cfd_tunnel", {
                  body: { name: input.name, config_src: "cloudflare" },
                  method: "POST",
                })
              : existing;
          if (tunnel === null || tunnel.id === undefined || tunnel.id === null)
            return yield* Effect.die("Tunnel creation returned no id.");
          const tunnelId = tunnel.id;
          const configuration = yield* providerRequest(
            `/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
            {
              body: {
                config: {
                  ingress: [
                    { hostname: input.hostname, service: input.service },
                    { service: "http_status:404" },
                  ],
                },
              },
              method: "PUT",
            },
          );
          if (configuration === null)
            return yield* Effect.die("Tunnel configuration returned no result.");
          const records = yield* dnsRequest<readonly ProviderDnsRecord[]>(
            `/dns_records?type=CNAME&match=all&per_page=100&name.exact=${encodeURIComponent(input.hostname)}`,
          );
          if (!Array.isArray(records))
            return yield* Effect.die("Cloudflare returned an invalid DNS record list.");
          const matchingRecords = records.filter((record) => record.name === input.hostname);
          if (matchingRecords.length > 1)
            return yield* Effect.die("Cloudflare returned duplicate DNS records for one hostname.");
          const existingRecord = matchingRecords[0];
          const ownershipComment = `glass-connect-owner:${input.ownershipId}`;
          if (existingRecord !== undefined && existingRecord.comment !== ownershipComment)
            return yield* Effect.die("DNS ownership verification failed.");
          const target = `${tunnelId}.cfargotunnel.com`;
          const record =
            existingRecord?.id === undefined
              ? yield* dnsRequest<ProviderDnsRecord>("/dns_records", {
                  body: {
                    content: target,
                    comment: ownershipComment,
                    name: input.hostname,
                    proxied: true,
                    ttl: 1,
                    type: "CNAME",
                  },
                  method: "POST",
                })
              : yield* dnsRequest<ProviderDnsRecord>(
                  `/dns_records/${encodeURIComponent(existingRecord.id)}`,
                  {
                    body: {
                      content: target,
                      comment: ownershipComment,
                      name: input.hostname,
                      proxied: true,
                      ttl: 1,
                      type: "CNAME",
                    },
                    method: "PUT",
                  },
                );
          if (record === null || typeof record.id !== "string")
            return yield* Effect.die("DNS reconciliation returned no record id.");
          return { tunnelId, dnsRecordId: record.id };
        }),
      disconnect: (tunnelId) =>
        providerRequest(`/cfd_tunnel/${encodeURIComponent(tunnelId)}/connections`, {
          allowNotFound: true,
          method: "DELETE",
        }).pipe(Effect.asVoid),
      delete: ({ dnsRecordId, ownershipId, tunnelId }) =>
        Effect.gen(function* () {
          const record = yield* dnsRequest<ProviderDnsRecord>(
            `/dns_records/${encodeURIComponent(dnsRecordId)}`,
            { allowNotFound: true },
          );
          if (record !== null) {
            if (record.comment !== `glass-connect-owner:${ownershipId}`)
              return yield* Effect.die("DNS ownership verification failed.");
            yield* dnsRequest(`/dns_records/${encodeURIComponent(dnsRecordId)}`, {
              allowNotFound: true,
              method: "DELETE",
            });
          }
          const tunnel = yield* providerRequest<ProviderTunnel>(
            `/cfd_tunnel/${encodeURIComponent(tunnelId)}`,
            { allowNotFound: true },
          );
          if (tunnel === null) return;
          if (
            tunnel.name !== `glass-${stage}-${ownershipId}` ||
            tunnel.config_src !== "cloudflare" ||
            !providerAccountMatches(tunnel, accountId)
          )
            return yield* Effect.die("Tunnel ownership verification failed.");
          if (tunnelRequiresDeletion({ deletedAt: tunnel.deleted_at ?? null }))
            yield* providerRequest(`/cfd_tunnel/${encodeURIComponent(tunnelId)}`, {
              allowNotFound: true,
              method: "DELETE",
            });
        }),
      token: (tunnelId) =>
        providerRequest<string>(`/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`).pipe(
          Effect.flatMap((token) =>
            typeof token === "string" && token.length > 0
              ? Effect.succeed(token)
              : Effect.die("Tunnel token retrieval returned an invalid value."),
          ),
        ),
    } satisfies TunnelControlShape;
  }),
);
