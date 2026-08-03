import {
  decodeConnectPresence,
  decodeConnectTicket,
  decodeConnectWorkspaceCatalog,
} from "@glass/contracts/connect";
import {
  decodeExecutionEnvironment,
  decodeExecutionEnvironmentList,
} from "@glass/contracts/environments";
import type { ExecutionEnvironmentId, OrganizationId } from "@glass/contracts/ids";
import {
  decodeExecutionDispatch,
  decodeExecutionDispatchOrOperation,
  decodeExecutionOperation,
  decodeWorkspaceBinding,
  decodeWorkspaceBindingList,
} from "@glass/contracts/execution-cloud";
import type { ExecutionOperationId, ProjectId, WorkspaceId } from "@glass/contracts/ids";
import type { ExecutionRequest } from "@glass/contracts/execution";
import type { ExecutionDispatch, ExecutionOperation } from "@glass/contracts/execution-cloud";
import type { DecodeResult } from "@glass/contracts/validation";

type Method = "DELETE" | "GET" | "POST";

const request = async (path: string, method: Method, body: unknown = null): Promise<unknown> => {
  const encoded = body === null ? null : JSON.stringify(body);
  if (window.glassDesktop?.requestProduct !== undefined) {
    const response = await window.glassDesktop.requestProduct({ path, method, body: encoded });
    const value = response.body === "" ? null : (JSON.parse(response.body) as unknown);
    if (response.status < 200 || response.status >= 300) {
      const message =
        typeof value === "object" && value !== null && "message" in value
          ? String(value.message)
          : "Glass Cloud rejected the environment request.";
      throw new Error(message);
    }
    return value;
  }
  const configured = import.meta.env.VITE_GLASS_API_URL as string | undefined;
  const url =
    configured === undefined || configured.trim() === ""
      ? path
      : new URL(path, new URL(configured).origin).toString();
  const response = await fetch(url, {
    credentials: "include",
    method,
    headers:
      encoded === null
        ? { accept: "application/json" }
        : { accept: "application/json", "content-type": "application/json" },
    body: encoded,
  });
  const value = response.status === 204 ? null : ((await response.json()) as unknown);
  if (!response.ok) {
    const message =
      typeof value === "object" && value !== null && "message" in value
        ? String(value.message)
        : "Glass Cloud rejected the environment request.";
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

export const environmentCloud = {
  approve: (organizationId: OrganizationId, pairingCode: string) =>
    request("/v1/environment-pairings/approve", "POST", { organizationId, pairingCode }),
  approveRotation: (organizationId: OrganizationId, rotationCode: string) =>
    request("/v1/environment-rotations/approve", "POST", {
      organizationId,
      rotationCode,
    }),
  list: (organizationId: OrganizationId) =>
    decoded(
      request(`/v1/environments?organizationId=${encodeURIComponent(organizationId)}`, "GET"),
      decodeExecutionEnvironmentList,
    ),
  presence: (organizationId: OrganizationId, environmentId: ExecutionEnvironmentId) =>
    decoded(
      request(
        `/v1/environments/${environmentId}/presence?organizationId=${encodeURIComponent(organizationId)}`,
        "GET",
      ),
      decodeConnectPresence,
    ),
  catalog: (organizationId: OrganizationId, environmentId: ExecutionEnvironmentId) =>
    decoded(
      request(
        `/v1/environments/${environmentId}/workspace-catalog?organizationId=${encodeURIComponent(organizationId)}`,
        "GET",
      ),
      decodeConnectWorkspaceCatalog,
    ),
  bindings: (organizationId: OrganizationId, projectId: ProjectId) =>
    decoded(
      request(
        `/v1/workspace-bindings?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`,
        "GET",
      ),
      decodeWorkspaceBindingList,
    ),
  revoke: (environmentId: ExecutionEnvironmentId) =>
    decoded(request(`/v1/environments/${environmentId}`, "DELETE"), decodeExecutionEnvironment),
  ticket: (
    organizationId: OrganizationId,
    environmentId: ExecutionEnvironmentId,
    clientNonce: string,
  ) =>
    decoded(
      request(`/v1/environments/${environmentId}/connect-ticket`, "POST", {
        organizationId,
        clientNonce,
      }),
      decodeConnectTicket,
    ),
  bindWorkspace: (
    organizationId: OrganizationId,
    environmentId: ExecutionEnvironmentId,
    projectId: ProjectId,
    workspaceId: WorkspaceId,
  ) =>
    decoded(
      request("/v1/workspace-bindings", "POST", {
        organizationId,
        environmentId,
        projectId,
        workspaceId,
      }),
      decodeWorkspaceBinding,
    ),
  createOperation: (
    organizationId: OrganizationId,
    environmentId: ExecutionEnvironmentId,
    projectId: ProjectId,
    workspaceId: WorkspaceId,
    operationId: ExecutionOperationId,
    requestId: string,
    executionRequest: ExecutionRequest,
  ) =>
    decoded(
      request("/v1/execution-operations", "POST", {
        organizationId,
        environmentId,
        projectId,
        workspaceId,
        operationId,
        requestId,
        request: executionRequest,
      }),
      decodeExecutionDispatch,
    ),
  operation: (operationId: ExecutionOperationId, after = -1) =>
    decoded(
      request(`/v1/execution-operations/${operationId}?after=${after}&limit=500`, "GET"),
      decodeExecutionOperation,
    ),
  redispatch: (operationId: ExecutionOperationId) =>
    decoded(
      request(`/v1/execution-operations/${operationId}/dispatch`, "POST"),
      decodeExecutionDispatchOrOperation,
    ),
  cancel: async (
    operationId: ExecutionOperationId,
  ): Promise<Readonly<{ dispatchGrant: string | null; operation: ExecutionOperation }>> => {
    const value = await request(`/v1/execution-operations/${operationId}/cancel`, "POST");
    if (typeof value !== "object" || value === null || !("operation" in value)) {
      throw new Error("Glass Cloud returned a malformed cancellation response.");
    }
    if ("dispatchGrant" in value && value.dispatchGrant === null) {
      const operation = decodeExecutionOperation(value.operation);
      if (!operation.ok)
        throw new Error("Glass Cloud returned a malformed terminal cancellation response.");
      return { dispatchGrant: null, operation: operation.value };
    }
    const dispatch = decodeExecutionDispatch(value);
    if (!dispatch.ok)
      throw new Error("Glass Cloud returned a malformed cancellation dispatch response.");
    return dispatch.value satisfies ExecutionDispatch;
  },
};
