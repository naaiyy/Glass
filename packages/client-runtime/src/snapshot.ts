import type { OrganizationId } from "@glass/contracts/ids";
import type {
  ProductSnapshot,
  SnapshotPageRequest,
  SnapshotPageResponse,
  SnapshotPosition,
} from "@glass/contracts/sync";
import {
  decodeProductSnapshot,
  decodeSnapshotPageResponse,
  maxSnapshotEntities,
} from "@glass/contracts/sync";
import type {
  Artifact,
  Message,
  Organization,
  OrganizationMember,
  Project,
  Thread,
} from "@glass/contracts/product";

export interface SnapshotTransport {
  /** Page responses cross a network boundary and are decoded before assembly. */
  snapshot(request: SnapshotPageRequest): Promise<unknown>;
}

export class SnapshotRuntimeError extends Error {
  readonly causeValue: unknown;

  constructor(message: string, causeValue?: unknown) {
    super(message);
    this.name = "SnapshotRuntimeError";
    this.causeValue = causeValue;
  }
}

/**
 * Loads bounded transport pages into one authoritative, whole-organization projection.
 * Page transfer is bounded; the assembled local projection intentionally is not.
 */
export const loadProductSnapshot = async (
  input: Readonly<{
    organizationId: OrganizationId;
    transport: SnapshotTransport;
  }>,
): Promise<ProductSnapshot> => {
  const members: OrganizationMember[] = [];
  const projects: Project[] = [];
  const threads: Thread[] = [];
  const messages: Message[] = [];
  const artifacts: Artifact[] = [];
  let after: SnapshotPosition | null = null;
  let through: SnapshotPageResponse["head"]["cursor"] | null = null;
  let pinnedHead: SnapshotPageResponse["head"] | null = null;
  let organization: Organization | null = null;

  for (let pageCount = 1; pageCount <= 10_000; pageCount += 1) {
    const request: SnapshotPageRequest = {
      organizationId: input.organizationId,
      through,
      after,
      limit: maxSnapshotEntities,
    };
    // Each page depends on the prior continuation and stable head.
    // eslint-disable-next-line no-await-in-loop
    const raw = await input.transport.snapshot(request);
    const decoded = decodeSnapshotPageResponse(raw, request);
    if (!decoded.ok) {
      throw new SnapshotRuntimeError("Snapshot page failed validation.", decoded.issues);
    }
    const page = decoded.value;
    if (
      pinnedHead !== null &&
      (page.head.cursor !== pinnedHead.cursor ||
        page.head.capturedAt !== pinnedHead.capturedAt ||
        page.head.organizationId !== pinnedHead.organizationId)
    ) {
      throw new SnapshotRuntimeError("Snapshot head changed during pagination.");
    }
    pinnedHead ??= page.head;
    if (organization === null || page.organization.version > organization.version) {
      organization = page.organization;
    }
    for (const item of page.entities) {
      if (item.section === "organization-member") members.push(item.entity as OrganizationMember);
      else if (item.section === "project") projects.push(item.entity as Project);
      else if (item.section === "thread") threads.push(item.entity as Thread);
      else if (item.section === "message") messages.push(item.entity as Message);
      else artifacts.push(item.entity as Artifact);
    }
    if (!page.hasMore) {
      if (pinnedHead === null || organization === null) {
        throw new SnapshotRuntimeError("Snapshot completed without an organization head.");
      }
      const snapshot = decodeProductSnapshot({
        organization,
        cursor: pinnedHead.cursor,
        capturedAt: pinnedHead.capturedAt,
        members,
        projects,
        threads,
        messages,
        artifacts,
      });
      if (!snapshot.ok) {
        throw new SnapshotRuntimeError("Assembled snapshot failed validation.", snapshot.issues);
      }
      return snapshot.value;
    }
    if (page.next === null) {
      throw new SnapshotRuntimeError("Snapshot page did not provide a continuation.");
    }
    after = page.next;
    through = page.head.cursor;
  }
  throw new SnapshotRuntimeError("Snapshot exceeded the page safety bound.");
};
