import { describe, expect, it, vi } from "vite-plus/test";

import { setupDesktopAuthMain, type DesktopAuthMainClient } from "./auth-main.ts";

describe("desktop Better Auth main-process setup", () => {
  it("explicitly enables the IPC bridges when a window resolver is configured", () => {
    const setupMain = vi.fn<DesktopAuthMainClient["setupMain"]>();
    const getWindow = () => null;

    setupDesktopAuthMain({ getCookie: () => "", setupMain }, getWindow);

    expect(setupMain).toHaveBeenCalledOnce();
    expect(setupMain).toHaveBeenCalledWith({
      bridges: true,
      csp: true,
      getWindow,
      scheme: true,
    });
  });
});
