# Zotero Plugin Template Adaptation Plan

## Objective / Recommended Migration Strategy

Adapt this repository toward the `zotero-plugin-template` structure without replacing the working plugin logic. The recommended strategy is an incremental migration: keep scaffold as the operational baseline, preserve the existing Reader/LLM/highlighting behavior, refactor the runtime skeleton around it, and only remove legacy pieces after scaffold-only behavior is stable.

Recommended sequence:

1. Align metadata, runtime entry structure, and state container with template conventions.
2. Split the current `src/bootstrap.ts` monolith into template-shaped modules while preserving behavior.
3. Add lint, test, typings, and CI scaffolding.
4. Remove or retire legacy build artifacts only after the scaffold path is stable and validated.

This should not be treated as a greenfield rewrite. The core highlight logic is already functional and should be preserved, not rewritten from scratch.

## Pinned Reference Baseline

To avoid migration drift, freeze both the structural reference and the operational baseline for this plan:

- Structural reference: the in-repo `zotero-plugin-template/` snapshot, corresponding to template package version `3.1.0`
- Operational baseline: the migration is pinned to the root `package-lock.json` resolved scaffold version `0.8.3`; the root `package.json` dependency declaration remains `zotero-plugin-scaffold` `^0.8.3`, but that semver range is not itself the frozen baseline

Do not adopt newer upstream template or scaffold changes in the middle of this migration. If the team wants to update the reference template snapshot or move to a newer scaffold line, that should happen in a separate update pass with its own review and validation cycle.

## Current Codebase Status

### Build System and Scripts

- Main flow already uses scaffold.
- `npm start` -> `zotero-plugin serve`
- `npm run build` -> `zotero-plugin build && tsc --noEmit`
- `npm run build:legacy` -> `node build.js`
- `npm run release` -> `zotero-plugin release`
- `npm test` is only a stub that exits with failure; there is no real root test flow.
- `zotero-plugin.config.ts` already uses `defineConfig(...)`, but it is still customized rather than fully template-native.
- Root `package.json` already contains template-style addon metadata keys under `config`: `addonName`, `addonID`, `addonRef`, `addonInstance`, and `prefsPrefix`.
- The repository currently has no real root lint/test/CI flow.

### Current Source Layout

- Runtime entry: `src/index.ts`
- Main implementation: `src/bootstrap.ts`
- API client/service logic: `src/llm.ts`
- Highlight geometry helper: `src/rect-splitter.ts`
- Entity color helper: `src/entity-colors.ts`

Current status by file:

- `src/bootstrap.ts` is the main monolithic file. It currently handles lifecycle wiring, preference pane registration, Reader popup integration, Reader toolbar integration, entity extraction flow, PDF geometry/highlight logic, and annotation fallback behavior.
- `src/llm.ts` already encapsulates the OpenAI-compatible NER API logic, retry handling, JSON cleanup, and offset repair.
- `src/rect-splitter.ts` and `src/entity-colors.ts` are already reusable helpers and should mostly be preserved.

### Already-Implemented Features

- Preference pane registration via `Zotero.PreferencePanes.register`
- Reader text-selection popup integration via `renderTextSelectionPopup`
- Reader toolbar integration via `renderToolbar`
- Named-entity extraction through an OpenAI-compatible chat completion endpoint
- Highlight generation from extracted entity spans
- Annotation fallback behavior when the preferred annotation path fails

### Runtime / Package Assets

- Packaged runtime assets:
  - `addon/bootstrap.js`
  - `addon/manifest.json`
  - `addon/prefs.js`
  - `addon/content/preferences.xhtml`
  - `addon/content/preferences.js`
  - `addon/locale/**`
- Existing preferences already cover:
  - `apiKey`
  - `baseURL`
  - `model`
  - `systemPrompt`

### Generated / Disposable Artifacts

- `.scaffold/` is generated build output, not a source-of-truth directory, and should remain ignored/disposable.
- `addon/content/scripts/**` is generated/disposable output, not a source-of-truth location, and should remain ignored.
- `zotero-pdf-highlighter.xpi` and any other `*.xpi` files are package artifacts, not hand-maintained source files, and should remain ignored/disposable.
- If any generated outputs are currently tracked, remove them only in the final cleanup phase rather than during the earlier runtime refactor phases.
- `zotero/` is a vendored upstream subtree and should not be mixed into the plugin migration plan except where boundaries must be documented.
- `zotero-plugin-template/` is a local template snapshot that should be used as a reference, not copied wholesale into the live plugin.

