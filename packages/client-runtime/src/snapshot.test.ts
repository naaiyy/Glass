import { describe, expect, it } from "vite-plus/test";
import type { OrganizationId } from "@glass/contracts/ids";

import { loadProductSnapshot, SnapshotRuntimeError } from "./snapshot.ts";

const organizationId = "11111111-1111-4111-8111-111111111111" as OrganizationId;
const timestamp = "2026-08-02T12:00:00.000Z";
const organization = {
  id: organizationId,
  name: "Glass",
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const head = { organizationId, cursor: "2", capturedAt: timestamp };

describe("paginated product snapshot assembly", () => {
  it("assembles ordered bounded pages into one relational projection", async () => {
    const requests: unknown[] = [];
    const pages = [
      {
        organization,
        head,
        entities: [
          {
            section: "project",
            entity: {
              id: "22222222-2222-4222-8222-222222222222",
              organizationId,
              name: "Project",
              version: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          },
        ],
        hasMore: true,
        next: { section: "project", id: "22222222-2222-4222-8222-222222222222" },
      },
      {
        organization,
        head,
        entities: [
          {
            section: "thread",
            entity: {
              id: "33333333-3333-4333-8333-333333333333",
              organizationId,
              projectId: "22222222-2222-4222-8222-222222222222",
              title: null,
              version: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          },
        ],
        hasMore: false,
        next: null,
      },
    ];
    const snapshot = await loadProductSnapshot({
      organizationId,
      transport: {
        snapshot: async (request) => {
          requests.push(request);
          return pages.shift();
        },
      },
    });
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.threads).toHaveLength(1);
    expect(requests).toMatchObject([
      { through: null, after: null },
      { through: "2", after: { section: "project" } },
    ]);
  });

  it("rejects a changed head before committing an assembled projection", async () => {
    let page = 0;
    await expect(
      loadProductSnapshot({
        organizationId,
        transport: {
          snapshot: async () => {
            page += 1;
            return page === 1
              ? {
                  organization,
                  head,
                  entities: [
                    {
                      section: "project",
                      entity: {
                        id: "22222222-2222-4222-8222-222222222222",
                        organizationId,
                        name: "Project",
                        version: 1,
                        createdAt: timestamp,
                        updatedAt: timestamp,
                      },
                    },
                  ],
                  hasMore: true,
                  next: { section: "project", id: "22222222-2222-4222-8222-222222222222" },
                }
              : {
                  organization,
                  head: { ...head, capturedAt: "2026-08-02T12:00:01.000Z" },
                  entities: [],
                  hasMore: false,
                  next: null,
                };
          },
        },
      }),
    ).rejects.toBeInstanceOf(SnapshotRuntimeError);
  });
});
