#!/usr/bin/env node

import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import { generateLocalSecrets, repositoryPath } from "./local-runtime.mjs";

const destination = NodePath.join(repositoryPath, "apps/api/.dev.vars");
const githubClientId = process.env.GLASS_LOCAL_GITHUB_CLIENT_ID?.trim();
const githubClientSecret = process.env.GLASS_LOCAL_GITHUB_CLIENT_SECRET?.trim();

if (!githubClientId || !githubClientSecret) {
  throw new Error(
    "Set GLASS_LOCAL_GITHUB_CLIENT_ID and GLASS_LOCAL_GITHUB_CLIENT_SECRET from the localhost OAuth application, then rerun `vp run dev:setup`.",
  );
}

const generated = generateLocalSecrets();
const source = [
  `BETTER_AUTH_SECRET=${generated.BETTER_AUTH_SECRET}`,
  `CONNECT_TICKET_SECRET=${generated.CONNECT_TICKET_SECRET}`,
  `GITHUB_CLIENT_ID=${githubClientId}`,
  `GITHUB_CLIENT_SECRET=${githubClientSecret}`,
  "",
].join("\n");

await NodeFS.writeFile(destination, source, { flag: "wx", mode: 0o600 });
process.stdout.write(`Created ${destination} with owner-only permissions.\n`);
