// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Node and browser globals, spelled out rather than pulling in the `globals`
 * package for a handful of names.
 */
const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  ReadableStream: "readonly",
  WritableStream: "readonly",
  TransformStream: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  queueMicrotask: "readonly",
  fetch: "readonly",
  WebSocket: "readonly",
};

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "apps/**", "**/*.d.ts", "**/.tv-check/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // TypeScript resolves identifiers itself; `no-undef` only produces false
    // positives on type-only and ambient names.
    files: ["**/*.ts"],
    rules: { "no-undef": "off" },
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: { globals: nodeGlobals },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
