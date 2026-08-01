import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: "src/main.ts",
      formats: ["cjs"],
    },
    outDir: "dist-electron",
    rollupOptions: {
      external: ["electron", "node:path"],
      output: { entryFileNames: "main.cjs" },
    },
  },
});
