import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { electron } from "@better-auth/electron";
import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import * as authSchema from "./db/schema.ts";
import type { GlassAuthConfig } from "./env.ts";
import type { GlassApiBindingInput } from "./env.ts";
import { createPostgresProductService, type ProductService } from "./product-service.ts";
import {
  createPostgresEnvironmentService,
  type EnvironmentService,
} from "./environment-service.ts";
import { createPostgresExecutionService, type ExecutionService } from "./execution-service.ts";
import { createPostgresTunnelService, type TunnelService } from "./tunnel-service.ts";

export type AuthSession = Readonly<{
  session: Readonly<{ id: string; userId: string }>;
  user: Readonly<{ id: string; email: string; name: string }>;
}>;

export interface GlassAuthRuntime {
  handle(request: Request): Promise<Response>;
  getSession(headers: Headers): Promise<AuthSession | null>;
  product: ProductService;
  environment?: EnvironmentService;
  execution?: ExecutionService;
  tunnel?: TunnelService;
  close(): Promise<void>;
}

export type GlassAuthRuntimeFactory = (
  config: GlassAuthConfig,
  bindings?: GlassApiBindingInput,
) => Promise<GlassAuthRuntime>;

type AuthHandler = (request: Request) => Promise<Response>;

const electronOAuthProxyPath = "/api/auth/electron/init-oauth-proxy";

export const createGlassAuthHandler =
  (handleAuth: AuthHandler): AuthHandler =>
  async (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== electronOAuthProxyPath) {
      return handleAuth(request);
    }

    const provider = url.searchParams.get("provider");
    const clientId = url.searchParams.get("client_id");
    const codeChallenge = url.searchParams.get("code_challenge");
    const codeChallengeMethod = url.searchParams.get("code_challenge_method");
    const state = url.searchParams.get("state");
    if (
      provider !== "github" ||
      clientId !== "glass-desktop" ||
      codeChallenge === null ||
      codeChallenge.length === 0 ||
      codeChallengeMethod?.toLowerCase() !== "s256" ||
      state === null ||
      state.length === 0
    ) {
      // Keep Better Auth as the authority for malformed or unsupported proxy requests.
      return handleAuth(request);
    }

    const signInUrl = new URL("/api/auth/sign-in/social", url.origin);
    signInUrl.searchParams.set("client_id", clientId);
    signInUrl.searchParams.set("code_challenge", codeChallenge);
    signInUrl.searchParams.set("code_challenge_method", "S256");
    signInUrl.searchParams.set("state", state);
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    headers.set("origin", url.origin);
    const response = await handleAuth(
      new Request(signInUrl, {
        body: JSON.stringify({ provider }),
        headers,
        method: "POST",
      }),
    );
    if (!response.ok) return response;

    const payload = (await response.clone().json()) as unknown;
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("redirect" in payload) ||
      payload.redirect !== true ||
      !("url" in payload) ||
      typeof payload.url !== "string"
    ) {
      return response;
    }

    const redirectHeaders = new Headers(response.headers);
    redirectHeaders.delete("content-length");
    redirectHeaders.delete("content-type");
    redirectHeaders.set("cache-control", "no-store");
    redirectHeaders.set("location", payload.url);
    return new Response(null, { headers: redirectHeaders, status: 302 });
  };

export const createGlassAuthRuntime: GlassAuthRuntimeFactory = async (config, bindings) => {
  const client = new Client({
    connectionString: config.connectionString,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await client.connect();
    const database = drizzle(client, { schema: authSchema });
    const auth = betterAuth({
      baseURL: {
        allowedHosts: [...config.allowedHosts],
        protocol: "https",
      },
      secret: config.secret,
      trustedOrigins: [...config.trustedOrigins],
      database: drizzleAdapter(database, {
        provider: "pg",
        schema: authSchema,
      }),
      socialProviders: {
        github: {
          clientId: config.github.clientId,
          clientSecret: config.github.clientSecret,
        },
      },
      plugins: [electron({ clientID: "glass-desktop" }), expo()],
      advanced: {
        database: {
          generateId: () => crypto.randomUUID(),
        },
      },
    });

    const execution = createPostgresExecutionService(client);
    return {
      // Better Auth's Electron 1.6 proxy performs a public HTTP fetch back into its own origin.
      // Cloudflare Workers cannot recursively fetch the same Worker, so dispatch that one
      // equivalent social-sign-in request directly through the authenticated handler.
      handle: createGlassAuthHandler(auth.handler),
      getSession: (headers) => auth.api.getSession({ headers }),
      product: createPostgresProductService(client),
      environment: createPostgresEnvironmentService(client),
      execution,
      ...(bindings?.TUNNEL_CONTROL === undefined || config.tunnelZoneName === undefined
        ? {}
        : {
            tunnel: createPostgresTunnelService(
              client,
              bindings.TUNNEL_CONTROL,
              config.tunnelZoneName,
              config.stage,
              (grant, frame) => execution.recordNodeFrame(grant, frame),
            ),
          }),
      close: () => client.end(),
    };
  } catch (cause) {
    try {
      await client.end();
    } catch {
      // Preserve the connection/auth construction failure as the useful cause.
    }
    throw cause;
  }
};
