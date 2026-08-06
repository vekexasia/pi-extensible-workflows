import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    ignores: ["**/dist/**", "eslint.config.js", "scripts/check-docs.mjs", "**/examples/**/*.js", "**/examples/**/*.mjs", "packages/core/test/workspace-layout.test.mjs"],
  },
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: { "@typescript-eslint/require-await": "off" },
  },
  {
    files: ["packages/extensions/herdr/**/*.js", "packages/extensions/herdr/**/*.mjs", "packages/extensions/subagents/**/*.js", "packages/extensions/subagents/**/*.mjs", "packages/extensions/widget/**/*.js", "packages/extensions/widget/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: { project: false, projectService: false },
      globals: { process: "readonly", AbortController: "readonly" },
    },
  },
);