import { decodeOutboxEnvelope, type OutboxEnvelope } from "@glass/client-runtime/outbox";
import type { ProductMutation } from "@glass/contracts/events";
import type { ArtifactId, CommandId, OrganizationId, ProjectId } from "@glass/contracts/ids";
import { decodeId } from "@glass/contracts/ids";

type RandomUuid = () => string;

const requiredId = <Id extends string>(value: string, path: string): Id => {
  const decoded = decodeId<Id>(value, path);
  if (!decoded.ok) throw new Error("The secure UUID source returned an invalid identifier.");
  return decoded.value;
};

const commandId = (randomUuid: RandomUuid): CommandId =>
  requiredId<CommandId>(randomUuid(), "$commandId");

export const createOrganizationMutation = (
  name: string,
  randomUuid: RandomUuid = () => crypto.randomUUID(),
): Readonly<{ mutation: ProductMutation; organizationId: OrganizationId }> => {
  const organizationId = requiredId<OrganizationId>(randomUuid(), "$organizationId");
  return {
    organizationId,
    mutation: {
      commandId: commandId(randomUuid),
      operation: { kind: "organization.create", name },
      organizationId,
    },
  };
};

export const createOrganizationBootstrapEnvelope = (
  name: string,
  randomUuid: RandomUuid = () => crypto.randomUUID(),
  now: () => number = Date.now,
): Readonly<{ envelope: OutboxEnvelope; organizationId: OrganizationId }> => {
  const created = createOrganizationMutation(name, randomUuid);
  return {
    envelope: decodeOutboxEnvelope({
      attemptCount: 0,
      attention: null,
      enqueuedAt: new Date(now()).toISOString(),
      mutation: created.mutation,
      nextAttemptAt: null,
      schemaVersion: 1,
      status: "queued",
    }),
    organizationId: created.organizationId,
  };
};

export const createProjectMutation = (
  input: Readonly<{ description: string | null; name: string; organizationId: OrganizationId }>,
  randomUuid: RandomUuid = () => crypto.randomUUID(),
): Readonly<{ mutation: ProductMutation; projectId: ProjectId }> => {
  const projectId = requiredId<ProjectId>(randomUuid(), "$projectId");
  return {
    projectId,
    mutation: {
      commandId: commandId(randomUuid),
      operation: {
        description: input.description,
        kind: "project.create",
        name: input.name,
        projectId,
      },
      organizationId: input.organizationId,
    },
  };
};

export const createNoteMutation = (
  input: Readonly<{ name: string; organizationId: OrganizationId; projectId: ProjectId }>,
  randomUuid: RandomUuid = () => crypto.randomUUID(),
): Readonly<{ mutation: ProductMutation; noteId: ArtifactId }> => {
  const noteId = requiredId<ArtifactId>(randomUuid(), "$noteId");
  return {
    noteId,
    mutation: {
      commandId: commandId(randomUuid),
      operation: {
        artifactId: noteId,
        icon: null,
        kind: "note.create",
        name: input.name,
        projectId: input.projectId,
      },
      organizationId: input.organizationId,
    },
  };
};
