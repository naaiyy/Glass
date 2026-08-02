import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { electron } from "@better-auth/electron";
import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/node-postgres";

// Better Auth's generator needs an adapter-shaped configuration, not a live
// database. This file is schema tooling only and is never imported by the Worker.
export const auth = betterAuth({
  database: drizzleAdapter(drizzle.mock(), {
    provider: "pg",
  }),
  plugins: [electron({ clientID: "glass-desktop" }), expo()],
});
