export const glassCloudProductionStage = "prod" as const;
export const glassCloudStagingStage = "staging" as const;
export const glassCloudMigrationsDirectory = "./migrations/postgres" as const;
export const glassCloudSchemaPath = "../../apps/api/src/db/schema.ts" as const;

export type GlassCloudStage = typeof glassCloudProductionStage | typeof glassCloudStagingStage;

export type GlassCloudStagePolicy = Readonly<{
  stage: GlassCloudStage;
  database: Readonly<{
    ownership: "owner" | "production-reference";
    clusterSize: "PS_5_AWS_X86" | "PS_DEV";
    replicas: 0 | 2;
    retainBranch: boolean;
  }>;
}>;

export const resolveGlassCloudStage = (stage: string): GlassCloudStagePolicy => {
  if (stage === glassCloudProductionStage) {
    return {
      stage,
      database: {
        ownership: "owner",
        clusterSize: "PS_5_AWS_X86",
        replicas: 2,
        retainBranch: true,
      },
    };
  }

  if (stage === glassCloudStagingStage) {
    return {
      stage: stage as GlassCloudStage,
      database: {
        ownership: "production-reference",
        clusterSize: "PS_DEV",
        replicas: 0,
        retainBranch: true,
      },
    };
  }

  throw new Error(
    `Unsupported Glass Cloud stage "${stage}". Use "prod" or "staging". Development runs locally.`,
  );
};
