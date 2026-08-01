import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import * as authSchema from "./db/schema.ts";
import type { GlassAuthConfig } from "./env.ts";

export type AuthSession = Readonly<{
  session: Readonly<{ id: string; userId: string }>;
  user: Readonly<{ id: string; email: string; name: string }>;
}>;

export interface GlassAuthRuntime {
  handle(request: Request): Promise<Response>;
  getSession(headers: Headers): Promise<AuthSession | null>;
  close(): Promise<void>;
}

export type GlassAuthRuntimeFactory = (config: GlassAuthConfig) => Promise<GlassAuthRuntime>;

export const createGlassAuthRuntime: GlassAuthRuntimeFactory = async (config) => {
  const client = new Client({ connectionString: config.connectionString });
  try {
    await client.connect();
    const database = drizzle(client, { schema: authSchema });
    const auth = betterAuth({
      baseURL: {
        allowedHosts: [...config.allowedHosts],
        protocol: "https",
      },
      secret: config.secret,
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
      advanced: {
        database: {
          generateId: () => crypto.randomUUID(),
        },
      },
    });

    return {
      handle: (request) => auth.handler(request),
      getSession: (headers) => auth.api.getSession({ headers }),
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
