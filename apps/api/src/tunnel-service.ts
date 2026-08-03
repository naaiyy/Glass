import type { ConnectPresence, ConnectNodeFrame } from "@glass/contracts/connect";
import type {
  ManagedTunnelConfiguration,
  PublishNodePresenceRequest,
} from "@glass/contracts/connect-tunnel";
import type { Client } from "pg";
import type { IsoDateTime } from "@glass/contracts/ids";
import type { ConnectDispatchGrantClaims } from "./connect-tickets.ts";
import type { ManagedTunnelControl } from "./env.ts";

export class TunnelServiceFailure extends Error {
  readonly code: "conflict" | "forbidden" | "not-found" | "rate-limited" | "unavailable";

  constructor(
    code: "conflict" | "forbidden" | "not-found" | "rate-limited" | "unavailable",
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

const hostnameFor = (environmentId: string, zoneName: string, stage: string): string =>
  `connect-${stage === "prod" ? "" : `${stage}-`}${environmentId.toLowerCase()}.${zoneName.toLowerCase()}`;

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

const ticketHash = async (ticket: string): Promise<string> =>
  base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ticket))),
  );

export type TunnelTicketBinding = Readonly<{
  actorUserId: string;
  clientNonce: string;
  environmentId: string;
  expiresAt: string;
  hostname: string;
  keyVersion: number;
  organizationId: string;
  publicKey?: string;
  sessionId: string;
  ticketId: string;
}>;

export interface TunnelService {
  configure(
    input: Readonly<{
      environmentId: string;
      localOrigin: string;
      organizationId: string;
    }>,
  ): Promise<ManagedTunnelConfiguration>;
  endpoint(environmentId: string, organizationId: string): Promise<string | null>;
  issueClientTicket(
    actorUserId: string,
    environmentId: string,
    organizationId: string,
    clientNonce: string,
  ): Promise<TunnelTicketBinding & Readonly<{ ticket: string; websocketUrl: string }>>;
  consumeClientTicket(
    ticket: string,
    environmentId: string,
    organizationId: string,
  ): Promise<TunnelTicketBinding | null>;
  activeSession(
    sessionId: string,
    environmentId: string,
    organizationId: string,
  ): Promise<Readonly<{ actorUserId: string; channelId: string }> | null>;
  claimedSession(
    sessionId: string,
    environmentId: string,
    organizationId: string,
  ): Promise<Readonly<{ actorUserId: string; channelId: string }> | null>;
  revoke(environmentId: string): Promise<void>;
  reconcilePending(limit?: number): Promise<void>;
  publishPresence(request: PublishNodePresenceRequest): Promise<void>;
  presence(environmentId: string): Promise<ConnectPresence>;
  workspaceCatalog(
    environmentId: string,
  ): Promise<readonly Readonly<{ id: string; name: string }>[]>;
  recordFrame(grant: ConnectDispatchGrantClaims, frame: ConnectNodeFrame): Promise<void>;
}

