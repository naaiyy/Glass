import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const expectedWorkspaces = {
  apps: ["api", "desktop", "execution-node", "mobile", "web"],
  packages: ["client-runtime", "contracts", "domain", "execution-core", "shared", "ui-web"],
};

const rootManifest = readJson("package.json");
assert.match(
  rootManifest.scripts.dev,
  /scripts\/dev-runner\.mjs/u,
  "the default development command must launch a usable Glass application",
);
assert.match(
  rootManifest.scripts["dev:web"],
  /scripts\/dev-runner\.mjs web/u,
  "the web development command must launch the complete browser application",
);
assert.equal(
  rootManifest.scripts.dev,
  rootManifest.scripts["dev:web"],
  "the default development command must be the complete browser application",
);
assert.match(rootManifest.scripts["dev:desktop"], /scripts\/dev-runner\.mjs desktop/u);
assert.match(rootManifest.scripts["dev:mobile"], /scripts\/dev-runner\.mjs mobile/u);

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

function dependencyVersion(manifest, dependency) {
  for (const group of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    if (group?.[dependency] !== undefined) return group[dependency];
  }
  return undefined;
}

const workspaceConfig = read("pnpm-workspace.yaml");
assert.match(workspaceConfig, /(?:^|\n)\s*-\s*["']?apps\/\*["']?\s*(?:\n|$)/u);
assert.match(workspaceConfig, /(?:^|\n)\s*-\s*["']?packages\/\*["']?\s*(?:\n|$)/u);
for (const packageName of ["core", "native", "react", "ui"]) {
  assert.match(
    workspaceConfig,
    new RegExp(`["']?@openeditor/${packageName}["']?: 0\\.0\\.35(?:\\n|$)`, "u"),
    `@openeditor/${packageName} must stay on the coordinated public 0.0.35 release`,
  );
}
assert.doesNotMatch(
  workspaceConfig,
  /@openeditor\/[^:\n]+:\s*(?:file:|link:|workspace:)/u,
  "OpenEditor dependencies must not rely on a developer-machine checkout",
);

for (const [kind, expectedNames] of Object.entries(expectedWorkspaces)) {
  const directory = join(root, kind);
  assert.ok(existsSync(directory), `Missing ${kind}/ workspace directory`);

  const actualNames = readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(directory, entry.name, "package.json")),
    )
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(
    actualNames,
    expectedNames,
    `${kind}/ must contain the ${expectedNames.length} locked workspaces`,
  );

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
assert.match(
  apiManifest.scripts.build,
  /wrangler\s+deploy\s+--dry-run/u,
  "apps/api build must exercise Cloudflare's real Worker bundler",
);
assert.match(
  apiManifest.scripts.build,
  /smoke-built-worker\.mjs/u,
  "apps/api build must smoke-check the generated Worker module",
);
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
assert.ok(
  apiDependencies.has("@openeditor/core"),
  "apps/api must validate persisted note payloads with the public OpenEditor contract",
);
assert.equal(dependencyVersion(apiManifest, "@openeditor/core"), "catalog:");

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
for (const editorDependency of ["@openeditor/core", "@openeditor/native", "react-native-webview"]) {
  assert.ok(
    mobileDependencies.has(editorDependency),
    `mobile must use the supported OpenEditor native surface (${editorDependency} is missing)`,
  );
}
for (const editorDependency of ["@openeditor/core", "@openeditor/native"]) {
  assert.equal(
    dependencyVersion(mobileManifest, editorDependency),
    "catalog:",
    `mobile must resolve ${editorDependency} through the locked workspace catalog`,
  );
}
assert.doesNotMatch(
  sourceText("apps/mobile"),
  /(?:from|require\(|import\s*\()["']expo-router(?:\/[^"']*)?["']/u,
  "mobile must use React Navigation, not Expo Router",
);

const mobileAppRoot = read("apps/mobile/src/App.tsx");
assert.ok(
  mobileAppRoot.trim().split("\n").length <= 20,
  "the mobile App module must remain a composition root instead of accumulating features",
);
assert.match(mobileAppRoot, /ProductCloudProvider/u);
assert.match(mobileAppRoot, /RootNavigator/u);
assert.doesNotMatch(
  mobileAppRoot,
  /(?:client-runtime|\.\/cloud\/|react-native|react-navigation|OpenEditor)/u,
  "the mobile composition root must not own transport, screens, or platform behavior",
);

const mobileNavigationSource = sourceText("apps/mobile/src/navigation");
assert.doesNotMatch(
  mobileNavigationSource,
  /(?:client-runtime|\.\.\/cloud\/|\.\.\/execution\/|OpenEditor)/u,
  "mobile navigation must not own product, execution, or editor runtimes",
);
assert.doesNotMatch(
  read("apps/mobile/src/navigation/routes.ts"),
  /organizationId/u,
  "mobile routes must not expose opening an organization by ID",
);

const mobileProductCloud = read("apps/mobile/src/product-cloud/ProductCloudProvider.tsx");
for (const requiredRuntime of [
  "createOutboxEngine",
  "createSyncEngine",
  "ProductCloudStateContext",
]) {
  assert.match(
    mobileProductCloud,
    new RegExp(`\\b${requiredRuntime}\\b`, "u"),
    `the persistent mobile product-cloud provider must own ${requiredRuntime}`,
  );
}
assert.doesNotMatch(
  mobileProductCloud,
  /@react-navigation/u,
  "the mobile product-cloud runtime must not depend on navigation",
);

const mobileScreenSource = sourceText("apps/mobile/src/screens");
assert.doesNotMatch(
  mobileScreenSource,
  /(?:createOutboxEngine|createSyncEngine|GlassConnectClient)/u,
  "mobile route screens must consume feature runtimes instead of constructing them",
);

const mobileExecutionSource = sourceText("apps/mobile/src/execution");
assert.doesNotMatch(
  mobileExecutionSource,
  /(?:createOutboxEngine|createSyncEngine|loadProductSnapshot)/u,
  "mobile execution features must not own cloud product synchronization",
);

const contractsManifest = readJson("packages/contracts/package.json");
assert.ok(
  dependencyNames(contractsManifest).has("@openeditor/core"),
  "wire contracts must consume the OpenEditor document type instead of recreating it",
);
assert.equal(dependencyVersion(contractsManifest, "@openeditor/core"), "catalog:");

const webManifest = readJson("apps/web/package.json");
const webDependencies = dependencyNames(webManifest);
for (const editorDependency of ["@openeditor/core", "@openeditor/react", "@openeditor/ui"]) {
  assert.ok(
    webDependencies.has(editorDependency),
    `web must use the supported OpenEditor surface (${editorDependency} is missing)`,
  );
}
for (const editorDependency of ["@openeditor/core", "@openeditor/react", "@openeditor/ui"]) {
  assert.equal(
    dependencyVersion(webManifest, editorDependency),
    "catalog:",
    `web must resolve ${editorDependency} through the locked workspace catalog`,
  );
}

const productStorageDefinitions = [
  read("apps/api/src/db/schema.ts"),
  ...filesBelow("infra/cloud/migrations/postgres")
    .filter((file) => file.endsWith(".sql"))
    .map(read),
].join("\n");
for (const forbiddenTable of [
  "documents",
  "document_revisions",
  "document_versions",
  "document_updates",
  "document_changes",
  "document_blocks",
  "document_operations",
  "document_presence",
  "document_cursors",
  "note_revisions",
  "note_versions",
  "note_updates",
  "note_changes",
  "note_blocks",
  "note_operations",
  "note_presence",
  "note_cursors",
  "editor_documents",
  "editor_revisions",
  "editor_versions",
  "editor_updates",
  "editor_changes",
  "editor_blocks",
  "editor_operations",
  "editor_presence",
  "editor_cursors",
  "content_revisions",
  "content_versions",
  "content_updates",
  "content_changes",
  "content_blocks",
]) {
  assert.doesNotMatch(
    productStorageDefinitions,
    new RegExp(
      `(?:pgTable\\(\\s*["']|CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["']?)${forbiddenTable}(?:["']|\\b)`,
      "iu",
    ),
    `Glass must not introduce a bespoke ${forbiddenTable} editor table`,
  );
}

assert.match(
  read("apps/api/src/db/schema.ts"),
  /pgTable\(\s*["']note_contents["']/u,
  "Glass must persist the current native OpenEditor payload through the dedicated note adapter",
);
assert.match(
  read("packages/contracts/src/notes.ts"),
  /parseOpenEditorDocument/u,
  "the note adapter must validate payloads through OpenEditor's public parser",
);

for (const forbiddenOperation of [
  "document.create",
  "document.update",
  "document.delete",
  "document.patch",
  "document.merge",
  "document.sync",
  "content.create",
  "content.update",
  "content.delete",
  "content.patch",
  "content.merge",
  "content.sync",
  "editor.change",
  "editor.update",
  "editor.sync",
]) {
  assert.doesNotMatch(
    [sourceText("apps"), sourceText("packages")].join("\n"),
    new RegExp(`["']${forbiddenOperation.replace(".", "\\.")}["']`, "u"),
    `Glass product synchronization must not define ${forbiddenOperation}`,
  );
}
assert.doesNotMatch(
  sourceText("packages/client-runtime/src"),
  /(?:from|import\s*)\s*\(?["']@openeditor\//u,
  "the Glass product sync runtime must not become an OpenEditor content runtime",
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

const ciWorkflow = read(".github/workflows/ci.yml");
assert.match(
  ciWorkflow,
  /vp run --filter @glass\/desktop ensure:electron/u,
  "CI must validate the Electron runtime before building desktop outputs",
);
assert.match(
  ciWorkflow,
  /vp run --filter @glass\/api db:migrations[\s\S]*git diff --exit-code -- infra\/cloud\/migrations\/postgres/u,
  "CI must reject drift between the durable schema and committed migrations",
);
assert.match(
  ciWorkflow,
  /test -f apps\/desktop\/dist-electron\/preload\.cjs/u,
  "CI must verify the generated preload bundle",
);
assert.match(
  ciWorkflow,
  /grep -nE ["']glassDesktop\|executionConnection\|platform["']/u,
  "CI must verify the required preload bridge symbols",
);
assert.doesNotMatch(
  ciWorkflow,
  /(?:xvfb|smoke-test)/iu,
  "Linux CI must verify desktop artifacts without launching the Electron GUI",
);

console.log(
  "Architecture invariants passed for five runnable apps, reserved marketing, and six packages.",
);