## Target Template Shape

### What `zotero-plugin-template` Expects Structurally

The template structure to align with is roughly:

- `src/index.ts`
- `src/addon.ts`
- `src/hooks.ts`
- `src/modules/*`
- `src/utils/*`
- `test/`
- `typings/`
- `addon/`
- `.github/workflows/*`

The template also expects:

- hook-based bootstrap dispatch rather than a single large bootstrap file
- a central addon instance/state container
- clearer separation between lifecycle hooks, UI registration, service logic, and utilities
- lint/test/CI support in the root project

### What Already Aligns

- The repo already uses scaffold as the main build and release path.
- `src/index.ts` already exists as the bundle entry.
- `addon/` already exists as the packaged asset root.
- `package.json` already carries addon metadata keys similar to the template.
- `src/llm.ts`, `src/rect-splitter.ts`, and `src/entity-colors.ts` already look like reusable service/utility modules.

### What Does Not Yet Align

- There is no `src/addon.ts` central addon/state container.
- There is no `src/hooks.ts` dispatcher layer.
- `src/bootstrap.ts` still mixes lifecycle, UI registration, service orchestration, and geometry/highlight fallback logic in one file.
- There is no `src/modules/` layout for Reader integration, preferences, or annotation workflows.
- There is no root `test/` directory for plugin tests.
- There is no root `typings/` directory aligned to template conventions.
- There is no root lint/test/CI setup comparable to the template.
- The scaffold config is working, but not yet normalized to a template-native project skeleton.

## Gap Analysis

1. **Bootstrap architecture gap**
   - Current runtime behavior is centered in `src/bootstrap.ts`.
   - Template structure expects dispatch through `src/index.ts` -> `src/addon.ts` -> `src/hooks.ts` plus narrower modules.

2. **State ownership gap**
   - Current plugin state is mostly implicit and file-local.
   - Template structure expects a central addon instance/state container.

3. **Module boundary gap**
   - Reader UI integration, preference handling, highlight creation, fallback logic, and lifecycle code are tightly coupled.
   - These should be split into modules with smaller, testable responsibilities.

4. **Tooling gap**
   - The project lacks real root lint, test, typings, and CI support.
   - The template provides these as part of the maintainable baseline.

5. **Legacy coexistence gap**
   - `build.js` still exists as a compatibility path.
   - It should remain during the migration window, but it should not continue to shape the target architecture.

## Phased Migration Plan

### Phase 0 - Freeze the Baseline

Goal: establish the current scaffold-based plugin as the lockfile-pinned baseline to preserve.

- Keep scaffold pinned to the lockfile-resolved execution baseline `0.8.3` for this migration.
- Keep `build:legacy` available during migration.
- Treat current Reader selection popup, Reader toolbar behavior, preference pane load/save, and annotation fallback behavior as regression-sensitive flows.
- Record the existing preference keys and packaged asset paths as compatibility constraints.

Exit checkpoint:

- `npm run build` passes.
- Manual smoke checks confirm preference pane load/save, `renderTextSelectionPopup`, `renderToolbar`, and fallback highlight creation still work in Zotero.

### Phase 1 - Align the Runtime Skeleton

Goal: introduce template-shaped runtime files without changing the core highlighting behavior.

- Add `src/addon.ts` as the central addon instance/state container.
- Add `src/hooks.ts` as the lifecycle dispatcher.
- Reduce `src/index.ts` to the expected template-style bootstrap entry.
- Move only lifecycle coordination and shared plugin state first; keep the current highlight logic callable as-is.
- Keep `src/bootstrap.ts` temporarily as an adapter layer if needed rather than forcing an immediate full split.

Exit checkpoint:

- Plugin still builds through scaffold.
- Startup/shutdown behavior is explicitly validated.
- Preference pane load/save is explicitly validated.
- `renderTextSelectionPopup` is explicitly validated.
- `renderToolbar` is explicitly validated.
- Annotation fallback behavior is explicitly validated.
- No Phase 1 work proceeds until all of the above runtime paths are confirmed stable.

### Phase 2 - Split `src/bootstrap.ts` by Responsibility

