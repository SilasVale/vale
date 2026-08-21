# Workflow: Tooling Setup — TypeScript Strict + ESLint + Prettier

**Trigger:** Manual (user initiates)
**Checkpoint:** Yes — after each sub-step, verify the tree is green before moving on.
**Push right:** Yes — do all config work, then present a single summary for user to approve.

## Objective

Set up a modern, strict TypeScript + ESLint + Prettier toolchain for the `gateway/` subproject. This is the foundation for all subsequent architecture work.

## Scope

Only `gateway/` for now. The `agent/` (Rust) and `index/` (Cloudflare Worker) subprojects have their own tooling.

## Steps

### Step 1: TypeScript strict mode

1. In `gateway/`, create/update `tsconfig.json`:
   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "ESNext",
       "moduleResolution": "bundler",
       "strict": true,
       "noUncheckedIndexedAccess": true,
       "noUnusedLocals": true,
       "noUnusedParameters": true,
       "exactOptionalPropertyTypes": false,
       "skipLibCheck": true,
       "esModuleInterop": true,
       "forceConsistentCasingInFileNames": true,
       "resolveJsonModule": true,
       "isolatedModules": true,
       "declaration": true,
       "declarationMap": true,
       "sourceMap": true,
       "outDir": "dist",
       "rootDir": "src",
       "types": ["@cloudflare/workers-types"]
     },
     "include": ["src/**/*.ts"],
     "exclude": ["node_modules", "dist", "test"]
   }
   ```

2. Add `typescript` as a devDependency in `gateway/package.json` (already present — verify version is ≥5.4).

3. Run `npx tsc --noEmit` and fix ALL type errors. The existing code has `any` types, missing return types, and loose patterns. Fix them all — this is the "ultracode" standard.

4. Key fixes expected:
   - `http.ts`: `jsonOk` and `jsonError` `data` parameter should be `unknown`, not `any`.
   - `auth.ts`: Already well-typed — verify no strict-mode issues.
   - `plugins/registry.ts`: The `PluginRoute.handler` is `(...args: any[]) => any` — narrow this.
   - All `.js` re-export files (`channels.js`, `body-scan.js`, `plugin-hub.js`) should be deleted or converted to `.ts` barrel files.

### Step 2: ESLint

1. Install dependencies in `gateway/`:
   ```bash
   npm install -D eslint @eslint/js typescript-eslint eslint-plugin-unused-imports eslint-config-prettier
   ```

2. Create `gateway/eslint.config.js` (flat config format):
   ```js
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
         "@typescript-eslint/no-explicit-any": "warn",
         "@typescript-eslint/explicit-function-return-type": "off",
         "@typescript-eslint/no-unused-vars": "off", // handled by unused-imports
       },
     },
     { ignores: ["dist/", "node_modules/", "test/"] }
   );
   ```

3. Add to `gateway/package.json` scripts:
   ```json
   { "lint": "eslint src/", "lint:fix": "eslint src/ --fix" }
   ```

4. Run `npm run lint` and fix all errors.

### Step 3: Prettier

1. Install in `gateway/`:
   ```bash
   npm install -D prettier
   ```

2. Create `gateway/.prettierrc`:
   ```json
   {
     "semi": true,
     "singleQuote": false,
     "trailingComma": "all",
     "printWidth": 100,
     "tabWidth": 2,
     "arrowParens": "always"
   }
   ```

3. Create `gateway/.prettierignore`:
   ```
   dist/
   node_modules/
   test/
   *.js
   ```

4. Add to `gateway/package.json` scripts:
   ```json
   { "format": "prettier --write src/", "format:check": "prettier --check src/" }
   ```

5. Run `npm run format` on all `src/**/*.ts` files.

### Step 4: Verify

1. Run `npx tsc --noEmit` — must pass with zero errors.
2. Run `npm run lint` — must pass with zero errors.
3. Run `npm run format:check` — must pass.
4. Each commit leaves the tree green.

## Commit strategy

- `chore(gateway): add tsconfig.json with strict mode`
- `fix(gateway): resolve all strict-mode type errors`
- `chore(gateway): add eslint with typescript-eslint + unused-imports`
- `fix(gateway): resolve all lint errors`
- `chore(gateway): add prettier with consistent config`
- `style(gateway): format all source files with prettier`

## Done criteria

An implementer can build this without asking a question. The gateway `src/` directory compiles under strict TypeScript, lints clean, and formats consistently.
