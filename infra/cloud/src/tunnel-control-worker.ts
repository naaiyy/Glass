import type * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
    const dns = yield* Cloudflare.DNS.ReadWriteDns(tunnelZone);
    const workerEnvironment = yield* Cloudflare.WorkerEnvironment;
    const stage = String(workerEnvironment.ALCHEMY_STAGE);
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const tunnelProviderToken = yield* Cloudflare.ApiToken.AccountApiToken("TunnelProviderToken", {
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: ["Cloudflare Tunnel Write"],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
      ],
    });
    const tunnelProviderTokenValue = yield* tunnelProviderToken.value;
    const tunnelProviderAccountId = yield* tunnelProviderToken.accountId;
    const providerRequest = <Value>(
      path: string,
      init: Readonly<{ body?: unknown; method?: "DELETE" | "GET" | "POST" | "PUT" }> = {},
    ) =>
      Effect.gen(function* () {
        const token = Redacted.value(yield* tunnelProviderTokenValue);
        const boundAccountId = yield* tunnelProviderAccountId;
        const response = yield* Effect.tryPromise(() =>
          fetch(
            `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(boundAccountId)}${path}`,
            {
              method: init.method ?? "GET",
              headers: {
                authorization: `Bearer ${token}`,
                ...(init.body === undefined ? {} : { "content-type": "application/json" }),
              },
              ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
            },
          ),
        );
        if (response.status === 404) return null;
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
    return {
      provision: (input) =>
        Effect.gen(function* () {
          const listed = yield* providerRequest<readonly ProviderTunnel[]>(
            `/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(input.name)}`,
          );
          if (!Array.isArray(listed))
            return yield* Effect.die("Cloudflare returned an invalid tunnel list.");
          const existing = listed.find((candidate) => candidate.name === input.name);
          if (
            existing !== undefined &&
            (existing.config_src !== "cloudflare" || existing.account_tag !== accountId)
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
          yield* providerRequest(`/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`, {
            body: {
              config: {
                ingress: [
                  { hostname: input.hostname, service: input.service },
                  { service: "http_status:404" },
                ],
              },
            },
            method: "PUT",
          });
          const records = yield* dns.listDnsRecords({
            name: { exact: input.hostname },
            type: "CNAME",
          });
          const existingRecord = records.result?.find((record) => record.name === input.hostname);
          const ownershipComment = `glass-connect-owner:${input.ownershipId}`;
          if (existingRecord !== undefined && existingRecord.comment !== ownershipComment)
            return yield* Effect.die("DNS ownership verification failed.");
          const target = `${tunnelId}.cfargotunnel.com`;
          const record =
            existingRecord?.id === undefined
              ? yield* dns.createDnsRecord({
                  content: target,
                  comment: ownershipComment,
                  name: input.hostname,
                  proxied: true,
                  ttl: 1,
                  type: "CNAME",
                })
              : yield* dns.updateDnsRecord(existingRecord.id, {
                  content: target,
                  comment: ownershipComment,
                  name: input.hostname,
                  proxied: true,
                  ttl: 1,
                  type: "CNAME",
                });
          return { tunnelId, dnsRecordId: record.id };
        }),
      disconnect: (tunnelId) =>
        providerRequest(`/cfd_tunnel/${encodeURIComponent(tunnelId)}/connections`, {
          method: "DELETE",
        }).pipe(Effect.asVoid),
      delete: ({ dnsRecordId, ownershipId, tunnelId }) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const record = yield* dns.getDnsRecord(dnsRecordId);
            if (record.comment !== `glass-connect-owner:${ownershipId}`)
              return yield* Effect.die("DNS ownership verification failed.");
            yield* dns.deleteDnsRecord(dnsRecordId);
          }).pipe(
            Effect.catch((error) =>
              Reflect.get(error, "_tag") === "CloudflareHttpError" &&
              "status" in error &&
              error.status === 404
                ? Effect.void
                : Effect.fail(error),
            ),
          );
          yield* Effect.gen(function* () {
            const tunnel = yield* providerRequest<ProviderTunnel>(
              `/cfd_tunnel/${encodeURIComponent(tunnelId)}`,
            );
            if (tunnel === null) return;
            if (
              tunnel.name !== `glass-${stage}-${ownershipId}` ||
              tunnel.config_src !== "cloudflare" ||
              tunnel.account_tag !== accountId
            )
              return yield* Effect.die("Tunnel ownership verification failed.");
            if (tunnelRequiresDeletion({ deletedAt: tunnel.deleted_at ?? null }))
              yield* providerRequest(`/cfd_tunnel/${encodeURIComponent(tunnelId)}`, {
                method: "DELETE",
              });
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
  }).pipe(Effect.provide(Cloudflare.DNS.ReadWriteDnsHttp)),
);
