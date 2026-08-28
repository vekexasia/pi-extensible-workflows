import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    ignores: ["**/dist/**", "eslint.config.js", "scripts/check-docs.mjs", "**/examples/**/*.js", "**/examples/**/*.mjs", "packages/core/test/workspace-layout.test.mjs", "packages/core/trajectory/src/assets/marked.min.js", "packages/core/trajectory/src/assets/morphdom.min.js"],
  },
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: { "@typescript-eslint/require-await": "off" },
  },
  {
    files: ["scripts/**/*.mjs", "packages/core/test/**/*.mjs", "packages/core/subagents/**/*.mjs", "packages/extensions/herdr/**/*.js", "packages/extensions/herdr/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: { project: false, projectService: false },
      globals: { process: "readonly", AbortController: "readonly" },
    },
  },
);