Goal: remove the monolithic structure while preserving working behavior.

Recommended split direction:

- `src/modules/preferences.ts` for preference defaults, pane registration, and preferences lifecycle glue
- `src/modules/reader-popup.ts` for `renderTextSelectionPopup`
- `src/modules/reader-toolbar.ts` for `renderToolbar`
- `src/modules/highlight-service.ts` for entity-to-highlight orchestration
- `src/modules/annotation-fallback.ts` for alternate annotation save paths and failure handling
- `src/modules/pdf-selection.ts` or similar for text/rect matching and selection normalization helpers

Preserve with minimal adaptation:

- `src/llm.ts`
- `src/rect-splitter.ts`
- `src/entity-colors.ts`

Exit checkpoint:

- Startup/shutdown still behave correctly after the split.
- Preference pane load/save, `renderTextSelectionPopup`, `renderToolbar`, and annotation fallback still behave the same after the split.
- Highlight placement correctness is explicitly re-validated after the split.
- `src/bootstrap.ts` is either removed or reduced to a thin compatibility adapter.

### Phase 3 - Normalize Template-Like Project Support Files

Goal: add the missing maintainability pieces that the template includes.

- Add `typings/` only for missing project-specific globals/types.
- Add `test/` with at least a startup/plugin-instance smoke test first.
- Add root lint scripts and config aligned with scaffold/template conventions.
- Add `.github/workflows/*` for build/test/release automation.

Exit checkpoint:

- The repo has a minimal but real lint/test/CI baseline.
- Smoke coverage explicitly exercises startup, preference pane load/save, `renderTextSelectionPopup`, `renderToolbar`, and annotation fallback behavior.
- The project no longer depends on manual structure knowledge to stay maintainable.

### Phase 4 - Retire Legacy Build Coupling

Goal: make scaffold-only structure the authoritative path after validation.

- Confirm release packaging and local development no longer depend on `build.js`.
- Remove legacy build flow only after scaffold-only behavior is stable across development, build, and release tasks.
- Keep generated bundle/package outputs such as `.scaffold/`, `addon/content/scripts/**`, and `*.xpi` treated as ignored, non-authoritative artifacts.
- Remove tracked generated outputs, if any, only during this final cleanup phase.
- Remove obsolete adapter code or duplicated runtime glue introduced during migration.

Exit checkpoint:

- Scaffold is the only required runtime/build path.
- Scaffold-only development, build, and release validation is complete before removing `build.js` and `npm run build:legacy`.
- Legacy artifacts are removed intentionally rather than prematurely.

## File-by-File Mapping / Refactor Targets

