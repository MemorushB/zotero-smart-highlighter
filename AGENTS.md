# AGENTS.md

## Repository overview and scope

- This repository is the `zotero-smart-highlighter` project and ships the Zotero 8 plugin branded as `Zotero Smart Highlighter`.
- The plugin adds named-entity-based PDF highlighting on top of Zotero's reader UI.
- Root plugin code lives in `src/` and is authored in strict TypeScript.
- Packaged plugin assets live in `addon/`, including bootstrap glue, manifest, locale files, and preferences assets.
- The scaffold config builds from `src/` and `addon/` into `.scaffold/build/`.
- The plugin bundle entry configured for scaffold builds is `src/index.ts`.
- `src/index.ts` re-exports the bootstrap lifecycle from `src/bootstrap.ts`.
- `build.js` is a separate legacy path that bundles from `src/bootstrap.ts`.
- The main integration points in current source are:
  - preference pane registration through `Zotero.PreferencePanes.register`
  - reader popup integration through `renderTextSelectionPopup`
  - reader toolbar integration through `renderToolbar`
- An optional local `zotero/` checkout may exist for upstream reference work, with its own build, lint, test, and style rules.
- Treat root plugin work and any local `zotero/` checkout as separate environments.

## Setup and environment

- Follow `README.md` for local setup; do not invent an alternative bootstrap flow.
- Install dependencies with `npm install` at the repository root.
- Create local config with `cp .env.example .env`.
- Required env var: `ZOTERO_PLUGIN_ZOTERO_BIN_PATH`.
- Optional env vars: `ZOTERO_PLUGIN_PROFILE_PATH` and `ZOTERO_PLUGIN_DATA_DIR`.
- `.env.example` documents a macOS executable-path example and notes that profile/data paths are local-development inputs.
- Start the scaffold dev workflow with `npm start` after `.env` is configured.
- `npm start` maps to `zotero-plugin serve`.
- `README.md` states that `npm start` watches `src/**` and `addon/**`, rebuilds, and reloads the plugin automatically.
- The root TypeScript compiler is configured for `ES2022` target/module, `moduleResolution: node`, and `strict: true`.
- Assume generated scaffold output under `.scaffold/build/` is disposable build output unless the task explicitly says otherwise.

## Build, type-check, and release commands

- Root dev server: `npm start`
- Root build + type-check: `npm run build`
- Root legacy build path: `npm run build:legacy`
- Root release packaging: `npm run release`
- Root direct type-check only: `npx tsc --noEmit`
- Root `npm test` is not a real test command; it intentionally prints an error and exits with status 1.
- There is no root lint script in `package.json`.
- There is no visible root ESLint or Prettier config to rely on.
- The documented root build flow in `README.md` is `npm run build`, with `npm run build:legacy` kept only for compatibility.
- For root changes, prefer verification with `npm run build` and, when needed, `npx tsc --noEmit`.
- Do not claim a root lint command exists unless the changed area adds one.

## Single-test guidance

- At the plugin root, there is no supported single-test command because there is no usable root test runner.
- Do not present `npm test` as a verification step for root plugin changes.
- For root plugin work, use build/type-check verification instead of inventing test commands.
- If a change touches only `src/` or `addon/`, the safest default verification is `npm run build`.
- If you need finer-grained verification at the root, `npx tsc --noEmit` is supported; single-file TS checks are not documented here.
- Do not imply that a hidden Jest, Vitest, Mocha, or ESLint workflow exists at the root without direct evidence.
- Single-test execution is only documented for an optional local `zotero/` reference checkout, not for the plugin root.

## Root code style guidelines

- Preserve the file-local style of the file you edit.
- Root TypeScript files currently use spaces for indentation.
- Root code uses TypeScript ESM with relative imports such as `./bootstrap` and `./llm`.
- Prefer named exports in `src/`.
- `src/index.ts` is the entry re-export barrel; follow that pattern for lifecycle exports.
- Exception: `zotero-plugin.config.ts` uses a default export for scaffold config; do not generalize that to application code.
- Keep imports grouped simply and avoid introducing unused imports.
- Preserve the existing quote style and spacing pattern used by the file you touch instead of reformatting neighbors.
- Favor explicit interfaces and explicit return types where the surrounding code already uses them.
- `camelCase` is standard for functions and local variables.
- `PascalCase` is standard for interfaces and type-like constructs.
- `UPPER_SNAKE_CASE` is standard for module-level constants.
- Avoid `any` in regular logic.
- `any` is tolerated mainly at Zotero/XUL integration boundaries, for example `declare const Zotero: any` and brittle reader event internals.
- Optional chaining and nullish coalescing are common and appropriate around Zotero reader internals and other unstable APIs.
- Prefer narrow `try/catch` blocks around the exact boundary call that may fail.
- When lower-level code can give callers actionable failure detail, throw contextual `Error` instances.
- For operational diagnostics, use `Zotero.debug` rather than ad hoc console logging.
- Do not leave `console.log`, `console.error`, or debugger statements in root plugin code.
- Guard brittle platform accesses early and return fast when required data is missing.
- Keep platform-specific assumptions at the edges of the code, not inside pure helpers.

