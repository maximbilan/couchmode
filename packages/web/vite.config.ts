import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * Two entry points: /tv (10-foot D-pad UI) and /phone (keyboard + approvals).
 * The bridge serves the built output and maps /tv -> tv.html, /phone -> phone.html.
 */
export default defineConfig({
  appType: "mpa",
  build: {
    target: "es2020",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        tv: resolve(import.meta.dirname, "tv.html"),
        phone: resolve(import.meta.dirname, "phone.html"),
      },
    },
  },
  server: {
    host: true,
  },
});
