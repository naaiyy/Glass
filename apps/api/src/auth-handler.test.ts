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

  it("restores the local browser origin only at the development auth boundary", async () => {
    const handleAuth = vi.fn(async (request: Request) =>
      Response.json({
        forwardedHost: request.headers.get("x-forwarded-host"),
        forwardedProtocol: request.headers.get("x-forwarded-proto"),
        internalHeader: request.headers.get("x-glass-development-origin"),
        requestOrigin: new URL(request.url).origin,
      }),
    );
    const request = new Request("https://glass.example/api/auth/sign-in/social", {
      headers: { "x-glass-development-origin": "http://127.0.0.1:5173" },
      method: "POST",
    });

    const development = await createGlassAuthHandler(handleAuth, true)(request);
    await expect(development.json()).resolves.toEqual({
      forwardedHost: "glass.example",
      forwardedProtocol: "https",
      internalHeader: null,
      requestOrigin: "http://127.0.0.1:5173",
    });

    const production = await createGlassAuthHandler(handleAuth, false)(request);
    await expect(production.json()).resolves.toEqual({
      forwardedHost: null,
      forwardedProtocol: null,
      internalHeader: "http://127.0.0.1:5173",
      requestOrigin: "https://glass.example",
    });
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
