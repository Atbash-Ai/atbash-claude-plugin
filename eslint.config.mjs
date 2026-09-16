import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-tests/**",
      "**/runtime/**",
      "**/node_modules/**",
      "**/coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // The shipped hook entry point is plain CommonJS on purpose: it must load with no bundler and
    // no dependencies so it can still deny when the bundled hook next to it cannot load.
    files: ["plugins/atbash/src/hook/shim.cjs"],
    languageOptions: {
      globals: { process: "readonly", require: "readonly", setTimeout: "readonly" },
      sourceType: "commonjs",
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