## Platform boundaries and file/layout conventions

- `src/` contains the main plugin logic.
- `addon/` contains packaged plugin assets such as bootstrap files, manifest, locale resources, and preferences assets.
- `build.js` is a legacy CommonJS build script kept for compatibility.
- `.scaffold/build/` is generated scaffold output and should not be hand-edited.
- Prefer changing source inputs under `src/` or `addon/` instead of editing generated output.
- Root lifecycle wiring belongs in `src/bootstrap.ts`; keep `src/index.ts` as the thin export surface unless the repository pattern changes.
- When touching Zotero integration code, expect loose runtime contracts from reader internals.
- Keep defensive access patterns around `_internalReader`, annotation managers, PDF.js pages, and preference pane documents.
- Preferences-related packaged assets live under `addon/` and are loaded through the plugin bootstrap/registration flow.
- If you add new files at the root, place them according to current structure rather than creating new top-level buckets casually.

## Optional local `zotero/` reference checkout guidance

- `zotero/` may be present as a separately sourced local reference checkout and is not governed by the root plugin's TypeScript conventions.
- Read `zotero/CLAUDE.md` before making substantial edits inside `zotero/`.
- `zotero/package.json` has its own build scripts, including `npm run build` and `npm run clean-build`.
- `zotero/eslint.config.mjs` exists.
- For edits inside `zotero/`, targeted linting with `cd zotero && npx eslint path/to/file.js` is valid.
- `zotero/` has its own architecture, globals, and build pipeline; do not assume root plugin patterns transfer cleanly.
- Keep `zotero/` edits minimal and isolated from root plugin edits when possible.

## Vendored `zotero/` style rules

- Use tabs, not spaces, in `zotero/` files.
- Prefer `let` over `const` except for true scalar constants.
- Follow Zotero's brace style: opening braces on the same line, but no cuddled `else` or `catch`.
- Use `--` in comments, not an em dash.
- Indent blank lines to match surrounding indentation.
- Prefer `async`/`await` for asynchronous code.
- Expect global namespaces and Mozilla/XPCOM globals such as `Zotero`, `Cc`, `Ci`, `Cu`, `Cr`, `Services`, `ChromeUtils`, `IOUtils`, and `PathUtils`.
- Do not rewrite `zotero/` code to look like the root plugin codebase.

## Vendored `zotero/` test flow

- Run all Zotero tests with `zotero/test/runtests.sh`.
- Run a single Zotero test file with `zotero/test/runtests.sh item`.
- When naming a single test file, omit both `Test` and `.js`.
- Run multiple Zotero test files with `zotero/test/runtests.sh item collections`.
- Filter by test name with `zotero/test/runtests.sh -g "pattern"`.
- Bail fast with `zotero/test/runtests.sh -f item`.
- Pass flags before test names when combining options.
- The naming convention in `zotero/test/tests/` is `<module>Test.js`; convert that to the runner form by removing `Test.js`.
- Do not claim these commands work at the plugin root; they are for `zotero/` only.

## Rules files and agent instructions present in this repository

- Root `AGENTS.md` did not previously exist; this file is now the root agent guide.
- `.cursorrules` is absent.
- `.cursor/rules/` is absent.
- `.github/copilot-instructions.md` is absent.
- `zotero/CLAUDE.md` exists and is the strongest repository-local instructions source for work inside `zotero/`.

## Agent workflow guidance

- Prefer small, focused edits that match the existing structure.
- Preserve file-local formatting, naming, and error-handling style.
- Do not invent commands, scripts, or verification steps that are not present in repository evidence.
- Distinguish clearly between root plugin commands and `zotero/` commands.
- Verify root changes with `npm run build` or `npx tsc --noEmit` unless the touched area provides a better documented command.
- Verify `zotero/` changes with the subtree's own build, lint, or `runtests.sh` flow.
- Do not hand-edit `.scaffold/build/` output.
- Prefer source edits over broad rewrites, especially around brittle Zotero reader integrations.
- If a task spans both root plugin code and `zotero/`, call out the boundary explicitly and verify each side with its own documented commands.
- When in doubt, preserve the current local convention instead of normalizing the whole repository.
