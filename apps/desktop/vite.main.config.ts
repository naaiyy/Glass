import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "dist-electron",
    rollupOptions: {
      external: ["electron", "node:path"],
      output: { entryFileNames: "main.cjs", format: "cjs" },
    },
    ssr: "src/main.ts",
  },
  ssr: { noExternal: ["@better-auth/electron", "better-auth", "conf"] },
});
