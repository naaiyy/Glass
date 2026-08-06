import { describe, expect, it, vi } from "vite-plus/test";

import { createGlassAuthHandler } from "./auth.ts";

const proxyUrl =
  "https://glass.example/api/auth/electron/init-oauth-proxy?" +
  new URLSearchParams({
    provider: "github",
    client_id: "glass-desktop",
    code_challenge: "challenge",
    code_challenge_method: "S256",
    state: "state",
  }).toString();

describe("Glass authentication handler", () => {
  it("normalizes the Electron origin into mutable request headers", async () => {
    const handleAuth = vi.fn(async (request: Request) =>
      Response.json({ origin: request.headers.get("origin") }),
    );
    const response = await createGlassAuthHandler(handleAuth)(
      new Request("https://glass.example/api/auth/electron/token", {
        body: JSON.stringify({ token: "token" }),
        headers: {
          "content-type": "application/json",
          "electron-origin": "dev.glass.desktop:/",
        },
        method: "POST",
      }),
    );

    await expect(response.json()).resolves.toEqual({ origin: "dev.glass.desktop:/" });
    expect(handleAuth).toHaveBeenCalledOnce();
  });

  it("dispatches the Electron OAuth proxy internally and preserves its cookies", async () => {
    const handleAuth = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/api/auth/sign-in/social");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        client_id: "glass-desktop",
        code_challenge: "challenge",
        code_challenge_method: "S256",
        state: "state",
      });
      expect(request.method).toBe("POST");
      expect(request.headers.get("origin")).toBe("https://glass.example");
      expect(await request.json()).toEqual({ provider: "github" });
      return Response.json(
        { redirect: true, url: "https://github.com/login/oauth/authorize?state=oauth-state" },
        { headers: { "set-cookie": "__Secure-better-auth.state=signed; Path=/; Secure" } },
      );
    });
    const response = await createGlassAuthHandler(handleAuth)(new Request(proxyUrl));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://github.com/login/oauth/authorize?state=oauth-state",
    );
    expect(response.headers.get("set-cookie")).toContain("__Secure-better-auth.state=signed");
    expect(handleAuth).toHaveBeenCalledOnce();
  });

  it("leaves malformed proxy and ordinary auth requests with Better Auth", async () => {
    const handleAuth = vi.fn(async () => Response.json({ handled: true }));
    const handle = createGlassAuthHandler(handleAuth);

    await expect(handle(new Request(`${proxyUrl}&client_id=other`))).resolves.toHaveProperty(
      "status",
      200,
    );
    await expect(
      handle(new Request("https://glass.example/api/auth/get-session")),
    ).resolves.toHaveProperty("status", 200);
    expect(handleAuth).toHaveBeenCalledTimes(2);
  });
});
