# PostgreSQL migrations

This directory is the committed output of the composed Drizzle schema at
`apps/api/src/db/schema.ts`. Better Auth generates only
`apps/api/src/db/auth-schema.generated.ts`; it must never overwrite the composed schema. Generate
migration directories with the
repository-pinned `@glass/api` `db:migrations` script, review the generated SQL,
snapshot, and journal, and commit them before an Alchemy deployment applies them.

Alchemy points the production database and every non-production branch at this
same directory. A deployment must stop if the schema would require an
unreviewed migration or an interactive data-loss decision.
