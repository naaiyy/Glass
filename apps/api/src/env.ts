export interface GlassApiBindings {
  readonly HYPERDRIVE: Hyperdrive;
  readonly ALCHEMY_STAGE: string;
  readonly BETTER_AUTH_SECRET: string;
  readonly GITHUB_CLIENT_ID: string;
  readonly GITHUB_CLIENT_SECRET: string;
}

export type GlassApiBindingInput = Partial<
  Omit<GlassApiBindings, "HYPERDRIVE"> & {
    readonly HYPERDRIVE: Pick<Hyperdrive, "connectionString">;
  }
>;

export type GlassAuthConfig = Readonly<{
  allowedHosts: readonly string[];
  connectionString: string;
  secret: string;
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
      secret,
      github: {
        clientId: githubClientId,
        clientSecret: githubClientSecret,
      },
    },
  };
};
