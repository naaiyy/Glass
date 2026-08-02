import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vite-plus/test";

import {
  account,
  artifacts,
  messages,
  mutationReceipts,
  noteContents,
  organizations,
  organizationSyncState,
  productEvents,
  session,
  threads,
  user,
  verification,
} from "./schema.ts";

const columnNames = (columns: readonly Readonly<{ name: string }>[]): string[] =>
  columns.map((column) => column.name);

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

describe("durable product schema", () => {
  it("keeps every migration journal entry aligned with exactly one SQL file", async () => {
    const migrationRoot = resolve(
      import.meta.dirname,
      "../../../../infra/cloud/migrations/postgres",
    );
    const journal = JSON.parse(
      await readFile(resolve(migrationRoot, "meta/_journal.json"), "utf8"),
    ) as { entries: readonly { tag: string }[] };
    const sqlFiles = (await readdir(migrationRoot))
      .filter((file) => /^\d{4}_.+\.sql$/u.test(file))
      .sort();
    expect(sqlFiles).toEqual(journal.entries.map((entry) => `${entry.tag}.sql`).sort());
  });

  it("stores synchronization cursors as durable bigint values", () => {
    expect(organizationSyncState.cursor.getSQLType()).toBe("bigint");
    expect(organizationSyncState.retentionFloor.getSQLType()).toBe("bigint");
    expect(productEvents.cursor.getSQLType()).toBe("bigint");
    expect(mutationReceipts.cursor.getSQLType()).toBe("bigint");
    expect(organizationSyncState.cursor.notNull).toBe(true);
    expect(productEvents.cursor.notNull).toBe(true);
  });

  it("keeps durable message storage aligned with the UTF-8 wire bound", () => {
    expect(getTableConfig(messages).checks.map((constraint) => constraint.name)).toContain(
      "messages_body_size_check",
    );
  });

  it("orders each organization event stream with a unique cursor", () => {
    const config = getTableConfig(productEvents);
    const cursorConstraint = config.uniqueConstraints.find(
      (candidate) => candidate.getName() === "product_events_organization_cursor_unique",
    );
    const aggregateVersionIndex = config.indexes.find(
      (candidate) => candidate.config.name === "product_events_aggregate_version_unique",
    );

    expect(columnNames(cursorConstraint?.columns ?? [])).toEqual(["organization_id", "cursor"]);
    expect(aggregateVersionIndex?.config.unique).toBe(true);
    expect(
      aggregateVersionIndex?.config.columns.map((column) =>
        "name" in column ? column.name : null,
      ),
    ).toEqual(["organization_id", "aggregate_type", "aggregate_id", "aggregate_version"]);
    expect(config.checks.map((constraint) => constraint.name)).toContain(
      "product_events_positive_cursor_version_check",
    );
  });

  it("makes mutation replay identity actor- and organization-scoped", () => {
    const config = getTableConfig(mutationReceipts);
    expect(config.primaryKeys).toHaveLength(1);
    expect(columnNames(config.primaryKeys[0]?.columns ?? [])).toEqual([
      "organization_id",
      "actor_user_id",
      "command_id",
    ]);
    expect(mutationReceipts.requestHash.notNull).toBe(true);
    expect(mutationReceipts.result.notNull).toBe(true);
    expect(config.checks.map((constraint) => constraint.name)).toContain(
      "mutation_receipts_positive_cursor_check",
    );
    const organizationKey = config.foreignKeys.find(
      (key) => key.reference().foreignTable === organizations,
    );
    expect(organizationKey).toBeDefined();
    expect(organizationKey?.onDelete).toBe("cascade");
    const actorKey = config.foreignKeys.find((key) => key.reference().foreignTable === user);
    expect(actorKey).toBeDefined();
    expect(actorKey?.onDelete).toBe("restrict");
    expect(config.foreignKeys.some((key) => key.reference().foreignTable === productEvents)).toBe(
      false,
    );
  });

  it("retains the authenticated event actor as durable audit data", () => {
    const actorKey = getTableConfig(productEvents).foreignKeys.find(
      (key) => key.reference().foreignTable === user,
    );
    expect(actorKey).toBeDefined();
    expect(actorKey?.onDelete).toBe("restrict");
  });

  it("separates metadata-only notes from bounded agent output", () => {
    const checks = getTableConfig(artifacts).checks.map((constraint) => constraint.name);
    expect(checks).toEqual(
      expect.arrayContaining(["artifacts_kind_check", "artifacts_body_kind_check"]),
    );
    expect(artifacts.body.notNull).toBe(false);
  });

  it("stores one bounded OpenEditor snapshot per note with durable save authority", () => {
    const config = getTableConfig(noteContents);
    expect(columnNames(config.primaryKeys[0]?.columns ?? [])).toEqual([
      "organization_id",
      "artifact_id",
    ]);
    expect(config.checks.map((constraint) => constraint.name)).toContain(
      "note_contents_content_size_check",
    );
    expect(noteContents.content.notNull).toBe(true);
    expect(noteContents.savedAt.notNull).toBe(true);
    expect(noteContents.savedByUserId.notNull).toBe(true);
    const artifactKey = config.foreignKeys.find(
      (key) => key.getName() === "note_contents_organization_artifact_fk",
    );
    expect(artifactKey?.onDelete).toBe("cascade");
  });

  it.each([
    [
      threads,
      "threads_organization_project_fk",
      ["organization_id", "project_id"],
      ["organization_id", "id"],
    ],
    [
      messages,
      "messages_organization_thread_fk",
      ["organization_id", "thread_id"],
      ["organization_id", "id"],
    ],
    [
      artifacts,
      "artifacts_organization_project_fk",
      ["organization_id", "project_id"],
      ["organization_id", "id"],
    ],
    [
      artifacts,
      "artifacts_organization_project_thread_fk",
      ["organization_id", "project_id", "thread_id"],
      ["organization_id", "project_id", "id"],
    ],
  ] as const)(
    "keeps %s references inside the organization through %s",
    (table, foreignKeyName, localColumns, foreignColumns) => {
      const key = getTableConfig(table).foreignKeys.find(
        (candidate) => candidate.getName() === foreignKeyName,
      );
      expect(key).toBeDefined();
      const reference = key?.reference();
      expect(columnNames(reference?.columns ?? [])).toEqual(localColumns);
      expect(columnNames(reference?.foreignColumns ?? [])).toEqual(foreignColumns);
    },
  );
});
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
