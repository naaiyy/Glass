import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vite-plus/test";

import { account, session, user, verification } from "./schema.ts";

describe("canonical Better Auth schema", () => {
  it("uses Better Auth's four durable core table names", () => {
    expect(
      [user, session, account, verification].map((table) => getTableConfig(table).name),
    ).toEqual(["user", "session", "account", "verification"]);
  });

  it("keeps account and session ownership tied to a durable user row", () => {
    const sessionConfig = getTableConfig(session);
    const accountConfig = getTableConfig(account);

    expect(sessionConfig.foreignKeys).toHaveLength(1);
    expect(accountConfig.foreignKeys).toHaveLength(1);
    expect(sessionConfig.foreignKeys[0]?.onDelete).toBe("cascade");
    expect(accountConfig.foreignKeys[0]?.onDelete).toBe("cascade");
  });
});
