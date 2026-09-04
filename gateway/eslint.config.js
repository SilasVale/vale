import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import unusedImports from "eslint-plugin-unused-imports";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    plugins: { "unused-imports": unusedImports },
    rules: {
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // ui/*.mjs smoke scripts run under node + jsdom (see each file's header):
    // node runtime globals plus the DOM/whatwg names the jsdom harness
    // provides. Enumerated here so `eslint .` covers them without new deps.
    files: ["ui/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        fetch: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        navigator: "readonly",
        location: "readonly",
      },
    },
  },
  {
    // public/ is all generated/served content: vite build output (assets/),
    // the Source Viewer's src mirrors (code/), and installer payloads —
    // nothing hand-written to lint. ui/*.mjs smoke scripts ARE linted (see
    // the globals block above).
    ignores: ["dist/", "node_modules/", "test/", "public/"],
  }
);
