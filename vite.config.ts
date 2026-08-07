import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    fileParallelism: false,
    alias: {
      "cloudflare:workers": new URL("./apps/api/test/cloudflare-workers.mock.ts", import.meta.url)
        .pathname,
    },
    environment: "node",
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-electron/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
  staged: {
    "*": "vp fmt",
  },
  fmt: {
    ignorePatterns: [
      ".expo/**",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/web/src/routeTree.gen.ts",
    ],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: [
      ".expo/**",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/web/src/routeTree.gen.ts",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "react-in-jsx-scope": "off",
      "typescript/no-floating-promises": "off",
      "unicorn/consistent-function-scoping": "off",
      "unicorn/no-array-sort": "off",
    },
    options: {
      typeAware: false,
      typeCheck: false,
    },
  },
});