| Current file/path | Target template location | Action |
| --- | --- | --- |
| `src/index.ts` | `src/index.ts` | Keep as entry point, but adapt to template-style addon/bootstrap initialization. |
| `src/bootstrap.ts` | `src/hooks.ts` + `src/modules/*` | Split incrementally; do not rewrite highlight logic from scratch. Use an adapter phase if needed. |
| `src/llm.ts` | `src/modules/llm.ts` or `src/utils/llm.ts` | Keep mostly intact; relocate only if needed for clearer template alignment. |
| `src/rect-splitter.ts` | `src/utils/rect-splitter.ts` | Keep with minimal adaptation. |
| `src/entity-colors.ts` | `src/utils/entity-colors.ts` | Keep with minimal adaptation. |
| _(none today)_ | `src/addon.ts` | Add central addon instance/state container. |
| preference logic inside `src/bootstrap.ts` | `src/modules/preferences.ts` | Extract preference defaults, pane registration, and prefs event handling. |
| Reader popup logic inside `src/bootstrap.ts` | `src/modules/reader-popup.ts` | Extract `renderTextSelectionPopup` integration and UI feedback wiring. |
| Reader toolbar logic inside `src/bootstrap.ts` | `src/modules/reader-toolbar.ts` | Extract `renderToolbar` integration. |
| highlight orchestration inside `src/bootstrap.ts` | `src/modules/highlight-service.ts` | Extract entity extraction -> rect calculation -> annotation creation workflow. |
| annotation fallback logic inside `src/bootstrap.ts` | `src/modules/annotation-fallback.ts` | Extract fallback save paths and failure handling. |
| selection/text matching helpers inside `src/bootstrap.ts` | `src/modules/pdf-selection.ts` or `src/utils/pdf-selection.ts` | Extract normalization, offset mapping, and rect matching helpers. |
| `addon/bootstrap.js` | `addon/bootstrap.js` | Keep unless scaffold/template alignment provides a safer replacement path; do not churn early. |
| `addon/manifest.json` | `addon/manifest.json` | Keep, then normalize only where template conventions improve maintainability. |
| `addon/prefs.js` | `addon/prefs.js` | Keep, but align with hook-based prefs event flow as runtime structure matures. |
| `addon/content/preferences.xhtml` | `addon/content/preferences.xhtml` | Keep existing UI; only refactor if needed to support cleaner prefs wiring. |
| `addon/content/preferences.js` | `addon/content/preferences.js` or `src/modules/preferenceScript.ts` equivalent | Evaluate whether to keep packaged script or replace with a template-style module-backed preference script. |
| `addon/locale/**` | `addon/locale/**` | Keep; template alignment should preserve locale assets rather than recreate them. |
| `zotero-plugin.config.ts` | `zotero-plugin.config.ts` | Keep scaffold-based config, then simplify toward template conventions after runtime structure is stable. |
| `package.json` | `package.json` | Preserve scaffold scripts and metadata; keep the declared dependency as `zotero-plugin-scaffold` `^0.8.3`, while treating the lockfile-resolved `0.8.3` as the frozen migration baseline. |
| _(none today)_ | `test/startup.test.ts` | Add first smoke test modeled on template expectations. |
| _(none today)_ | `typings/*` | Add only the globals/types actually needed by the refactored structure. |
| _(none today)_ | `.github/workflows/*` | Add CI/release automation after project structure settles. |
| `build.js` | remove in final phase | Keep during migration; delete only after scaffold-only behavior is validated. |

## Risks and Validation Checkpoints

### High-Risk Integration Points

These should be treated as the main regression risks throughout the migration:

- preference pane load/save behavior
- `renderTextSelectionPopup`
- `renderToolbar`
- annotation fallback behavior

These are the places where the plugin most directly depends on Zotero runtime details and brittle Reader internals.

### Validation Checkpoints by Phase

- After Phase 1: scaffold build passes, and startup/shutdown, preference pane load/save, `renderTextSelectionPopup`, `renderToolbar`, and annotation fallback are all explicitly verified before proceeding.
- After Phase 2: those same flows are explicitly re-verified, and highlight placement correctness is confirmed after the monolith split.
- After Phase 3: lint/test/CI run successfully, and smoke coverage explicitly covers startup, preference pane load/save, `renderTextSelectionPopup`, `renderToolbar`, and annotation fallback.
- After Phase 4: scaffold-only development, build, and release flows are validated first; only then are `build.js`, `npm run build:legacy`, and any tracked generated outputs removed.

### Validation Methods

- Build check: `npm run build`
- Manual Zotero smoke checks for:
  - preference persistence for `apiKey`, `baseURL`, `model`, `systemPrompt`
  - Reader selection popup rendering
  - Reader toolbar rendering
  - entity extraction request execution
  - highlight placement correctness
  - fallback annotation path behavior

## Deferred or Optional Follow-Up Work

- Add deeper tests around `src/llm.ts` JSON cleanup and offset repair.
- Add pure-unit tests for `src/rect-splitter.ts`.
- Introduce stronger typing around Zotero Reader internals only after the structure split is complete.
- Revisit whether preference UI assets should remain packaged under `addon/content/` or be driven more directly from template-style module wiring.
- Consider simplifying `zotero-plugin.config.ts` after the runtime architecture matches the target layout more closely.
- Review whether any generated files are accidentally tracked and should be excluded more clearly once the migration is complete.

## Maintainer Guidance

- Use `zotero-plugin-template/` as a structural reference, not as a replacement baseline.
- Treat scaffold `0.8.3` from the root lockfile as the frozen migration baseline; the `package.json` semver declaration `zotero-plugin-scaffold` `^0.8.3` describes the dependency range, not the pinned execution baseline.
- Keep the pinned template/scaffold baseline fixed during this migration; update either one only in a separate pass.
- Preserve the working Reader/LLM/highlighting logic and refactor around it.
- Do not delete the legacy build flow until scaffold-only behavior is proven stable.
- Prefer small, reversible moves that keep the plugin runnable after each phase.
