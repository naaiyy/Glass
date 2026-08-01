import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const expectedWorkspaces = {
  apps: ["api", "desktop", "execution-node", "mobile", "web"],
  packages: ["client-runtime", "contracts", "domain", "execution-core", "shared", "ui-web"],
};

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function filesBelow(relativeDirectory) {
  const directory = join(root, relativeDirectory);
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name);
    const relativePath = relative(root, absolutePath);
    if (
      entry.isDirectory() &&
      [
        ".electron-runtime",
        ".expo",
        ".vite-plus",
        "dist",
        "dist-electron",
        "node_modules",
      ].includes(entry.name)
    ) {
      return [];
    }
    if (entry.isDirectory()) return filesBelow(relativePath);
    return statSync(absolutePath).isFile() ? [relativePath] : [];
  });
}

function sourceText(relativeDirectory) {
  const sourceExtensions = /\.(?:[cm]?[jt]sx?|json)$/u;
  return filesBelow(relativeDirectory)
    .filter((file) => sourceExtensions.test(file))
    .map((file) => `${file}\n${read(file)}`)
    .join("\n");
}

function dependencyNames(manifest) {
  return new Set(
    [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ].flatMap((dependencies) => Object.keys(dependencies ?? {})),
  );
}

const workspaceConfig = read("pnpm-workspace.yaml");
assert.match(workspaceConfig, /(?:^|\n)\s*-\s*["']?apps\/\*["']?\s*(?:\n|$)/u);
assert.match(workspaceConfig, /(?:^|\n)\s*-\s*["']?packages\/\*["']?\s*(?:\n|$)/u);

for (const [kind, expectedNames] of Object.entries(expectedWorkspaces)) {
  const directory = join(root, kind);
  assert.ok(existsSync(directory), `Missing ${kind}/ workspace directory`);

  const actualNames = readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(directory, entry.name, "package.json")),
    )
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(actualNames, expectedNames, `${kind}/ must contain the six locked workspaces`);

  for (const name of expectedNames) {
    const workspacePath = `${kind}/${name}`;
    const manifest = readJson(`${workspacePath}/package.json`);
    assert.equal(
      manifest.name,
      `@glass/${name}`,
      `${workspacePath} has the canonical package name`,
    );
    assert.equal(
      manifest.private,
      true,
      `${workspacePath} must remain private during the foundation`,
    );
    assert.ok(
      manifest.scripts?.typecheck,
      `${workspacePath} must participate in workspace typechecking`,
    );
    assert.ok(manifest.scripts?.build, `${workspacePath} must participate in the full build`);
  }
}

const marketingDirectory = join(root, "apps/marketing");
assert.ok(existsSync(marketingDirectory), "apps/marketing must remain reserved");
assert.deepEqual(
  readdirSync(marketingDirectory).sort(),
  [".gitkeep"],
  "apps/marketing must contain only .gitkeep until the marketing site is built",
);

const apiManifest = readJson("apps/api/package.json");
const apiDependencies = dependencyNames(apiManifest);
for (const forbiddenDependency of ["electron", "node-pty"]) {
  assert.ok(
    !apiDependencies.has(forbiddenDependency),
    `apps/api must not depend on execution-only package ${forbiddenDependency}`,
  );
}
assert.ok(
  [...apiDependencies].every((dependency) => !dependency.startsWith("@glass/execution-")),
  "apps/api must not depend on execution-only Glass workspaces",
);

const apiSource = sourceText("apps/api/src");
for (const forbiddenImport of [
  /(?:from|import\s*)\s*\(?["']@glass\/execution-/u,
  /(?:from|import\s*)\s*\(?["']node-pty["']/u,
  /(?:from|import\s*)\s*\(?["']node:(?:child_process|fs|worker_threads)["']/u,
]) {
  assert.doesNotMatch(apiSource, forbiddenImport, "apps/api crossed the cloud/execution boundary");
}

const mobileManifest = readJson("apps/mobile/package.json");
const mobileDependencies = dependencyNames(mobileManifest);
assert.ok(!mobileDependencies.has("expo-router"), "mobile must not depend on Expo Router");
for (const navigationDependency of ["@react-navigation/native", "@react-navigation/native-stack"]) {
  assert.ok(
    mobileDependencies.has(navigationDependency),
    `mobile must use React Navigation (${navigationDependency} is missing)`,
  );
}
assert.doesNotMatch(
  sourceText("apps/mobile"),
  /(?:from|require\(|import\s*\()["']expo-router(?:\/[^"']*)?["']/u,
  "mobile must use React Navigation, not Expo Router",
);

const desktopManifest = readJson("apps/desktop/package.json");
const desktopDependencies = dependencyNames(desktopManifest);
assert.equal(
  desktopManifest.main,
  "dist-electron/main.cjs",
  "desktop must use the synchronously evaluated Electron CJS entry",
);
assert.match(
  desktopManifest.scripts.start,
  /start-electron\.mjs/u,
  "desktop must launch through the registered runtime wrapper",
);
for (const rendererDependency of ["react", "react-dom", "@vitejs/plugin-react"]) {
  assert.ok(
    !desktopDependencies.has(rendererDependency),
    `desktop must consume the web renderer instead of depending on ${rendererDependency}`,
  );
}

const desktopSource = sourceText("apps/desktop");
assert.doesNotMatch(
  desktopSource,
  /(?:from|require\(|import\s*\()["'](?:react|react-dom(?:\/client)?)["']/u,
  "desktop must not create a second React renderer",
);
assert.match(
  desktopSource,
  /GLASS_WEB_DEV_SERVER_URL/u,
  "desktop must expose the explicit development boundary to the shared web renderer",
);
assert.match(
  desktopSource,
  /(?:apps[\\/]web|\.\.[\\/]\.\.[\\/]web)[\\/]dist/u,
  "desktop production must load the shared apps/web build",
);
assert.match(
  desktopSource,
  /ensureElectronRuntime/u,
  "desktop must validate the Electron runtime before launch",
);
assert.match(
  desktopSource,
  /APP_BUNDLE_ID/u,
  "desktop must register a unique application identity",
);
assert.match(desktopSource, /contextIsolation:\s*true/u, "desktop must isolate renderer contexts");
assert.match(
  desktopSource,
  /nodeIntegration:\s*false/u,
  "desktop must disable renderer Node access",
);
assert.match(desktopSource, /sandbox:\s*true/u, "desktop must sandbox the renderer");

console.log(
  "Architecture invariants passed for five runnable apps, reserved marketing, and six packages.",
);
