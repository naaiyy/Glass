import type { WorkspaceId } from "@glass/contracts/ids";
import { describe, expect, it } from "vite-plus/test";
import {
  buildMobileExecutionRequest,
  defaultMobileExecutionDraft,
  mobileExecutionOperations,
  type MobileExecutionDraft,
} from "./execution-console.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111" as WorkspaceId;

const draftFor = (operation: MobileExecutionDraft["operation"]): MobileExecutionDraft => ({
  ...defaultMobileExecutionDraft,
  operation,
  checkpointId: "22222222-2222-4222-8222-222222222222",
  command: "printf",
  content: "héllo mobile",
  data: "echo mobile\n",
  gitSubcommand: "branch",
  terminalId: "terminal-mobile-1",
});

describe("native mobile execution request builder", () => {
  it("builds every supported Milestone 6 request through the shared contract", () => {
    for (const operation of mobileExecutionOperations) {
      const request = buildMobileExecutionRequest(draftFor(operation), workspaceId);
      expect(request.operation).toBe(operation);
      if (request.operation !== "workspace.list") expect(request.workspaceId).toBe(workspaceId);
    }
  });

  it("encodes UTF-8 file content without changing its text", () => {
    const request = buildMobileExecutionRequest(draftFor("file.write"), workspaceId);
    expect(request.operation).toBe("file.write");
    if (request.operation !== "file.write") throw new Error("Expected a file write request.");
    const bytes = Uint8Array.from(atob(request.contentBase64), (value) => value.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe("héllo mobile");
  });

  it("rejects invalid numeric terminal and command controls before cloud submission", () => {
    expect(() =>
      buildMobileExecutionRequest(
        { ...draftFor("terminal.resize"), cols: "not-a-number" },
        workspaceId,
      ),
    ).toThrow("Columns must be a whole number");
    expect(() =>
      buildMobileExecutionRequest({ ...draftFor("command.run"), timeoutMs: "1.5" }, workspaceId),
    ).toThrow("Timeout must be a whole number");
  });
});
