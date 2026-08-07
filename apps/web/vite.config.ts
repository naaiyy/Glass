import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite-plus";

const cloudOrigin = process.env.GLASS_CLOUD_ORIGIN?.trim();
const webPort = Number(process.env.GLASS_DEV_WEB_PORT ?? "5173");
const developmentOrigin = `http://127.0.0.1:${webPort}`;
const proxy =
  cloudOrigin === undefined || cloudOrigin === ""
    ? undefined
    : Object.fromEntries(
        ["/api", "/health", "/v1"].map((path) => [
          path,
          {
            target: new URL(cloudOrigin).origin,
            changeOrigin: true,
            ...(path === "/api"
              ? { headers: { "x-glass-development-origin": developmentOrigin } }
              : {}),
            secure: new URL(cloudOrigin).protocol === "https:",
            xfwd: false,
          },
        ]),
      );

export default defineConfig({
  base: "./",
  plugins: [
    tanstackRouter({ quoteStyle: "double", semicolons: true }),
    react(),
    babel({
      parserOpts: { plugins: ["typescript", "jsx"] },
      presets: [reactCompilerPreset()],
    }),
    tailwindcss(),
  ],
  resolve: {
    dedupe: ["react", "react-dom"],
    tsconfigPaths: true,
  },
  server: {
    host: "127.0.0.1",
    open: process.env.GLASS_DEV_OPEN_BROWSER === "1",
    port: webPort,
    strictPort: true,
    ...(proxy === undefined ? {} : { proxy }),
  },
});
