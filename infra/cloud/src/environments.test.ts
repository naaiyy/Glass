import { describe, expect, it } from "vite-plus/test";
import {
  glassCloudMigrationsDirectory,
  glassCloudProductionStage,
  glassCloudSchemaPath,
  glassCloudStagingStage,
  resolveGlassCloudStage,
} from "./environments.ts";

describe("Glass Cloud stages", () => {
  it("uses the conventional production and staging stage names", () => {
    expect(glassCloudProductionStage).toBe("prod");
    expect(glassCloudStagingStage).toBe("staging");
  });

  it("makes prod the sole owner of the production database", () => {
    expect(resolveGlassCloudStage("prod")).toEqual({
      stage: "prod",
      database: {
        ownership: "owner",
        clusterSize: "PS_5_AWS_X86",
        replicas: 2,
        retainBranch: true,
      },
    });
  });

  it("gives staging one retained production-shaped database branch", () => {
    expect(resolveGlassCloudStage("staging")).toEqual({
      stage: "staging",
      database: {
        ownership: "production-reference",
        clusterSize: "PS_DEV",
        replicas: 0,
        retainBranch: true,
      },
    });
  });

  it("keeps one schema and migration chain", () => {
    expect(glassCloudSchemaPath).toBe("../../apps/api/src/db/schema.ts");
    expect(glassCloudMigrationsDirectory).toBe("./migrations/postgres");
  });

  it.each(["development", "dev", "dev_naaiyy", "production", "preview", "", "Dev_Naaiyy"])(
    "rejects non-conventional stage %j",
    (stage) => {
      expect(() => resolveGlassCloudStage(stage)).toThrow(/Unsupported Glass Cloud stage/u);
    },
  );
});
