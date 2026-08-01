import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: "src/preload.ts",
      formats: ["cjs"],
    },
    outDir: "dist-electron",
    rollupOptions: {
      external: ["electron"],
      output: { entryFileNames: "preload.cjs" },
    },
  },
});
