import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    ignores: ["**/dist/**", "eslint.config.js", "scripts/check-docs.mjs", "**/examples/**/*.js", "**/examples/**/*.mjs", "packages/core/test/workspace-layout.test.mjs", "packages/core/trajectory/src/assets/marked.min.js", "packages/core/trajectory/src/assets/morphdom.min.js", "packages/core/trajectory/src/assets/prism.min.js", "packages/core/trajectory/src/assets/semantic-map.js"],
  },
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: { "@typescript-eslint/require-await": "off" },
  },
  {
    files: ["scripts/**/*.mjs", "packages/core/bench/**/*.mjs", "packages/core/test/**/*.mjs", "packages/core/subagents/**/*.mjs", "packages/extensions/herdr/**/*.js", "packages/extensions/herdr/**/*.mjs", "packages/core/trajectory/test/fixtures/semantic-map-feasibility/live-profile.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: { project: false, projectService: false },
      globals: { process: "readonly", AbortController: "readonly" },
    },
  },
  {
    files: ["packages/core/trajectory/test/fixtures/semantic-map-feasibility/live-profile.js"],
    languageOptions: {
      globals: { Archify: "readonly", document: "readonly", Event: "readonly", getComputedStyle: "readonly", location: "readonly", parent: "readonly", self: "readonly", window: "readonly" },
    },
    // Pinned d341dbf feasibility bytes (see PROVENANCE.md); keep them unchanged instead of rewriting duplicate declarations.
    rules: { "no-dupe-keys": "off", "no-redeclare": "off" },
  },
  {
    files: ["packages/core/bench/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", performance: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", fetch: "readonly", WebSocket: "readonly", Buffer: "readonly" },
    },
  },
);