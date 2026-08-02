import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  decodeLoadNoteContentRequest,
  decodeSaveNoteContentRequest,
  maxNoteContentBytes,
} from "@glass/contracts/notes";
import { decodeListOrganizationsRequest } from "@glass/contracts/organizations";
import { maxArtifactBodyBytes, type Organization } from "@glass/contracts/product";
import {
  decodePullEventsRequest,
  decodePushCommandsRequest,
  decodeSnapshotPageRequest,
  maxPullResponseBytes,
  maxSnapshotResponseBytes,
  type PushCommandsRequest,
  type SnapshotEntity,
} from "@glass/contracts/sync";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createPostgresProductService, ProductFailure } from "../src/product-service.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseName = databaseUrl === undefined ? "" : new URL(databaseUrl).pathname.slice(1);
const integration =
  databaseUrl !== undefined && databaseName.endsWith("_test") ? describe : describe.skip;

const ownerId = "10000000-0000-4000-8000-000000000001";
const outsiderId = "10000000-0000-4000-8000-000000000002";
const memberId = "10000000-0000-4000-8000-000000000003";
const organizationId = "20000000-0000-4000-8000-000000000001";
const otherOrganizationId = "20000000-0000-4000-8000-000000000002";
const projectId = "30000000-0000-4000-8000-000000000001";
const threadId = "40000000-0000-4000-8000-000000000001";
const messageId = "50000000-0000-4000-8000-000000000001";
const artifactId = "70000000-0000-4000-8000-000000000001";
const noteId = "70000000-0000-4000-8000-000000000002";
const discoveryOrganizationA = "d0000000-0000-4000-8000-000000000001";
const discoveryOrganizationB = "d0000000-0000-4000-8000-000000000002";
const discoveryOrganizationOutsider = "d0000000-0000-4000-8000-000000000003";
const discoveryOrganizationRemoved = "d0000000-0000-4000-8000-000000000004";

