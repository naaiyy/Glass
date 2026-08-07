#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "pg";

const repositoryRoot = resolve(import.meta.dirname, "..");
const migrationsRoot = resolve(repositoryRoot, "infra/cloud/migrations/postgres");

const checksum = (value) => createHash("sha256").update(value).digest("hex");

export const applyLocalMigrations = async (connectionString) => {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query(`create table if not exists glass_local_migrations (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`);
    const files = (await readdir(migrationsRoot))
      .filter((file) => /^\d{4}_.+\.sql$/u.test(file))
      .sort();
    for (const file of files) {
      // Migration order is intentionally serialized and transactionally recorded.
      // eslint-disable-next-line no-await-in-loop
      const source = await readFile(resolve(migrationsRoot, file), "utf8");
      const sourceChecksum = checksum(source);
      // eslint-disable-next-line no-await-in-loop
      const existing = await client.query(
        "select checksum from glass_local_migrations where name = $1",
        [file],
      );
      if (existing.rows.length === 1) {
        if (existing.rows[0]?.checksum !== sourceChecksum)
          throw new Error(`Applied local migration ${file} no longer matches the repository.`);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await client.query("begin");
      try {
        // Drizzle's statement breakpoint is a SQL comment, so PostgreSQL can execute the file as-is.
        // eslint-disable-next-line no-await-in-loop
        await client.query(source);
        // eslint-disable-next-line no-await-in-loop
        await client.query("insert into glass_local_migrations (name, checksum) values ($1, $2)", [
          file,
          sourceChecksum,
        ]);
        // eslint-disable-next-line no-await-in-loop
        await client.query("commit");
      } catch (cause) {
        // eslint-disable-next-line no-await-in-loop
        await client.query("rollback");
        throw cause;
      }
    }
  } finally {
    await client.end();
  }
};

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const connectionString = process.env.GLASS_LOCAL_DATABASE_URL?.trim();
  if (!connectionString) throw new Error("GLASS_LOCAL_DATABASE_URL is required.");
  await applyLocalMigrations(connectionString);
}