export const createPostgresTunnelService = (
  client: Client,
  control: ManagedTunnelControl,
  zoneName: string,
  stage: "dev" | "prod" | "staging",
  recordFrame: (grant: ConnectDispatchGrantClaims, frame: ConnectNodeFrame) => Promise<void>,
): TunnelService => {
  const service: TunnelService = {
    configure: async (input) => {
      const hostname = hostnameFor(input.environmentId, zoneName, stage);
      const desired = await client.query(
        `insert into managed_environment_tunnels
        (environment_id, organization_id, provider_ownership_id, hostname, local_origin, status)
       select e.id, e.organization_id, $5, $3, $4, 'provisioning'
         from execution_environments e
        where e.id = $1 and e.organization_id = $2 and e.revoked_at is null
       on conflict (environment_id) do update set
         local_origin = case
           when managed_environment_tunnels.status = 'cleanup_pending' then managed_environment_tunnels.local_origin
           else excluded.local_origin
         end,
         status = case
           when managed_environment_tunnels.status = 'cleanup_pending' then 'cleanup_pending'::managed_tunnel_status
           when managed_environment_tunnels.status = 'active'
             and managed_environment_tunnels.local_origin = excluded.local_origin then 'active'::managed_tunnel_status
           else 'provisioning'::managed_tunnel_status
         end,
         generation = case
           when managed_environment_tunnels.status = 'cleanup_pending' then managed_environment_tunnels.generation
           when managed_environment_tunnels.status = 'revoked' then managed_environment_tunnels.generation + 1
           when managed_environment_tunnels.local_origin = excluded.local_origin then managed_environment_tunnels.generation
           else managed_environment_tunnels.generation + 1
         end,
         provider_ownership_id = case
           when managed_environment_tunnels.status = 'revoked' then excluded.provider_ownership_id
           else managed_environment_tunnels.provider_ownership_id
         end,
         tunnel_id = case when managed_environment_tunnels.status = 'revoked' then null else managed_environment_tunnels.tunnel_id end,
         dns_record_id = case when managed_environment_tunnels.status = 'revoked' then null else managed_environment_tunnels.dns_record_id end,
         revoked_at = case when managed_environment_tunnels.status = 'cleanup_pending' then managed_environment_tunnels.revoked_at else null end,
         updated_at = now(),
         last_error = case when managed_environment_tunnels.status = 'cleanup_pending' then managed_environment_tunnels.last_error else null end,
         retry_count = case when managed_environment_tunnels.status = 'cleanup_pending' then managed_environment_tunnels.retry_count else 0 end,
         next_retry_at = case when managed_environment_tunnels.status = 'cleanup_pending' then managed_environment_tunnels.next_retry_at else now() end
       returning status, generation, tunnel_id, dns_record_id, provider_ownership_id`,
        [
          input.environmentId,
          input.organizationId,
          hostname,
          input.localOrigin,
          base64Url(crypto.getRandomValues(new Uint8Array(16))),
        ],
      );
      const state = desired.rows[0];
      if (state === undefined)
        throw new TunnelServiceFailure("forbidden", "The execution environment is unavailable.");
      if (state.status === "cleanup_pending")
        throw new TunnelServiceFailure(
          "unavailable",
          "The previous tunnel allocation is still being cleaned up.",
        );
      if (state.status === "active" && state.tunnel_id !== null) {
        return {
          hostname,
          token: await control.token(String(state.tunnel_id)),
          tunnelId: String(state.tunnel_id),
        };
      }
      const generation = Number(state.generation);
      const ownershipId = String(state.provider_ownership_id);
      const provisioned = await control.provision({
        hostname,
        name: `glass-${stage}-${ownershipId}`,
        ownershipId,
        service: input.localOrigin,
      });
      const activated = await client.query(
        `update managed_environment_tunnels t set tunnel_id = $3, dns_record_id = $4,
         status = 'active', updated_at = now(), last_error = null,
         retry_count = 0, next_retry_at = now()
       from execution_environments e
       where t.environment_id = $1 and t.organization_id = $2 and t.generation = $5
         and t.status = 'provisioning' and t.local_origin = $6
         and e.id = t.environment_id and e.revoked_at is null
       returning t.tunnel_id`,
        [
          input.environmentId,
          input.organizationId,
          provisioned.tunnelId,
          provisioned.dnsRecordId,
          generation,
          input.localOrigin,
        ],
      );
      if (activated.rows.length !== 1) {
        const winner = await client.query(
          `select tunnel_id, dns_record_id from managed_environment_tunnels
           where environment_id = $1 and status = 'active'`,
          [input.environmentId],
        );
        const active = winner.rows[0];
        if (
          active !== undefined &&
          String(active.tunnel_id) === provisioned.tunnelId &&
          String(active.dns_record_id) === provisioned.dnsRecordId
        )
          throw new TunnelServiceFailure("conflict", "Tunnel provisioning was superseded.");
        const orphan = await client.query(
          `update managed_environment_tunnels set tunnel_id = $2, dns_record_id = $3,
           status = 'cleanup_pending', revoked_at = coalesce(revoked_at, now()),
           updated_at = now(), last_error = 'superseded-provider-cleanup-pending',
           retry_count = 0, next_retry_at = now()
           where environment_id = $1 and provider_ownership_id = $4 and status <> 'active'
           returning environment_id`,
          [input.environmentId, provisioned.tunnelId, provisioned.dnsRecordId, ownershipId],
        );
        if (orphan.rows.length !== 1)
          throw new TunnelServiceFailure(
            "unavailable",
            "Superseded tunnel resources could not be recorded for cleanup.",
          );
        await service.revoke(input.environmentId);
        throw new TunnelServiceFailure("conflict", "Tunnel provisioning was superseded.");
      }
      return {
        hostname,
        token: await control.token(provisioned.tunnelId),
        tunnelId: provisioned.tunnelId,
      };
    },

    /*
     * Provider mutations are intentionally outside database transactions. The
     * durable provisioning/cleanup state makes every step resumable after a
     * Worker crash, while deterministic provider names make retries idempotent.
     */
    reconcilePending: async (limit = 25) => {
      const pending = await client.query(
        `select environment_id, organization_id, provider_ownership_id, hostname, local_origin, status, tunnel_id, dns_record_id
         from managed_environment_tunnels
        where status in ('provisioning','cleanup_pending') and next_retry_at <= now()
        order by next_retry_at asc limit $1`,
        [Math.max(1, Math.min(limit, 100))],
      );
      for (const row of pending.rows) {
        try {
          if (row.status === "cleanup_pending") {
            if (row.tunnel_id === null || row.dns_record_id === null)
              throw new TunnelServiceFailure(
                "unavailable",
                "Tunnel provisioning has not published cleanup identifiers yet.",
              );
            // eslint-disable-next-line no-await-in-loop -- provider cleanup is serialized per durable ownership record.
            await control.disconnect(String(row.tunnel_id));
            // eslint-disable-next-line no-await-in-loop -- deletion follows connector teardown for this record.
            await control.delete({
              tunnelId: String(row.tunnel_id),
              dnsRecordId: String(row.dns_record_id),
              ownershipId: String(row.provider_ownership_id),
            });
            // eslint-disable-next-line no-await-in-loop -- terminal state is committed only after provider cleanup.
            await client.query(
              `update managed_environment_tunnels set status = 'revoked', revoked_at = coalesce(revoked_at, now()),
               updated_at = now(), last_error = null, retry_count = 0, next_retry_at = now()
               where environment_id = $1 and status = 'cleanup_pending'`,
              [row.environment_id],
            );
            continue;
          }
          // eslint-disable-next-line no-await-in-loop -- each durable provisioning record reconciles independently.
          await service.configure({
            environmentId: String(row.environment_id),
            organizationId: String(row.organization_id),
            localOrigin: String(row.local_origin),
          });
        } catch {
          // eslint-disable-next-line no-await-in-loop -- each failed record receives its own retry schedule.
          await client.query(
            `update managed_environment_tunnels set retry_count = least(retry_count + 1, 10),
             next_retry_at = now() + make_interval(secs => least(300, (2 ^ least(retry_count, 8))::integer)),
             last_error = 'provider-reconciliation-pending', updated_at = now()
             where environment_id = $1 and status in ('provisioning','cleanup_pending')`,
            [row.environment_id],
          );
        }
      }
    },

    endpoint: async (environmentId, organizationId) => {
      const result = await client.query(
        `select t.hostname from managed_environment_tunnels t join execution_environments e on e.id = t.environment_id
       where t.environment_id = $1 and t.organization_id = $2 and t.status = 'active'
         and t.revoked_at is null and e.revoked_at is null`,
        [environmentId, organizationId],
      );
      return result.rows.length === 1 ? String(result.rows[0]?.hostname) : null;
    },

    issueClientTicket: async (actorUserId, environmentId, organizationId, clientNonce) => {
      const scope = await client.query(
        `select e.public_key, e.key_version, t.hostname, t.generation
       from execution_environments e
       join managed_environment_tunnels t on t.environment_id = e.id and t.organization_id = e.organization_id
       join execution_environment_presence p on p.environment_id = e.id and p.organization_id = e.organization_id
       join organization_members m on m.organization_id = e.organization_id and m.user_id = $3 and m.removed_at is null
       where e.id = $1 and e.organization_id = $2 and e.revoked_at is null
         and t.status = 'active' and t.revoked_at is null
         and p.status = 'online' and p.last_seen_at > now() - interval '45 seconds'`,
        [environmentId, organizationId, actorUserId],
      );
      const row = scope.rows[0];
      if (row === undefined)
        throw new TunnelServiceFailure(
          "forbidden",
          "The managed execution environment is unavailable.",
        );
      const ticket = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      const ticketId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const channelId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const sessionExpiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      await client.query(
        `insert into connect_client_tickets
        (ticket_hash, ticket_id, session_id, actor_user_id, environment_id, organization_id, channel_id,
         client_nonce, tunnel_generation, key_version, hostname, expires_at, session_expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          await ticketHash(ticket),
          ticketId,
          sessionId,
          actorUserId,
          environmentId,
          organizationId,
          channelId,
          clientNonce,
          row.generation,
          row.key_version,
          row.hostname,
          expiresAt,
          sessionExpiresAt,
        ],
      );
      return {
        ticket,
        ticketId,
        sessionId,
        actorUserId,
        environmentId,
        organizationId,
        clientNonce,
        hostname: String(row.hostname),
        keyVersion: Number(row.key_version),
        publicKey: String(row.public_key),
        expiresAt,
        websocketUrl: `wss://${String(row.hostname)}/v1/connect`,
      };
    },

    consumeClientTicket: async (ticket, environmentId, organizationId) => {
      const result = await client.query(
        `update connect_client_tickets c set consumed_at = now()
       from execution_environments e, managed_environment_tunnels t, organization_members m
       where c.ticket_hash = $1 and c.environment_id = $2 and c.organization_id = $3
         and c.consumed_at is null and c.expires_at > now()
         and e.id = c.environment_id and e.organization_id = c.organization_id and e.revoked_at is null
         and e.key_version = c.key_version
         and t.environment_id = c.environment_id and t.organization_id = c.organization_id
         and t.status = 'active' and t.revoked_at is null and t.generation = c.tunnel_generation
         and t.hostname = c.hostname
         and m.organization_id = c.organization_id and m.user_id = c.actor_user_id and m.removed_at is null
       returning c.*`,
        [await ticketHash(ticket), environmentId, organizationId],
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : {
            ticketId: String(row.ticket_id),
            sessionId: String(row.session_id),
            actorUserId: String(row.actor_user_id),
            environmentId: String(row.environment_id),
            organizationId: String(row.organization_id),
            clientNonce: String(row.client_nonce),
            hostname: String(row.hostname),
            keyVersion: Number(row.key_version),
            expiresAt: new Date(row.expires_at).toISOString(),
          };
    },

    activeSession: async (sessionId, environmentId, organizationId) => {
      const result = await client.query(
        `select c.actor_user_id, c.channel_id from connect_client_tickets c
       join execution_environments e on e.id = c.environment_id and e.organization_id = c.organization_id and e.revoked_at is null
       join managed_environment_tunnels t on t.environment_id = c.environment_id and t.organization_id = c.organization_id
         and t.status = 'active' and t.revoked_at is null and t.generation = c.tunnel_generation
       join organization_members m on m.organization_id = c.organization_id and m.user_id = c.actor_user_id and m.removed_at is null
       where c.session_id = $1 and c.environment_id = $2 and c.organization_id = $3
         and c.consumed_at is not null and c.closed_at is null and c.session_expires_at > now()
         and e.key_version = c.key_version`,
        [sessionId, environmentId, organizationId],
      );
      return result.rows[0] === undefined
        ? null
        : {
            actorUserId: String(result.rows[0].actor_user_id),
            channelId: String(result.rows[0].channel_id),
          };
    },

    claimedSession: async (sessionId, environmentId, organizationId) => {
      const result = await client.query(
        `select c.actor_user_id, c.channel_id from connect_client_tickets c
       join execution_environments e on e.id = c.environment_id and e.organization_id = c.organization_id and e.revoked_at is null
       join managed_environment_tunnels t on t.environment_id = c.environment_id and t.organization_id = c.organization_id
         and t.status = 'active' and t.revoked_at is null and t.generation = c.tunnel_generation
       join organization_members m on m.organization_id = c.organization_id and m.user_id = c.actor_user_id and m.removed_at is null
       where c.session_id = $1 and c.environment_id = $2 and c.organization_id = $3
         and c.consumed_at is not null and c.closed_at is null and e.key_version = c.key_version`,
        [sessionId, environmentId, organizationId],
      );
      return result.rows[0] === undefined
        ? null
        : {
            actorUserId: String(result.rows[0].actor_user_id),
            channelId: String(result.rows[0].channel_id),
          };
    },

    revoke: async (environmentId) => {
      await client.query(
        `update connect_client_tickets set closed_at = coalesce(closed_at, now())
         where environment_id = $1 and closed_at is null`,
        [environmentId],
      );
      const result = await client.query(
        `update managed_environment_tunnels set status = 'cleanup_pending', revoked_at = coalesce(revoked_at, now()), updated_at = now()
       where environment_id = $1 and status in ('active','provisioning','cleanup_pending') returning tunnel_id, dns_record_id, provider_ownership_id`,
        [environmentId],
      );
      const row = result.rows[0];
      if (row === undefined) return;
      if (row.tunnel_id === null || row.dns_record_id === null) return;
      try {
        await control.disconnect(String(row.tunnel_id));
        await control.delete({
          tunnelId: String(row.tunnel_id),
          dnsRecordId: String(row.dns_record_id),
          ownershipId: String(row.provider_ownership_id),
        });
        await client.query(
          `update managed_environment_tunnels set status = 'revoked', revoked_at = now(), updated_at = now()
         where environment_id = $1`,
          [environmentId],
        );
      } catch (cause) {
        await client.query(
          `update managed_environment_tunnels set last_error = 'provider-cleanup-pending', updated_at = now() where environment_id = $1`,
          [environmentId],
        );
        throw cause;
      }
    },

    publishPresence: async (request) => {
      const online = request.status === "online";
      await client.query(
        `insert into execution_environment_presence
        (environment_id, organization_id, status, capabilities, workspaces, connected_at, last_seen_at)
       values ($1,$2,$3,$4,$5,case when $3 = 'online' then now() end,now())
       on conflict (environment_id) do update set status = excluded.status,
         capabilities = excluded.capabilities, workspaces = excluded.workspaces,
         connected_at = case when excluded.status = 'online' then coalesce(execution_environment_presence.connected_at, now()) else execution_environment_presence.connected_at end,
         last_seen_at = now(), updated_at = now()`,
        [
          request.environmentId,
          request.organizationId,
          online ? "online" : "offline",
          JSON.stringify(request.capabilities),
          JSON.stringify(request.workspaces),
        ],
      );
    },

    presence: async (environmentId) => {
      const result = await client.query(
        `select p.*, (p.status = 'online' and p.last_seen_at > now() - interval '45 seconds'
         and e.revoked_at is null and t.status = 'active' and t.revoked_at is null) as currently_online
       from execution_environment_presence p
       join execution_environments e on e.id = p.environment_id
       join managed_environment_tunnels t on t.environment_id = p.environment_id
       where p.environment_id = $1`,
        [environmentId],
      );
      const row = result.rows[0];
      return row === undefined
        ? {
            environmentId,
            status: "offline",
            capabilities: [],
            connectedAt: null,
            lastSeenAt: null,
          }
        : {
            environmentId,
            status: row.currently_online === true ? "online" : "offline",
            capabilities: Array.isArray(row.capabilities) ? row.capabilities.map(String) : [],
            connectedAt:
              row.connected_at === null
                ? null
                : (new Date(row.connected_at).toISOString() as IsoDateTime),
            lastSeenAt:
              row.last_seen_at === null
                ? null
                : (new Date(row.last_seen_at).toISOString() as IsoDateTime),
          };
    },

    workspaceCatalog: async (environmentId) => {
      const result = await client.query(
        `select p.workspaces from execution_environment_presence p
       join execution_environments e on e.id = p.environment_id and e.revoked_at is null
       join managed_environment_tunnels t on t.environment_id = p.environment_id and t.status = 'active' and t.revoked_at is null
       where p.environment_id = $1 and p.status = 'online' and p.last_seen_at > now() - interval '45 seconds'`,
        [environmentId],
      );
      const workspaces = result.rows[0]?.workspaces;
      return Array.isArray(workspaces)
        ? workspaces.flatMap((workspace) =>
            typeof workspace === "object" &&
            workspace !== null &&
            "id" in workspace &&
            "name" in workspace
              ? [{ id: String(workspace.id), name: String(workspace.name) }]
              : [],
          )
        : [];
    },

    recordFrame,
  };
  return service;
};