const commandId = (suffix: number): string =>
  `80000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;

const decodePush = (input: unknown) => {
  const decoded = decodePushCommandsRequest(input);
  if (!decoded.ok) throw new Error(JSON.stringify(decoded.issues));
  return decoded.value;
};

const decodePull = (input: unknown) => {
  const decoded = decodePullEventsRequest(input);
  if (!decoded.ok) throw new Error(JSON.stringify(decoded.issues));
  return decoded.value;
};

const decodeListOrganizations = (input: unknown) => {
  const decoded = decodeListOrganizationsRequest(input);
  if (!decoded.ok) throw new Error(JSON.stringify(decoded.issues));
  return decoded.value;
};

const decodeLoadNote = (input: unknown) => {
  const decoded = decodeLoadNoteContentRequest(input);
  if (!decoded.ok) throw new Error(JSON.stringify(decoded.issues));
  return decoded.value;
};

const decodeSaveNote = (input: unknown) => {
  const decoded = decodeSaveNoteContentRequest(input);
  if (!decoded.ok) throw new Error(JSON.stringify(decoded.issues));
  return decoded.value;
};

const loadSnapshot = async (
  service: ReturnType<typeof createPostgresProductService>,
  userId: string,
  scope: string,
) => {
  let through: string | null = null;
  let after: unknown = null;
  const records: SnapshotEntity[] = [];
  let organization: Organization | undefined;
  let head: { cursor: string; capturedAt: string } | undefined;
  for (;;) {
    const decoded = decodeSnapshotPageRequest({
      organizationId: scope,
      through,
      after,
      limit: 500,
    });
    if (!decoded.ok) throw new Error(JSON.stringify(decoded.issues));
    // Test assembly follows the public continuation exactly.
    // eslint-disable-next-line no-await-in-loop
    const page = await service.snapshot(userId, decoded.value);
    organization = page.organization;
    head = page.head;
    records.push(...page.entities);
    if (!page.hasMore) break;
    through = page.head.cursor;
    after = page.next;
  }
  return {
    organization,
    cursor: head?.cursor,
    capturedAt: head?.capturedAt,
    members: records
      .filter((item) => item.section === "organization-member")
      .map((item) => item.entity),
    projects: records.filter((item) => item.section === "project").map((item) => item.entity),
    threads: records.filter((item) => item.section === "thread").map((item) => item.entity),
    messages: records.filter((item) => item.section === "message").map((item) => item.entity),
    artifacts: records.filter((item) => item.section === "artifact").map((item) => item.entity),
  };
};

integration("PostgreSQL durable product core", () => {
  const client = new Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    await client.connect();
    await client.query("drop schema public cascade; create schema public");
    const migrationRoot = resolve(import.meta.dirname, "../../../infra/cloud/migrations/postgres");
    const migrationFiles = (await readdir(migrationRoot))
      .filter((file) => /^\d{4}_.+\.sql$/u.test(file))
      .sort();
    for (const migrationFile of migrationFiles) {
      // Migrations are ordered and each file may depend on the schema established by its predecessor.
      // eslint-disable-next-line no-await-in-loop
      const migration = await readFile(resolve(migrationRoot, migrationFile), "utf8");
      // eslint-disable-next-line no-await-in-loop
      await client.query(migration.replaceAll("--> statement-breakpoint", ""));
    }
    await client.query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at)
       values ($1, 'Owner', 'owner@glass.test', true, now(), now()),
              ($2, 'Outsider', 'outsider@glass.test', true, now(), now()),
              ($3, 'Member', 'member@glass.test', true, now(), now())`,
      [ownerId, outsiderId, memberId],
    );
  });

  afterAll(async () => {
    await client.end();
  });

  it("atomically persists projections, events, and receipts", async () => {
    const service = createPostgresProductService(client);
    const request = decodePush({
      organizationId,
      commands: [
        {
          commandId: commandId(1),
          organizationId,
          operation: { kind: "organization.create", name: "Glass Test" },
        },
        {
          commandId: commandId(2),
          organizationId,
          operation: {
            kind: "project.create",
            projectId,
            name: "Durable Core",
            description: "Integration coverage",
          },
        },
        {
          commandId: commandId(3),
          organizationId,
          operation: { kind: "thread.create", projectId, threadId, title: "Build" },
        },
        {
          commandId: commandId(4),
          organizationId,
          operation: { kind: "message.create", projectId, threadId, messageId, body: "Hello" },
        },
        {
          commandId: commandId(5),
          organizationId,
          operation: {
            kind: "artifact.create",
            projectId,
            threadId,
            artifactId,
            name: "Result",
            artifactKind: "agent-output",
            body: { status: "ready" },
          },
        },
      ],
    });

    const response = await service.push(ownerId, request);
    expect(response.results).toHaveLength(5);
    expect(response.results.at(-1)).toMatchObject({ status: "accepted", cursor: "6" });

    const snapshot = await loadSnapshot(service, ownerId, organizationId);
    expect(snapshot.cursor).toBe("6");
    expect(snapshot.organization.name).toBe("Glass Test");
    expect(snapshot.members).toHaveLength(1);
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.artifacts).toEqual([
      expect.objectContaining({
        body: { status: "ready" },
        kind: "agent-output",
        name: "Result",
      }),
    ]);

    const durableCounts = await client.query(
      `select
         (select count(*)::integer from product_events) as events,
         (select count(*)::integer from mutation_receipts) as receipts`,
    );
    expect(durableCounts.rows[0]).toEqual({ events: 6, receipts: 5 });
  });

  it("paginates a stable head without omissions or duplicates across a concurrent write", async () => {
    const service = createPostgresProductService(client);
    const scope = "21000000-0000-4000-8000-000000000001";
    const firstProject = "31000000-0000-4000-8000-000000000001";
    const secondProject = "31000000-0000-4000-8000-000000000002";
    const postHeadProject = "31000000-0000-4000-8000-000000000003";
    await service.push(
      ownerId,
      decodePush({
        organizationId: scope,
        commands: [
          {
            commandId: "81000000-0000-4000-8000-000000000001",
            organizationId: scope,
            operation: { kind: "organization.create", name: "Paged" },
          },
          {
            commandId: "81000000-0000-4000-8000-000000000002",
            organizationId: scope,
            operation: {
              kind: "project.create",
              projectId: firstProject,
              name: "First",
              description: null,
            },
          },
          {
            commandId: "81000000-0000-4000-8000-000000000003",
            organizationId: scope,
            operation: {
              kind: "project.create",
              projectId: secondProject,
              name: "Second",
              description: null,
            },
          },
        ],
      }),
    );
    const initialRequest = decodeSnapshotPageRequest({
      organizationId: scope,
      through: null,
      after: null,
      limit: 1,
    });
    if (!initialRequest.ok) throw new Error(JSON.stringify(initialRequest.issues));
    const firstPage = await service.snapshot(ownerId, initialRequest.value);
    expect(firstPage.entities).toHaveLength(1);
    expect(firstPage.hasMore).toBe(true);

    await service.push(
      ownerId,
      decodePush({
        organizationId: scope,
        commands: [
          {
            commandId: "81000000-0000-4000-8000-000000000004",
            organizationId: scope,
            operation: {
              kind: "project.create",
              projectId: postHeadProject,
              name: "After head",
              description: null,
            },
          },
        ],
      }),
    );
    await client.query(
      `update projects
          set created_at = (select created_at - interval '1 day' from organizations where id = $1)
        where organization_id = $1 and id = $2`,
      [scope, postHeadProject],
    );
    await client.query(
      `update organization_sync_state set retention_floor = $2
        where organization_id = $1`,
      [scope, firstPage.head.cursor],
    );
    await client.query(`delete from product_events where organization_id = $1 and cursor < $2`, [
      scope,
      firstPage.head.cursor,
    ]);
    if (firstPage.next === null) throw new Error("Expected a continuation.");
    const expired = decodeSnapshotPageRequest({
      organizationId: scope,
      through: String(BigInt(firstPage.head.cursor) - 1n),
      after: firstPage.next,
      limit: 1,
    });
    if (!expired.ok) throw new Error(JSON.stringify(expired.issues));
    await expect(service.snapshot(ownerId, expired.value)).rejects.toMatchObject({
      code: "cursor-expired",
    });

    const entities = [...firstPage.entities];
    let next = firstPage.next;
    while (next !== null) {
      const continuation = decodeSnapshotPageRequest({
        organizationId: scope,
        through: firstPage.head.cursor,
        after: next,
        limit: 1,
      });
      if (!continuation.ok) throw new Error(JSON.stringify(continuation.issues));
      // Continuation is intentionally serialized behind the prior keyset.
      // eslint-disable-next-line no-await-in-loop
      const page = await service.snapshot(ownerId, continuation.value);
      expect(page.head).toEqual(firstPage.head);
      expect(page.entities.length).toBeLessThanOrEqual(1);
      entities.push(...page.entities);
      next = page.next;
    }
    const identities = entities.map((item) =>
      item.section === "organization-member"
        ? `member:${"userId" in item.entity ? item.entity.userId : ""}`
        : `${item.section}:${"id" in item.entity ? item.entity.id : ""}`,
    );
    expect(new Set(identities).size).toBe(identities.length);
    expect(identities).toContain(`project:${firstProject}`);
    expect(identities).toContain(`project:${secondProject}`);
    expect(identities).not.toContain(`project:${postHeadProject}`);
    const pulled = await service.pull(
      ownerId,
      decodePull({
        organizationId: scope,
        after: firstPage.head.cursor,
        through: null,
        limit: 10,
      }),
    );
    expect(pulled.events).toContainEqual(
      expect.objectContaining({ aggregateId: postHeadProject, aggregateType: "project" }),
    );
    await expect(service.snapshot(outsiderId, initialRequest.value)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("rejects duplicate command identifiers before beginning durable push work", async () => {
    const service = createPostgresProductService(client);
    const scope = "25000000-0000-4000-8000-000000000001";
    const mutation = {
      commandId: "85000000-0000-4000-8000-000000000001",
      organizationId: scope,
      operation: { kind: "organization.create", name: "Must not commit" },
    };
    const request = {
      organizationId: scope,
      commands: [mutation, mutation],
    } as unknown as PushCommandsRequest;
    await expect(service.push(ownerId, request)).rejects.toMatchObject({ code: "invalid" });
    const persisted = await client.query("select id from organizations where id = $1", [scope]);
    expect(persisted.rows).toEqual([]);
  });

  it("keeps large snapshot transport pages under the serialized byte boundary", async () => {
    const service = createPostgresProductService(client);
    const scope = "22000000-0000-4000-8000-000000000001";
    const project = "32000000-0000-4000-8000-000000000001";
    await service.push(
      ownerId,
      decodePush({
        organizationId: scope,
        commands: [
          {
            commandId: "82000000-0000-4000-8000-000000000001",
            organizationId: scope,
            operation: { kind: "organization.create", name: "Byte bounded" },
          },
          {
            commandId: "82000000-0000-4000-8000-000000000002",
            organizationId: scope,
            operation: {
              kind: "project.create",
              projectId: project,
              name: "Large outputs",
              description: null,
            },
          },
        ],
      }),
    );
    for (let index = 1; index <= 5; index += 1) {
      // Each write remains below the independently enforced push boundary.
      // eslint-disable-next-line no-await-in-loop
      await service.push(
        ownerId,
        decodePush({
          organizationId: scope,
          commands: [
            {
              commandId: `82000000-0000-4000-8000-${(index + 2).toString().padStart(12, "0")}`,
              organizationId: scope,
              operation: {
                kind: "artifact.create",
                artifactId: `72000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
                artifactKind: "agent-output",
                projectId: project,
                threadId: null,
                name: `Large ${index}`,
                body: "x".repeat(900_000),
              },
            },
          ],
        }),
      );
    }
    let through: string | null = null;
    let after: unknown = null;
    const artifactIds: string[] = [];
    let pageCount = 0;
    for (;;) {
      const decoded = decodeSnapshotPageRequest({
        organizationId: scope,
        through,
        after,
        limit: 500,
      });
      if (!decoded.ok) throw new Error(JSON.stringify(decoded.issues));
      // eslint-disable-next-line no-await-in-loop
      const page = await service.snapshot(ownerId, decoded.value);
      pageCount += 1;
      expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(
        maxSnapshotResponseBytes,
      );
      artifactIds.push(
        ...page.entities.flatMap((item) =>
          item.section === "artifact" && "id" in item.entity ? [item.entity.id] : [],
        ),
      );
      if (!page.hasMore) break;
      through = page.head.cursor;
      after = page.next;
    }
    expect(pageCount).toBeGreaterThan(1);
    expect(artifactIds).toHaveLength(5);
    expect(new Set(artifactIds).size).toBe(5);
    const serviceSource = await readFile(
      resolve(import.meta.dirname, "../src/product-service.ts"),
      "utf8",
    );
    const snapshotSql = serviceSource.slice(serviceSource.indexOf("snapshot: (userId, request)"));
    expect(snapshotSql.match(/with recursive page as/gu)).toHaveLength(5);
    expect(snapshotSql).not.toContain("count(*) over");
    expect(snapshotSql).toContain(
      "page.cumulative_wire_bytes + next_artifact.conservative_wire_bytes",
    );
  });

  it("continues when a later section candidate cannot fit the remaining page bytes", async () => {
    const service = createPostgresProductService(client);
    const scope = "26000000-0000-4000-8000-000000000001";
    const project = "36000000-0000-4000-8000-000000000001";
    const thread = "46000000-0000-4000-8000-000000000001";
    const artifact = "76000000-0000-4000-8000-000000000001";
    await service.push(
      ownerId,
      decodePush({
        organizationId: scope,
        commands: [
          {
            commandId: "86000000-0000-4000-8000-000000000001",
            organizationId: scope,
            operation: { kind: "organization.create", name: "Section byte boundary" },
          },
          {
            commandId: "86000000-0000-4000-8000-000000000002",
            organizationId: scope,
            operation: {
              kind: "project.create",
              projectId: project,
              name: "Boundary",
              description: null,
            },
          },
          {
            commandId: "86000000-0000-4000-8000-000000000003",
            organizationId: scope,
            operation: { kind: "thread.create", projectId: project, threadId: thread, title: null },
          },
        ],
      }),
    );
    const messageSizes = [1_000_000, 1_000_000, 1_000_000, 100_000] as const;
    for (const [index, size] of messageSizes.entries()) {
      // eslint-disable-next-line no-await-in-loop
      await service.push(
        ownerId,
        decodePush({
          organizationId: scope,
          commands: [
            {
              commandId: `86000000-0000-4000-8000-${(index + 4).toString().padStart(12, "0")}`,
              organizationId: scope,
              operation: {
                kind: "message.create",
                messageId: `56000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
                projectId: project,
                threadId: thread,
                body: "m".repeat(size),
              },
            },
          ],
        }),
      );
    }
    await service.push(
      ownerId,
      decodePush({
        organizationId: scope,
        commands: [
          {
            commandId: "86000000-0000-4000-8000-000000000008",
            organizationId: scope,
            operation: {
              kind: "artifact.create",
              artifactId: artifact,
              artifactKind: "agent-output",
              projectId: project,
              threadId: null,
              name: "Must continue",
              body: "a".repeat(999_000),
            },
          },
        ],
      }),
    );
    const initial = decodeSnapshotPageRequest({
      organizationId: scope,
      through: null,
      after: null,
      limit: 500,
    });
    if (!initial.ok) throw new Error(JSON.stringify(initial.issues));
    const firstPage = await service.snapshot(ownerId, initial.value);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.next?.section).toBe("message");
    expect(
      firstPage.entities.some(
        (item) => item.section === "artifact" && "id" in item.entity && item.entity.id === artifact,
      ),
    ).toBe(false);
    const continuation = decodeSnapshotPageRequest({
      organizationId: scope,
      through: firstPage.head.cursor,
      after: firstPage.next,
      limit: 500,
    });
    if (!continuation.ok) throw new Error(JSON.stringify(continuation.issues));
    const secondPage = await service.snapshot(ownerId, continuation.value);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.entities).toContainEqual(
      expect.objectContaining({
        section: "artifact",
        entity: expect.objectContaining({ id: artifact }),
      }),
    );
  });

  it("excludes a membership reactivated after the pinned snapshot head", async () => {
    const service = createPostgresProductService(client);
    const scope = "24000000-0000-4000-8000-000000000001";
    const project = "34000000-0000-4000-8000-000000000001";
    await service.push(
      ownerId,
      decodePush({
        organizationId: scope,
        commands: [
          {
            commandId: "84000000-0000-4000-8000-000000000001",
            organizationId: scope,
            operation: { kind: "organization.create", name: "Reactivation" },
          },
          {
            commandId: "84000000-0000-4000-8000-000000000002",
            organizationId: scope,
            operation: {
              kind: "member.put",
              userId: memberId,
              role: "member",
              expectedVersion: null,
            },
          },
          {
            commandId: "84000000-0000-4000-8000-000000000003",
            organizationId: scope,
            operation: { kind: "member.remove", userId: memberId, expectedVersion: 1 },
          },
          {
            commandId: "84000000-0000-4000-8000-000000000005",
            organizationId: scope,
            operation: {
              kind: "project.create",
              projectId: project,
              name: "Continuation",
              description: null,
            },
          },
        ],
      }),
    );
    const initial = decodeSnapshotPageRequest({
      organizationId: scope,
      through: null,
      after: null,
      limit: 1,
    });
    if (!initial.ok) throw new Error(JSON.stringify(initial.issues));
    const firstPage = await service.snapshot(ownerId, initial.value);
    await service.push(
      ownerId,
      decodePush({
        organizationId: scope,
        commands: [
          {
            commandId: "84000000-0000-4000-8000-000000000004",
            organizationId: scope,
            operation: {
              kind: "member.put",
              userId: memberId,
              role: "member",
              expectedVersion: null,
            },
          },
        ],
      }),
    );
    const entities = [...firstPage.entities];
    let next = firstPage.next;
    while (next !== null) {
      const continuation = decodeSnapshotPageRequest({
        organizationId: scope,
        through: firstPage.head.cursor,
        after: next,
        limit: 1,
      });
      if (!continuation.ok) throw new Error(JSON.stringify(continuation.issues));
      // eslint-disable-next-line no-await-in-loop
      const page = await service.snapshot(ownerId, continuation.value);
      entities.push(...page.entities);
      next = page.next;
    }
    expect(
      entities.some(
        (item) =>
          item.section === "organization-member" &&
          "userId" in item.entity &&
          item.entity.userId === memberId,
      ),
    ).toBe(false);
    const pulled = await service.pull(
      ownerId,
      decodePull({
        organizationId: scope,
        after: firstPage.head.cursor,
        through: null,
        limit: 10,
      }),
    );
    expect(pulled.events).toContainEqual(
      expect.objectContaining({
        aggregateType: "organization-member",
        aggregateId: memberId,
        action: "created",
      }),
    );
  });

  it("converges when a member is removed and a parent is archived after the pinned head", async () => {
    const service = createPostgresProductService(client);
    const scope = "23000000-0000-4000-8000-000000000001";
    const project = "33000000-0000-4000-8000-000000000001";
    const thread = "43000000-0000-4000-8000-000000000001";
    const artifact = "73000000-0000-4000-8000-000000000001";
    await service.push(
      ownerId,
      decodePush({
        organizationId: scope,
        commands: [
          {
            commandId: "83000000-0000-4000-8000-000000000001",
            organizationId: scope,
            operation: { kind: "organization.create", name: "Concurrent removal" },
          },
          {
            commandId: "83000000-0000-4000-8000-000000000002",
            organizationId: scope,
            operation: {
              kind: "member.put",
              userId: memberId,
              role: "member",
              expectedVersion: null,
            },
          },
          {
            commandId: "83000000-0000-4000-8000-000000000003",
            organizationId: scope,
            operation: {
              kind: "project.create",
              projectId: project,
              name: "Parent",
              description: null,
            },
          },
          {
            commandId: "83000000-0000-4000-8000-000000000004",
            organizationId: scope,
            operation: { kind: "thread.create", projectId: project, threadId: thread, title: null },
          },
          {
            commandId: "83000000-0000-4000-8000-000000000005",
            organizationId: scope,
            operation: {
              kind: "artifact.create",
              artifactId: artifact,
              artifactKind: "agent-output",
              projectId: project,
              threadId: thread,
              name: "Thread output",
              body: { ok: true },
            },
          },
        ],
      }),
    );
    const initial = decodeSnapshotPageRequest({
      organizationId: scope,
      through: null,
      after: null,
      limit: 1,
    });
    if (!initial.ok) throw new Error(JSON.stringify(initial.issues));
    const firstPage = await service.snapshot(ownerId, initial.value);
    await service.push(
      ownerId,
      decodePush({
        organizationId: scope,
        commands: [
          {
            commandId: "83000000-0000-4000-8000-000000000006",
            organizationId: scope,
            operation: { kind: "member.remove", userId: memberId, expectedVersion: 1 },
          },
          {
            commandId: "83000000-0000-4000-8000-000000000007",
            organizationId: scope,
            operation: { kind: "thread.delete", threadId: thread, expectedVersion: 1 },
          },
        ],
      }),
    );
    const entities = [...firstPage.entities];
    let next = firstPage.next;
    while (next !== null) {
      const continuation = decodeSnapshotPageRequest({
        organizationId: scope,
        through: firstPage.head.cursor,
        after: next,
        limit: 1,
      });
      if (!continuation.ok) throw new Error(JSON.stringify(continuation.issues));
      // eslint-disable-next-line no-await-in-loop
      const page = await service.snapshot(ownerId, continuation.value);
      entities.push(...page.entities);
      next = page.next;
    }
    expect(
      entities.some(
        (item) =>
          item.section === "organization-member" &&
          "userId" in item.entity &&
          item.entity.userId === memberId,
      ),
    ).toBe(false);
    expect(
      entities.some(
        (item) =>
          (item.section === "thread" || item.section === "artifact") &&
          "id" in item.entity &&
          (item.entity.id === thread || item.entity.id === artifact),
      ),
    ).toBe(false);
    expect(
      entities.some(
        (item) => item.section === "project" && "id" in item.entity && item.entity.id === project,
      ),
    ).toBe(true);
    const pulled = await service.pull(
      ownerId,
      decodePull({
        organizationId: scope,
        after: firstPage.head.cursor,
        through: null,
        limit: 10,
      }),
    );
    expect(pulled.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ aggregateType: "organization-member", action: "deleted" }),
        expect.objectContaining({ aggregateType: "thread", action: "deleted" }),
      ]),
    );
  });

  it("replays receipts idempotently and rejects command-id payload changes", async () => {
    const service = createPostgresProductService(client);
    const original = decodePush({
      organizationId,
      commands: [
        {
          commandId: commandId(2),
          organizationId,
          operation: {
            kind: "project.create",
            projectId,
            name: "Durable Core",
            description: "Integration coverage",
          },
        },
      ],
    });
    await expect(service.push(ownerId, original)).resolves.toEqual({
      results: [expect.objectContaining({ status: "accepted", cursor: "3" })],
    });
    await expect(
      service.push(
        ownerId,
        decodePush({
          organizationId,
          commands: [
            {
              commandId: commandId(2),
              organizationId,
              operation: {
                kind: "project.create",
                projectId,
                name: "Changed payload",
                description: null,
              },
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const count = await client.query(
      "select count(*)::integer as count from product_events where organization_id = $1",
      [organizationId],
    );
    expect(count.rows[0]?.count).toBe(6);
  });

  it("rejects a second organization-create command instead of duplicating creation events", async () => {
    const service = createPostgresProductService(client);
    await expect(
      service.push(
        ownerId,
        decodePush({
          organizationId,
          commands: [
            {
              commandId: commandId(7),
              organizationId,
              operation: { kind: "organization.create", name: "Duplicate" },
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const afterConflict = await client.query(
      "select count(*)::integer as count from product_events where organization_id = $1",
      [organizationId],
    );
    expect(afterConflict.rows[0]?.count).toBe(6);
  });

  it("pages a bounded organization feed and rejects cross-organization access", async () => {
    const service = createPostgresProductService(client);
    const firstPage = await service.pull(
      ownerId,
      decodePull({ organizationId, after: null, through: null, limit: 3 }),
    );
    expect(firstPage.events.map((event) => event.cursor)).toEqual(["1", "2", "3"]);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = await service.pull(
      ownerId,
      decodePull({
        organizationId,
        after: firstPage.nextCursor,
        through: firstPage.head.cursor,
        limit: 10,
      }),
    );
    expect(secondPage.events.at(-1)?.cursor).toBe("6");
    expect(secondPage.hasMore).toBe(false);

    await service.push(
      outsiderId,
      decodePush({
        organizationId: otherOrganizationId,
        commands: [
          {
            commandId: commandId(20),
            organizationId: otherOrganizationId,
            operation: { kind: "organization.create", name: "Other" },
          },
        ],
      }),
    );
    await expect(loadSnapshot(service, ownerId, otherOrganizationId)).rejects.toBeInstanceOf(
      ProductFailure,
    );
    await expect(loadSnapshot(service, ownerId, otherOrganizationId)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("serializes concurrent organization cursors across separate database connections", async () => {
    const leftClient = new Client({ connectionString: databaseUrl });
    const rightClient = new Client({ connectionString: databaseUrl });
    await Promise.all([leftClient.connect(), rightClient.connect()]);
    try {
      const left = createPostgresProductService(leftClient);
      const right = createPostgresProductService(rightClient);
      const [leftResult, rightResult] = await Promise.all([
        left.push(
          ownerId,
          decodePush({
            organizationId,
            commands: [
              {
                commandId: commandId(30),
                organizationId,
                operation: {
                  kind: "project.create",
                  projectId: "30000000-0000-4000-8000-000000000002",
                  name: "Concurrent left",
                  description: null,
                },
              },
            ],
          }),
        ),
        right.push(
          ownerId,
          decodePush({
            organizationId,
            commands: [
              {
                commandId: commandId(31),
                organizationId,
                operation: {
                  kind: "project.create",
                  projectId: "30000000-0000-4000-8000-000000000003",
                  name: "Concurrent right",
                  description: null,
                },
              },
            ],
          }),
        ),
      ]);
      const cursors = [leftResult.results[0], rightResult.results[0]]
        .flatMap((result) => (result?.status === "accepted" ? [Number(result.cursor)] : []))
        .sort((leftCursor, rightCursor) => leftCursor - rightCursor);
      expect(cursors).toEqual([7, 8]);
      const events = await client.query(
        `select cursor::integer from product_events
          where organization_id = $1 and cursor >= 7
          order by cursor`,
        [organizationId],
      );
      expect(events.rows).toEqual([{ cursor: 7 }, { cursor: 8 }]);
    } finally {
      await Promise.all([leftClient.end(), rightClient.end()]);
    }
  });

  it("rejects writes to records hidden by an archived parent project", async () => {
    const service = createPostgresProductService(client);
    const archivedProjectId = "30000000-0000-4000-8000-000000000004";
    const archivedThreadId = "40000000-0000-4000-8000-000000000004";
    const archivedMessageId = "50000000-0000-4000-8000-000000000004";
    const archivedArtifactId = "70000000-0000-4000-8000-000000000004";
    await service.push(
      ownerId,
      decodePush({
        organizationId,
        commands: [
          {
            commandId: commandId(40),
            organizationId,
            operation: {
              kind: "project.create",
              projectId: archivedProjectId,
              name: "Archived",
              description: null,
            },
          },
          {
            commandId: commandId(41),
            organizationId,
            operation: {
              kind: "thread.create",
              projectId: archivedProjectId,
              threadId: archivedThreadId,
              title: null,
            },
          },
          {
            commandId: commandId(42),
            organizationId,
            operation: {
              kind: "message.create",
              projectId: archivedProjectId,
              threadId: archivedThreadId,
              messageId: archivedMessageId,
              body: "Archived parent",
            },
          },
          {
            commandId: commandId(43),
            organizationId,
            operation: {
              kind: "artifact.create",
              projectId: archivedProjectId,
              threadId: archivedThreadId,
              artifactId: archivedArtifactId,
              name: "Archived output",
              artifactKind: "agent-output",
              body: { status: "ready" },
            },
          },
          {
            commandId: commandId(44),
            organizationId,
            operation: {
              kind: "project.delete",
              projectId: archivedProjectId,
              expectedVersion: 1,
            },
          },
        ],
      }),
    );

    for (const [suffix, operation] of [
      [
        45,
        {
          kind: "thread.update",
          threadId: archivedThreadId,
          title: "Invisible update",
          expectedVersion: 1,
        },
      ],
      [46, { kind: "message.delete", messageId: archivedMessageId, expectedVersion: 1 }],
      [47, { kind: "artifact.delete", artifactId: archivedArtifactId, expectedVersion: 1 }],
    ] as const) {
      // Each command targets a different descendant but must fail at the same archived boundary.
      // eslint-disable-next-line no-await-in-loop
      await expect(
        service.push(
          ownerId,
          decodePush({
            organizationId,
            commands: [{ commandId: commandId(suffix), organizationId, operation }],
          }),
        ),
      ).rejects.toMatchObject({ code: "not-found" });
    }
    const eventCount = await client.query(
      "select count(*)::integer as count from product_events where organization_id = $1",
      [organizationId],
    );
    expect(eventCount.rows[0]?.count).toBe(13);
  });

  it("can expire retained events without destroying command receipts", async () => {
    const service = createPostgresProductService(client);
    await client.query(
      "update organization_sync_state set retention_floor = 2 where organization_id = $1",
      [organizationId],
    );
    await client.query("delete from product_events where organization_id = $1 and cursor <= 2", [
      organizationId,
    ]);
    const receipt = await client.query(
      `select cursor::integer
         from mutation_receipts
        where organization_id = $1 and actor_user_id = $2 and command_id = $3`,
      [organizationId, ownerId, commandId(1)],
    );
    expect(receipt.rows).toEqual([{ cursor: 2 }]);
    await expect(
      service.pull(ownerId, decodePull({ organizationId, after: "0", through: null, limit: 10 })),
    ).rejects.toMatchObject({ code: "cursor-expired" });
  });

  it("persists normalized OpenEditor snapshots outside the product event stream", async () => {
    const service = createPostgresProductService(client);
    const beforeCreate = await client.query(
      "select cursor::integer from organization_sync_state where organization_id = $1",
      [organizationId],
    );
    const cursorBeforeCreate = Number(beforeCreate.rows[0]?.cursor);
    const created = await service.push(
      ownerId,
      decodePush({
        organizationId,
        commands: [
          {
            commandId: commandId(60),
            organizationId,
            operation: {
              kind: "note.create",
              artifactId: noteId,
              projectId,
              name: "Notes",
              icon: "📝",
            },
          },
        ],
      }),
    );
    expect(Number(created.results[0]?.cursor)).toBe(cursorBeforeCreate + 1);

    const initial = await service.loadNoteContent(
      ownerId,
      decodeLoadNote({ organizationId, noteId }),
    );
    expect(initial).toMatchObject({
      organizationId,
      noteId,
      content: { type: "doc", version: 1, content: [] },
      savedByUserId: ownerId,
    });
    const snapshot = await loadSnapshot(service, ownerId, organizationId);
    expect(snapshot.artifacts).toContainEqual(
      expect.objectContaining({ id: noteId, kind: "note", name: "Notes", icon: "📝" }),
    );
    const noteMetadata = snapshot.artifacts.find((artifact) => artifact.id === noteId);
    expect(noteMetadata).not.toHaveProperty("body");
    expect(noteMetadata).not.toHaveProperty("threadId");

    const productStateBeforeSave = await client.query(
      `select
         (select cursor::integer from organization_sync_state where organization_id = $1) as cursor,
         (select count(*)::integer from product_events where organization_id = $1) as events`,
      [organizationId],
    );
    const input = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "Durable note" }] }],
      meta: { title: "Presentation metadata" },
    };
    const saveRequest = decodeSaveNote({ organizationId, noteId, content: input });
    const saved = await service.saveNoteContent(ownerId, saveRequest);
    expect(saved).toMatchObject({ organizationId, noteId, savedByUserId: ownerId });
    const loaded = await service.loadNoteContent(
      ownerId,
      decodeLoadNote({ organizationId, noteId }),
    );
    expect(loaded.content).toEqual(saveRequest.content);
    expect(loaded.savedAt).toBe(saved.savedAt);
    expect(loaded.savedByUserId).toBe(ownerId);

    const emptyBoundedNote = decodeSaveNote({
      organizationId,
      noteId,
      content: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "" }] }],
      },
    });
    const fixedNoteBytes = new TextEncoder().encode(
      JSON.stringify(emptyBoundedNote.content),
    ).byteLength;
    const exactBoundedNote = decodeSaveNote({
      organizationId,
      noteId,
      content: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "x".repeat(maxNoteContentBytes - fixedNoteBytes) }],
          },
        ],
      },
    });
    expect(new TextEncoder().encode(JSON.stringify(exactBoundedNote.content)).byteLength).toBe(
      maxNoteContentBytes,
    );
    await expect(service.saveNoteContent(ownerId, exactBoundedNote)).resolves.toMatchObject({
      noteId,
    });
    const exactLoaded = await service.loadNoteContent(
      ownerId,
      decodeLoadNote({ organizationId, noteId }),
    );
    expect(new TextEncoder().encode(JSON.stringify(exactLoaded.content)).byteLength).toBe(
      maxNoteContentBytes,
    );
    const productStateAfterSave = await client.query(
      `select
         (select cursor::integer from organization_sync_state where organization_id = $1) as cursor,
         (select count(*)::integer from product_events where organization_id = $1) as events`,
      [organizationId],
    );
    expect(productStateAfterSave.rows[0]).toEqual(productStateBeforeSave.rows[0]);

    await expect(
      service.saveNoteContent(ownerId, {
        ...saveRequest,
        content: { type: "doc", version: 2, content: [] },
      } as never),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      service.loadNoteContent(ownerId, decodeLoadNote({ organizationId, noteId: artifactId })),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(
      service.loadNoteContent(
        ownerId,
        decodeLoadNote({ organizationId: otherOrganizationId, noteId }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });

    await service.push(
      ownerId,
      decodePush({
        organizationId,
        commands: [
          {
            commandId: commandId(61),
            organizationId,
            operation: {
              kind: "note.update",
              artifactId: noteId,
              expectedVersion: 1,
              name: "Renamed note",
              icon: null,
            },
          },
        ],
      }),
    );
    await expect(
      service.push(
        ownerId,
        decodePush({
          organizationId,
          commands: [
            {
              commandId: commandId(63),
              organizationId,
              operation: {
                kind: "note.update",
                artifactId: noteId,
                expectedVersion: 1,
                name: "Stale rename",
                icon: null,
              },
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict", currentVersion: 2 });
    await service.push(
      ownerId,
      decodePush({
        organizationId,
        commands: [
          {
            commandId: commandId(62),
            organizationId,
            operation: { kind: "artifact.delete", artifactId: noteId, expectedVersion: 2 },
          },
        ],
      }),
    );
    await expect(
      service.loadNoteContent(ownerId, decodeLoadNote({ organizationId, noteId })),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(service.saveNoteContent(ownerId, saveRequest)).rejects.toMatchObject({
      code: "not-found",
    });
    const retained = await client.query(
      `select count(*)::integer as count
         from note_contents
        where organization_id = $1 and artifact_id = $2`,
      [organizationId, noteId],
    );
    expect(retained.rows[0]?.count).toBe(1);
  });

  it("accepts an exact-bound agent output despite jsonb rendering overhead", async () => {
    const service = createPostgresProductService(client);
    const boundedArtifactId = "70000000-0000-4000-8000-000000000003";
    const emptyBody = { value: "" };
    const fixedBytes = new TextEncoder().encode(JSON.stringify(emptyBody)).byteLength;
    const body = { value: "x".repeat(maxArtifactBodyBytes - fixedBytes) };
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBe(maxArtifactBodyBytes);

    await expect(
      service.push(
        ownerId,
        decodePush({
          organizationId,
          commands: [
            {
              commandId: commandId(64),
              organizationId,
              operation: {
                kind: "artifact.create",
                artifactId: boundedArtifactId,
                projectId,
                threadId: null,
                name: "Exact bound",
                artifactKind: "agent-output",
                body,
              },
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ results: [{ status: "accepted" }] });
  });

  it("rejects stale membership adds, role changes, and removals", async () => {
    const service = createPostgresProductService(client);
    const pushMember = (suffix: number, operation: Record<string, unknown>) =>
      service.push(
        ownerId,
        decodePush({
          organizationId,
          commands: [{ commandId: commandId(suffix), organizationId, operation }],
        }),
      );

    await expect(
      pushMember(70, {
        kind: "member.put",
        userId: memberId,
        role: "member",
        expectedVersion: null,
      }),
    ).resolves.toMatchObject({ results: [{ status: "accepted" }] });
    await expect(
      pushMember(71, {
        kind: "member.put",
        userId: memberId,
        role: "admin",
        expectedVersion: null,
      }),
    ).rejects.toMatchObject({ code: "conflict", currentVersion: 1 });
    await expect(
      pushMember(72, {
        kind: "member.put",
        userId: memberId,
        role: "admin",
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({ results: [{ status: "accepted" }] });
    await expect(
      pushMember(73, {
        kind: "member.remove",
        userId: memberId,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "conflict", currentVersion: 2 });
    await expect(
      pushMember(74, {
        kind: "member.remove",
        userId: memberId,
        expectedVersion: 2,
      }),
    ).resolves.toMatchObject({ results: [{ status: "accepted" }] });
    await expect(
      pushMember(75, {
        kind: "member.put",
        userId: memberId,
        role: "member",
        expectedVersion: null,
      }),
    ).resolves.toMatchObject({ results: [{ status: "accepted" }] });
    const member = await client.query(
      `select role, version, removed_at
         from organization_members
        where organization_id = $1 and user_id = $2`,
      [organizationId, memberId],
    );
    expect(member.rows[0]).toEqual({ role: "member", version: 4, removed_at: null });
  });

  it("keeps a captured pull head stable across pages while newer events commit", async () => {
    const service = createPostgresProductService(client);
    const first = await service.pull(
      ownerId,
      decodePull({ organizationId, after: "2", through: null, limit: 1 }),
    );
    expect(first.hasMore).toBe(true);

    await service.push(
      ownerId,
      decodePush({
        organizationId,
        commands: [
          {
            commandId: commandId(80),
            organizationId,
            operation: {
              kind: "project.create",
              projectId: "30000000-0000-4000-8000-000000000080",
              name: "Later event",
              description: null,
            },
          },
        ],
      }),
    );

    const second = await service.pull(
      ownerId,
      decodePull({
        organizationId,
        after: first.nextCursor,
        through: first.head.cursor,
        limit: 500,
      }),
    );
    expect(second.head).toEqual(first.head);
    const current = await service.pull(
      ownerId,
      decodePull({ organizationId, after: first.head.cursor, through: null, limit: 10 }),
    );
    expect(BigInt(current.head.cursor)).toBeGreaterThan(BigInt(first.head.cursor));
  });

  it("returns a contiguous byte-bounded prefix instead of materializing a huge pull page", async () => {
    const service = createPostgresProductService(client);
    const before = await client.query(
      `select cursor::text from organization_sync_state where organization_id = $1`,
      [organizationId],
    );
    const after = String(before.rows[0]?.cursor);
    for (let index = 0; index < 5; index += 1) {
      // These commands must commit in cursor order so the pull can prove a contiguous prefix.
      // eslint-disable-next-line no-await-in-loop
      await service.push(
        ownerId,
        decodePush({
          organizationId,
          commands: [
            {
              commandId: commandId(90 + index),
              organizationId,
              operation: {
                kind: "artifact.create",
                artifactId: `70000000-0000-4000-8000-${(90 + index).toString().padStart(12, "0")}`,
                projectId,
                threadId: null,
                name: `Large event ${index}`,
                artifactKind: "agent-output",
                body: "x".repeat(900_000),
              },
            },
          ],
        }),
      );
    }

    const first = await service.pull(
      ownerId,
      decodePull({ organizationId, after, through: null, limit: 500 }),
    );
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.events.length).toBeLessThan(5);
    expect(first.hasMore).toBe(true);
    const stringArtifact = first.events[0]?.entity;
    expect(stringArtifact).toMatchObject({ kind: "agent-output" });
    if (stringArtifact?.kind !== "agent-output") {
      throw new Error("The first bounded event is not an agent output.");
    }
    expect(stringArtifact.body).toBe("x".repeat(900_000));
    expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThanOrEqual(
      maxPullResponseBytes,
    );
    const second = await service.pull(
      ownerId,
      decodePull({
        organizationId,
        after: first.nextCursor,
        through: first.head.cursor,
        limit: 500,
      }),
    );
    expect(second.head).toEqual(first.head);
    expect([...first.events, ...second.events]).toHaveLength(5);
  });

  it("returns an empty current-head pull after retention prunes the head event", async () => {
    const service = createPostgresProductService(client);
    const state = await client.query(
      `select cursor::text, updated_at
         from organization_sync_state
        where organization_id = $1`,
      [organizationId],
    );
    const stateRow = state.rows[0];
    if (stateRow === undefined) throw new Error("The organization sync state is missing.");
    const cursor = String(stateRow.cursor);
    const capturedAt = (stateRow.updated_at as Date).toISOString();
    await client.query(
      `update organization_sync_state
          set retention_floor = cursor
        where organization_id = $1`,
      [organizationId],
    );
    await client.query(
      `delete from product_events
        where organization_id = $1 and cursor <= $2`,
      [organizationId, cursor],
    );

    await expect(
      service.pull(
        ownerId,
        decodePull({ organizationId, after: cursor, through: cursor, limit: 10 }),
      ),
    ).resolves.toEqual({
      events: [],
      hasMore: false,
      nextCursor: cursor,
      head: { organizationId, cursor, capturedAt },
    });
  });

  it("discovers only active memberships with stable keyset pagination", async () => {
    const service = createPostgresProductService(client);
    for (const [userId, id, suffix] of [
      [ownerId, discoveryOrganizationA, 901],
      [ownerId, discoveryOrganizationB, 902],
      [outsiderId, discoveryOrganizationOutsider, 903],
      [ownerId, discoveryOrganizationRemoved, 904],
    ] as const) {
      // Each organization bootstrap is an independent durable command.
      // eslint-disable-next-line no-await-in-loop
      await service.push(
        userId,
        decodePush({
          organizationId: id,
          commands: [
            {
              commandId: commandId(suffix),
              organizationId: id,
              operation: { kind: "organization.create", name: `Discovery ${suffix}` },
            },
          ],
        }),
      );
    }
    await client.query(
      `update organization_members
          set removed_at = now()
        where organization_id = $1 and user_id = $2`,
      [discoveryOrganizationRemoved, ownerId],
    );

    const first = await service.listOrganizations(
      ownerId,
      decodeListOrganizations({
        after: "c0000000-0000-4000-8000-000000000000",
        limit: 1,
      }),
    );
    expect(first.items).toEqual([
      expect.objectContaining({
        organization: expect.objectContaining({ id: discoveryOrganizationA }),
        membership: expect.objectContaining({ userId: ownerId, role: "owner" }),
      }),
    ]);
    expect(first.nextCursor).toBe(discoveryOrganizationA);

    const second = await service.listOrganizations(
      ownerId,
      decodeListOrganizations({ after: first.nextCursor, limit: 1 }),
    );
    expect(second.items).toEqual([
      expect.objectContaining({
        organization: expect.objectContaining({ id: discoveryOrganizationB }),
        membership: expect.objectContaining({ userId: ownerId }),
      }),
    ]);
    expect(second.nextCursor).toBeNull();

    const allOwnerOrganizations = await service.listOrganizations(
      ownerId,
      decodeListOrganizations({
        after: "c0000000-0000-4000-8000-000000000000",
        limit: 10,
      }),
    );
    expect(allOwnerOrganizations.items.map((item) => item.organization.id)).toEqual([
      discoveryOrganizationA,
      discoveryOrganizationB,
    ]);

    const outsider = await service.listOrganizations(
      outsiderId,
      decodeListOrganizations({
        after: "c0000000-0000-4000-8000-000000000000",
        limit: 10,
      }),
    );
    expect(outsider.items.map((item) => item.organization.id)).toEqual([
      discoveryOrganizationOutsider,
    ]);
    expect(outsider.items.every((item) => item.membership.userId === outsiderId)).toBe(true);
  });
});
