import {
  decodeConnectPresence,
  decodeConnectTicket,
  decodeConnectWorkspaceCatalog,
} from "@glass/contracts/connect";
import {
  decodeExecutionEnvironment,
  decodeExecutionEnvironmentList,
} from "@glass/contracts/environments";
import {
  decodeExecutionDispatch,
  decodeExecutionDispatchOrOperation,
  decodeExecutionOperation,
  decodeWorkspaceBinding,
  decodeWorkspaceBindingList,
} from "@glass/contracts/execution-cloud";
import type {
  ExecutionEnvironmentId,
  ExecutionOperationId,
  OrganizationId,
  ProjectId,
  WorkspaceId,
} from "@glass/contracts/ids";
import type { DecodeResult } from "@glass/contracts/validation";

import { mobileAuthenticatedFetch } from "./auth-client.ts";

const request = async (
  apiBaseUrl: string,
  path: string,
  method: "DELETE" | "GET" | "POST",
  body: unknown = null,
): Promise<unknown> => {
  const response = await mobileAuthenticatedFetch(apiBaseUrl)(new URL(path, apiBaseUrl), {
    method,
    headers: {
      accept: "application/json",
      ...(body === null ? {} : { "content-type": "application/json" }),
    },
    body: body === null ? null : JSON.stringify(body),
  });
  const value = response.status === 204 ? null : ((await response.json()) as unknown);
  if (!response.ok) {
    const message =
      typeof value === "object" && value !== null && "message" in value
        ? String(value.message)
        : "Glass Cloud rejected the execution request.";
    throw new Error(message);
  }
  return value;
};

const decoded = async <Value>(
  response: Promise<unknown>,
  decode: (input: unknown) => DecodeResult<Value>,
): Promise<Value> => {
  const result = decode(await response);
  if (!result.ok) throw new Error("Glass Cloud returned a malformed execution response.");
  return result.value;
};

export const listEnvironments = (apiBaseUrl: string, organizationId: OrganizationId) =>
  decoded(
    request(
      apiBaseUrl,
      `/v1/environments?organizationId=${encodeURIComponent(organizationId)}`,
      "GET",
    ),
    decodeExecutionEnvironmentList,
  );
export const loadEnvironmentPresence = (
  apiBaseUrl: string,
  organizationId: OrganizationId,
  environmentId: ExecutionEnvironmentId,
) =>
  decoded(
    request(
      apiBaseUrl,
      `/v1/environments/${environmentId}/presence?organizationId=${encodeURIComponent(organizationId)}`,
      "GET",
    ),
    decodeConnectPresence,
  );
export const loadWorkspaceCatalog = (
  apiBaseUrl: string,
  organizationId: OrganizationId,
  environmentId: ExecutionEnvironmentId,
) =>
  decoded(
    request(
      apiBaseUrl,
      `/v1/environments/${environmentId}/workspace-catalog?organizationId=${encodeURIComponent(organizationId)}`,
      "GET",
    ),
    decodeConnectWorkspaceCatalog,
  );
export const listWorkspaceBindings = (
  apiBaseUrl: string,
  organizationId: OrganizationId,
  projectId: ProjectId,
) =>
  decoded(
    request(
      apiBaseUrl,
      `/v1/workspace-bindings?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`,
      "GET",
    ),
    decodeWorkspaceBindingList,
  );
export const authorizeEnvironmentConnection = (
  apiBaseUrl: string,
  organizationId: OrganizationId,
  environmentId: ExecutionEnvironmentId,
  clientNonce: string,
) =>
  decoded(
    request(apiBaseUrl, `/v1/environments/${environmentId}/connect-ticket`, "POST", {
      organizationId,
      clientNonce,
    }),
    decodeConnectTicket,
  );
export const approveEnvironmentPairing = (
  apiBaseUrl: string,
  organizationId: OrganizationId,
  pairingCode: string,
) =>
  request(apiBaseUrl, "/v1/environment-pairings/approve", "POST", {
    organizationId,
    pairingCode,
  });
export const approveEnvironmentRotation = (
  apiBaseUrl: string,
  organizationId: OrganizationId,
  rotationCode: string,
) =>
  request(apiBaseUrl, "/v1/environment-rotations/approve", "POST", {
    organizationId,
    rotationCode,
  });
export const revokeEnvironment = (apiBaseUrl: string, environmentId: ExecutionEnvironmentId) =>
  decoded(
    request(apiBaseUrl, `/v1/environments/${environmentId}`, "DELETE"),
    decodeExecutionEnvironment,
  );
export const bindWorkspace = (
  apiBaseUrl: string,
  organizationId: OrganizationId,
  environmentId: ExecutionEnvironmentId,
  projectId: ProjectId,
  workspaceId: WorkspaceId,
) =>
  decoded(
    request(apiBaseUrl, "/v1/workspace-bindings", "POST", {
      organizationId,
      environmentId,
      projectId,
      workspaceId,
    }),
    decodeWorkspaceBinding,
  );
export const createFileList = (
  apiBaseUrl: string,
  organizationId: OrganizationId,
  environmentId: ExecutionEnvironmentId,
  projectId: ProjectId,
  workspaceId: WorkspaceId,
  operationId: ExecutionOperationId,
  requestId: string,
) =>
  decoded(
    request(apiBaseUrl, "/v1/execution-operations", "POST", {
      organizationId,
      environmentId,
      projectId,
      workspaceId,
      operationId,
      requestId,
      request: { operation: "file.list", workspaceId, path: "." },
    }),
    decodeExecutionDispatch,
  );
export const loadExecutionOperation = (apiBaseUrl: string, operationId: ExecutionOperationId) =>
  decoded(
    request(apiBaseUrl, `/v1/execution-operations/${operationId}?after=-1&limit=100`, "GET"),
    decodeExecutionOperation,
  );
export const redispatchExecutionOperation = (
  apiBaseUrl: string,
  operationId: ExecutionOperationId,
) =>
  decoded(
    request(apiBaseUrl, `/v1/execution-operations/${operationId}/dispatch`, "POST"),
    decodeExecutionDispatchOrOperation,
  );
