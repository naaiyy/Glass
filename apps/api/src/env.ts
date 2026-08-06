export interface GlassApiBindings {
  readonly HYPERDRIVE: Hyperdrive;
  readonly CONNECT_AUTHORITY: DurableObjectNamespace<
    import("./connect-authority.ts").GlassConnectAuthority
  >;
  readonly CONNECT_TICKET_SECRET: string;
  readonly CONNECT_NODE_RATE_LIMIT: RateLimit;
  readonly CONNECT_TUNNEL_ZONE_NAME: string;
  readonly TUNNEL_CONTROL: ManagedTunnelControl;
  readonly TRUST_MUTATION_RATE_LIMIT: RateLimit;
  readonly TRUST_POLL_RATE_LIMIT: RateLimit;
  readonly ALCHEMY_STAGE: string;
  readonly BETTER_AUTH_SECRET: string;
  readonly GITHUB_CLIENT_ID: string;
  readonly GITHUB_CLIENT_SECRET: string;
}

export interface ManagedTunnelControl {
  provision(
    input: Readonly<{ hostname: string; name: string; ownershipId: string; service: string }>,
  ): Promise<Readonly<{ dnsRecordId: string; tunnelId: string }>>;
  disconnect(tunnelId: string): Promise<void>;
  delete(
    input: Readonly<{ dnsRecordId: string; ownershipId: string; tunnelId: string }>,
  ): Promise<void>;
  token(tunnelId: string): Promise<string>;
}

export type GlassApiBindingInput = Partial<
  Omit<GlassApiBindings, "HYPERDRIVE"> & {
    readonly HYPERDRIVE: Pick<Hyperdrive, "connectionString">;
  }
>;

export type GlassAuthConfig = Readonly<{
  allowedHosts: readonly string[];
  connectionString: string;
  trustedOrigins: readonly string[];
  secret: string;
  stage: "dev" | "prod" | "staging";
  tunnelZoneName?: string;
  github: Readonly<{
    clientId: string;
    clientSecret: string;
  }>;
}>;

export type GlassAuthConfigResult =
  | Readonly<{ ok: true; config: GlassAuthConfig }>
  | Readonly<{ ok: false; missingOrInvalidBindings: readonly string[] }>;

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const glassCloudStages = ["prod", "staging", "dev"] as const;
const tunnelZonePattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const packagedGlassTrustedOrigins = ["dev.glass.desktop://*", "dev.glass.mobile://*"] as const;

const isGlassCloudStage = (value: unknown): value is (typeof glassCloudStages)[number] =>
  typeof value === "string" && glassCloudStages.some((stage) => stage === value);

export const resolveGlassAuthConfig = (
  bindings: GlassApiBindingInput | undefined,
): GlassAuthConfigResult => {
  const invalid = new Set<string>();
  const stage = bindings?.ALCHEMY_STAGE;
  if (!isGlassCloudStage(stage)) invalid.add("ALCHEMY_STAGE");
  const connectionString = bindings?.HYPERDRIVE?.connectionString;
  if (!nonEmpty(connectionString)) invalid.add("HYPERDRIVE");
  const secret = bindings?.BETTER_AUTH_SECRET;
  if (!nonEmpty(secret) || secret.length < 32) {
    invalid.add("BETTER_AUTH_SECRET");
  }
  const githubClientId = bindings?.GITHUB_CLIENT_ID;
  if (!nonEmpty(githubClientId)) {
    invalid.add("GITHUB_CLIENT_ID");
  }
  const githubClientSecret = bindings?.GITHUB_CLIENT_SECRET;
  if (!nonEmpty(githubClientSecret)) {
    invalid.add("GITHUB_CLIENT_SECRET");
  }
  const tunnelZoneName = bindings?.CONNECT_TUNNEL_ZONE_NAME;

  if (
    invalid.size > 0 ||
    !isGlassCloudStage(stage) ||
    !nonEmpty(connectionString) ||
    !nonEmpty(secret) ||
    !nonEmpty(githubClientId) ||
    !nonEmpty(githubClientSecret)
  ) {
    return { ok: false, missingOrInvalidBindings: [...invalid].sort() };
  }

  return {
    ok: true,
    config: {
      allowedHosts: [`glasscloud-api-${stage}-*.workers.dev`],
      connectionString,
      trustedOrigins: [
        ...packagedGlassTrustedOrigins,
        // Expo Go is a development container and returns to exp:// rather than the packaged app
        // scheme. Never broaden staging or production callback trust for that development path.
        ...(stage === "dev" ? (["exp://**", "http://127.0.0.1:*"] as const) : []),
      ],
      secret,
      stage,
      ...(nonEmpty(tunnelZoneName) && tunnelZonePattern.test(tunnelZoneName)
        ? { tunnelZoneName: tunnelZoneName.toLowerCase() }
        : {}),
      github: {
        clientId: githubClientId,
        clientSecret: githubClientSecret,
      },
    },
  };
};

export const hasGlassConnectBindings = (bindings: GlassApiBindingInput | undefined): boolean =>
  bindings?.CONNECT_AUTHORITY !== undefined &&
  bindings.CONNECT_NODE_RATE_LIMIT !== undefined &&
  bindings.TUNNEL_CONTROL !== undefined &&
  nonEmpty(bindings.CONNECT_TICKET_SECRET) &&
  new TextEncoder().encode(bindings.CONNECT_TICKET_SECRET).byteLength >= 32 &&
  nonEmpty(bindings.CONNECT_TUNNEL_ZONE_NAME) &&
  tunnelZonePattern.test(bindings.CONNECT_TUNNEL_ZONE_NAME);
