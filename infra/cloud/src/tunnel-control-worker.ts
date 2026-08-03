import type * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
    const tunnels = yield* Cloudflare.Tunnel.ReadWriteTunnel();
    const dns = yield* Cloudflare.DNS.ReadWriteDns(tunnelZone);
    const workerEnvironment = yield* Cloudflare.WorkerEnvironment;
    const stage = String(workerEnvironment.ALCHEMY_STAGE);
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const cleanupToken = yield* Cloudflare.ApiToken.AccountApiToken(
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
    const cleanupTokenValue = yield* cleanupToken.value;
    const cleanupAccountId = yield* cleanupToken.accountId;
    return {
      provision: (input) =>
        Effect.gen(function* () {
          const listed = yield* tunnels.list({ isDeleted: false, name: input.name });
          const existing = listed.result?.find((candidate) => candidate.name === input.name);
          if (
            existing !== undefined &&
            (existing.configSrc !== "cloudflare" || existing.accountTag !== accountId)
          )
            return yield* Effect.die("Tunnel ownership verification failed.");
          const tunnel =
            existing?.id === undefined
              ? yield* tunnels.create({ name: input.name, configSrc: "cloudflare" })
              : existing;
          if (tunnel.id === undefined || tunnel.id === null)
            return yield* Effect.die("Tunnel creation returned no id.");
          const tunnelId = tunnel.id;
          yield* tunnels.putConfiguration(tunnelId, {
            ingress: [
              { hostname: input.hostname, service: input.service },
              { service: "http_status:404" },
            ],
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
        Effect.gen(function* () {
          const token = Redacted.value(yield* cleanupTokenValue);
          const boundAccountId = yield* cleanupAccountId;
          const response = yield* Effect.tryPromise(() =>
            fetch(
              `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(boundAccountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/connections`,
              {
                method: "DELETE",
                headers: { authorization: `Bearer ${token}` },
              },
            ),
          );
          if (response.status === 404) return;
          const envelope = yield* Effect.tryPromise(() => response.json() as Promise<unknown>);
          if (
            !response.ok ||
            typeof envelope !== "object" ||
            envelope === null ||
            !("success" in envelope) ||
            envelope.success !== true
          )
            return yield* Effect.die("Cloudflare rejected tunnel connection cleanup.");
        }),
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
            const tunnel = yield* tunnels.get(tunnelId);
            if (
              tunnel.name !== `glass-${stage}-${ownershipId}` ||
              tunnel.configSrc !== "cloudflare" ||
              tunnel.accountTag !== accountId
            )
              return yield* Effect.die("Tunnel ownership verification failed.");
            if (tunnelRequiresDeletion(tunnel)) yield* tunnels.delete(tunnelId);
          }).pipe(Effect.catchTag("TunnelNotFound", () => Effect.void));
        }),
      token: (tunnelId) => tunnels.getToken(tunnelId),
    } satisfies TunnelControlShape;
  }).pipe(
    Effect.provide(
      Layer.merge(Cloudflare.Tunnel.ReadWriteTunnelBinding, Cloudflare.DNS.ReadWriteDnsHttp),
    ),
  ),
);
