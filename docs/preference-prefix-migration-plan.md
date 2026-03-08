# Preference Prefix Migration Plan

## Objective

Fix the duplicated preference-prefix bug so that all plugin preferences use the canonical branch `extensions.zotero-pdf-highlighter.*`, while preserving the values users are effectively using today.

The key constraint is that the current runtime is split-brain: some code paths operate on the canonical branch, but several runtime/UI/LLM reads and writes still operate on the duplicated legacy branch `extensions.zotero.extensions.zotero-pdf-highlighter.*`. The migration must therefore treat legacy duplicated values as potentially authoritative user data.

## Current-State Diagnosis

Confirmed current behavior in this repository:

- The intended canonical branch is `extensions.zotero-pdf-highlighter.*`.
- `addon/prefs.js`, `package.json`, `zotero-plugin.config.ts`, and `src/preferences.ts` all point to that canonical single-prefix branch.
- `registerPreferenceDefaults()` in `src/bootstrap.ts` writes with `global=true`, so its writes target canonical keys.
- `clearPreference()` in `src/bootstrap.ts` also clears correctly with `global=true` when the caller passes a fully-qualified key.
- However, several runtime reads and writes still call `Zotero.Prefs.get(...)` or `Zotero.Prefs.set(...)` with fully-qualified keys and without `global=true`.
- In Zotero, when `global` is falsy, `Zotero.Prefs.get/set(pref, global)` prepends `extensions.zotero.`.
- As a result, a call like `Zotero.Prefs.get("extensions.zotero-pdf-highlighter.apiKey")` actually reads `extensions.zotero.extensions.zotero-pdf-highlighter.apiKey`.

This creates a split-brain state today:

- Canonical branch examples:
  - `extensions.zotero-pdf-highlighter.apiKey`
  - `extensions.zotero-pdf-highlighter.systemPrompt`
  - `extensions.zotero-pdf-highlighter.density`
- Legacy duplicated branch examples:
  - `extensions.zotero.extensions.zotero-pdf-highlighter.apiKey`
  - `extensions.zotero.extensions.zotero-pdf-highlighter.systemPrompt`
  - `extensions.zotero.extensions.zotero-pdf-highlighter.density`

Important nuance from the current code logic:

- `registerPreferenceDefaults()` currently checks `Zotero.Prefs.get(PREF_PREFIX + key)` without `global=true`, so its existence check reads the legacy duplicated branch.
- It then writes with `Zotero.Prefs.set(PREF_PREFIX + key, val, true)`, which targets the canonical branch.
- That means default registration is also hybrid today: whether it seeds canonical defaults depends on whether the legacy duplicated key appears to exist.

## Root Cause

The root cause is inconsistent use of fully-qualified preference keys with Zotero's `global` flag.

1. The code constructs fully-qualified keys such as `extensions.zotero-pdf-highlighter.apiKey`.
2. It then passes those fully-qualified keys to `Zotero.Prefs.get/set(...)` without `global=true`.
3. Zotero prepends `extensions.zotero.` when `global` is falsy.
4. The effective runtime key becomes `extensions.zotero.extensions.zotero-pdf-highlighter.apiKey`.

So the bug is not that the configured prefix is wrong. The configured prefix is already correct. The bug is that runtime access paths are bypassing the canonical branch by calling Zotero's pref API incorrectly.

## Canonical vs Legacy Branches

### Canonical branch

- Prefix: `extensions.zotero-pdf-highlighter.`
- Intended long-term home for all plugin preferences
- Already used by:
  - `addon/prefs.js`
  - `package.json` `config.prefsPrefix`
  - `zotero-plugin.config.ts` `build.prefs.prefix`
  - `src/preferences.ts` `PREF_PREFIX`

### Legacy duplicated branch

- Prefix: `extensions.zotero.extensions.zotero-pdf-highlighter.`
- Not intentionally configured anywhere as the official branch
- Created accidentally by runtime `get/set` calls that pass fully-qualified keys without `global=true`
- Likely contains the values users actually interacted with through the current runtime and preference UI

### Keys affected in practice

At minimum, plan for migration of all existing user-facing keys in `PREF_DEFAULTS`:

1. `apiKey`
2. `baseURL`
3. `model`
4. `systemPrompt`
5. `globalSystemPrompt`
6. `density`
7. `focusMode`
8. `minConfidence`

## Non-Goals

- Do not change the canonical prefix away from `extensions.zotero-pdf-highlighter.*`.
- Do not preserve continued runtime use of the duplicated branch.
- Do not hand-edit generated scaffold output under `.scaffold/build/`.
- Do not perform a destructive preference wipe.
- Do not assume canonical is already the runtime source of truth for existing users.
- Do not migrate unrelated Zotero preferences outside this plugin's key set.

## Migration Design Principles

1. Preserve real user state over theoretical correctness.
2. Treat legacy duplicated values as possibly authoritative because current runtime/UI/LLM behavior has been using them.
3. Centralize all pref access behind helper functions so the bug cannot reappear through scattered direct calls.
4. Make migration idempotent and one-time, with an explicit migration marker.
5. Separate raw storage reads from effective-value resolution so conflict handling is deterministic and testable.
6. Prefer writing canonical first, verifying, and only then clearing legacy keys.
7. Keep logging explicit with `Zotero.debug` so field diagnostics are possible if users report lost settings.

## Fine-Grained Implementation Plan by Phase

### Phase 1: Add centralized preference helpers

Goal: remove all ambiguous pref access patterns before introducing migration logic.

1. In `src/preferences.ts`, add explicit branch constants:
   - `PREF_PREFIX = "extensions.zotero-pdf-highlighter."`
   - `LEGACY_DUPLICATED_PREF_PREFIX = "extensions.zotero.extensions.zotero-pdf-highlighter."`
2. Add helper functions for fully-qualified key generation:
   - `getCanonicalPrefKey(key: string): string`
   - `getLegacyDuplicatedPrefKey(key: string): string`
3. Add low-level global-only access helpers that always use `global=true` for fully-qualified keys:
   - `getGlobalPrefByFullKey(fullKey: string): unknown`
   - `setGlobalPrefByFullKey(fullKey: string, value: string): void`
   - `clearGlobalPrefByFullKey(fullKey: string): void`
4. Add typed convenience helpers for canonical access:
   - `getCanonicalPref(key: keyof typeof PREF_DEFAULTS): string`
   - `setCanonicalPref(key: keyof typeof PREF_DEFAULTS, value: string): void`
   - `clearCanonicalPref(key: keyof typeof PREF_DEFAULTS): void`
5. Add raw branch inspection helpers used by migration:
   - `getCanonicalRawPref(key)`
   - `getLegacyRawPref(key)`
   - `getBranchSnapshot(key)` returning both raw values plus normalized metadata
6. Add normalization helpers for conflict handling:
   - one helper for regular string prefs based on `PREF_DEFAULTS`
   - one helper for `systemPrompt`
   - one helper for `globalSystemPrompt`
7. Add an explicit migration marker key, for example `extensions.zotero-pdf-highlighter.prefPrefixMigrationVersion`.
8. Update `registerPreferenceDefaults()` to use only canonical global helpers for both read and write paths; do not leave the current mixed read-legacy/write-canonical behavior in place.
9. Add a repository rule in code comments or naming structure by convention: no direct `Zotero.Prefs.get/set/clear` calls with plugin keys outside the centralized helper layer.

Example helper behavior:

- `getCanonicalPref("apiKey")` reads `extensions.zotero-pdf-highlighter.apiKey` with `global=true`
- `getLegacyRawPref("apiKey")` reads `extensions.zotero.extensions.zotero-pdf-highlighter.apiKey` with `global=true`
- No helper should ever call `Zotero.Prefs.get(PREF_PREFIX + key)` without `global=true`

### Phase 2: Implement one-time migration

Goal: copy the effective user values from the split-brain state into canonical keys exactly once.

1. Add a migration function such as `migratePreferencePrefixIfNeeded()`.
2. Run it very early during startup, before any runtime/UI/LLM code reads preferences.
3. Change startup sequencing so preference initialization becomes:
   1. check migration marker
   2. run migration if needed
   3. register canonical defaults for any still-missing keys
   4. continue with UI registration and runtime hooks
4. For each known preference key, read both branches explicitly with `global=true`:
   - canonical: `extensions.zotero-pdf-highlighter.<key>`
   - legacy: `extensions.zotero.extensions.zotero-pdf-highlighter.<key>`
5. For each key, classify each branch value as one of:
   - missing / unset
   - default-equivalent
   - non-default user value
6. Resolve the winning value using the conflict rules defined later in this document.
7. Write the winning value to the canonical branch only.
8. Verify the canonical write by reading back the canonical key with `global=true`.
9. Do not clear the legacy branch yet unless all keys migrate successfully; cleanup belongs in a later guarded step.
10. Write the migration marker only after the full migration pass succeeds.
11. Log per-key outcomes with safe redaction for sensitive values such as `apiKey`.

Recommended migration algorithm per key:

1. Read canonical raw value.
2. Read legacy raw value.
3. Determine whether each value is default-equivalent for that key.
4. Choose winner.
5. If winner is non-default, write it to canonical.
6. If winner is default-equivalent, either clear canonical or leave canonical unset and let default registration seed it.
7. Record whether legacy cleanup is safe for that key.

Concrete example:

- Canonical `extensions.zotero-pdf-highlighter.model` = `z-ai/glm-4.5-air:free` (default)
- Legacy `extensions.zotero.extensions.zotero-pdf-highlighter.model` = `openai/gpt-4.1`
- Winner: legacy
- Post-migration canonical value: `openai/gpt-4.1`

### Phase 3: Switch all runtime call sites to helpers

Goal: once migration exists, stop creating or reading the duplicated branch.

1. Replace all direct runtime preference reads in `src/bootstrap.ts` with canonical helpers.
2. Replace all direct runtime preference reads in `src/llm.ts` with canonical helpers.
3. Replace all preference pane load/save paths in `src/bootstrap.ts` with canonical helpers.
4. Replace any fallback clear logic with the centralized canonical clear helper.
5. Ensure prompt-resolution helpers receive canonical raw values only.
6. Confirm no code path still calls `Zotero.Prefs.get/set/clear` directly for plugin keys except inside the helper layer.

Known current call sites to switch include at least:

- Selection-mode density read in `src/bootstrap.ts`
- Preferences pane load logic in `src/bootstrap.ts`
- Preferences pane save logic in `src/bootstrap.ts`
- Global-highlight toolbar reads for `density`, `focusMode`, and `minConfidence` in `src/bootstrap.ts`
- LLM reads for `apiKey`, `baseURL`, `model`, `systemPrompt`, and `globalSystemPrompt` in `src/llm.ts`

### Phase 4: Cleanup and safeguards

Goal: remove the temporary split-brain residue and prevent regressions.

1. After a successful migration and helper rollout, clear legacy duplicated keys with `global=true`.
2. Keep legacy cleanup conditional on successful canonical write verification.
3. Leave the migration marker in canonical storage so startup does not re-run the migration on every launch.
4. Add extra debug logging around migration version, keys migrated, and keys skipped.
5. Add a defensive startup assertion or debug scan that detects unexpected legacy values after migration.
6. Consider adding a small internal helper test surface if this repo later gains a test harness; until then, keep helper functions pure and easy to validate manually.
7. Optionally keep a temporary compatibility scan for one or two releases that logs if new legacy duplicated keys appear again, which would indicate a regression.

## Detailed Migration Conflict-Resolution Rules

These rules must be applied per key.

### Definitions

- `missing`: pref does not exist or resolves to `undefined`
- `default-equivalent`: stored value is effectively the default for that key
- `non-default`: stored value differs from the default for that key

### Default-equivalent rules

For standard string prefs, compare against `PREF_DEFAULTS`:

- `apiKey` default-equivalent: `""`
- `baseURL` default-equivalent: `"https://openrouter.ai/api/v1"`
- `model` default-equivalent: `"z-ai/glm-4.5-air:free"`
- `density` default-equivalent: `"balanced"`
- `focusMode` default-equivalent: `"balanced"`
- `minConfidence` default-equivalent: `"0.5"`

For prompt overrides, reuse the current semantics already encoded in `src/preferences.ts`:

- `systemPrompt` is default-equivalent when empty, whitespace-only, or exactly equal to `DEFAULT_SYSTEM_PROMPT`
- `globalSystemPrompt` is default-equivalent when empty, whitespace-only, or exactly equal to `DEFAULT_GLOBAL_SYSTEM_PROMPT`

### Winner-selection rules

1. If both canonical and legacy are missing, keep canonical unset and let canonical default registration seed the value.
2. If only one branch has a non-default value, that branch wins.
3. If one branch is default-equivalent and the other is non-default, the non-default branch wins.
4. If both branches are default-equivalent, prefer canonical and clear legacy during cleanup.
5. If both branches are non-default and equal after normalization, prefer canonical and clear legacy during cleanup.
6. If both branches are non-default and different, legacy wins.

Rule 6 is the critical update for this repository state. In a true non-default conflict, the duplicated legacy branch is more likely to reflect the value current runtime behavior has actually been using, because multiple runtime/UI/LLM call sites currently read and write the duplicated branch.

### Examples

#### Example A: legacy-only user setting

- Canonical `extensions.zotero-pdf-highlighter.focusMode` = missing
- Legacy `extensions.zotero.extensions.zotero-pdf-highlighter.focusMode` = `results-first`
- Result: migrate `results-first` into canonical

#### Example B: canonical-only user setting

- Canonical `extensions.zotero-pdf-highlighter.baseURL` = `https://my-gateway.example/v1`
- Legacy `extensions.zotero.extensions.zotero-pdf-highlighter.baseURL` = missing
- Result: keep canonical as-is

#### Example C: canonical default vs legacy user value

- Canonical `extensions.zotero-pdf-highlighter.density` = `balanced`
- Legacy `extensions.zotero.extensions.zotero-pdf-highlighter.density` = `dense`
- Result: legacy wins, canonical becomes `dense`

#### Example D: true conflict

- Canonical `extensions.zotero-pdf-highlighter.model` = `anthropic/claude-3.7-sonnet`
- Legacy `extensions.zotero.extensions.zotero-pdf-highlighter.model` = `openai/gpt-4.1`
- Result: legacy wins because current runtime behavior most likely used it

#### Example E: prompt override conflict

- Canonical `extensions.zotero-pdf-highlighter.systemPrompt` = empty
- Legacy `extensions.zotero.extensions.zotero-pdf-highlighter.systemPrompt` = custom non-empty override
- Result: legacy wins and canonical stores the custom override

## File-by-File Change Plan

### `src/preferences.ts`

1. Keep `PREF_PREFIX` as the canonical branch constant.
2. Add the legacy duplicated prefix constant.
3. Add centralized global-pref helpers.
4. Add branch snapshot and default-equivalence helpers.
5. Add migration marker constants and helper accessors.
6. Keep prompt-resolution functions, but make them work with canonical helper outputs rather than ad hoc direct Zotero calls.

### `src/bootstrap.ts`

1. Replace `registerPreferenceDefaults()` internals so both read and write paths use canonical helpers only.
2. Add `migratePreferencePrefixIfNeeded()` orchestration during `startup()` before any preference-dependent UI or runtime logic.
3. Replace preference pane load logic with canonical helper reads.
4. Replace preference pane save logic with canonical helper writes and clears.
5. Replace selection and global toolbar runtime reads for `density`, `focusMode`, and `minConfidence` with canonical helpers.
6. Add guarded legacy cleanup after successful migration.
7. Add `Zotero.debug` migration logging with redaction for secrets.

### `src/llm.ts`

1. Replace the local `getPref()` implementation so it reads canonical values through centralized helpers.
2. Ensure `apiKey`, `baseURL`, `model`, `systemPrompt`, and `globalSystemPrompt` all resolve from canonical storage only.
3. Confirm prompt override resolution continues to use the existing `resolveSystemPromptPreference()` semantics.

### Optional new helper module

If `src/preferences.ts` becomes too large, move raw storage and migration-specific helpers into a new module such as `src/preference-store.ts` or `src/preference-migration.ts`.

Suggested split:

- `src/preferences.ts`: constants, defaults, prompt-resolution semantics, public typed helpers
- `src/preference-migration.ts`: branch comparison, conflict resolution, migration execution, cleanup

## Verification Plan

### Static verification

1. Search the repo for `Zotero.Prefs.get(`, `Zotero.Prefs.set(`, and `Zotero.Prefs.clear(`.
2. Confirm no plugin-pref call site still passes a fully-qualified plugin key without `global=true`, except inside the centralized helper layer.
3. Run `npm run build`.
4. Run `npx tsc --noEmit` if a more focused type-check is needed.

### Manual migration verification

Test at least these scenarios in a development profile:

1. Legacy-only values exist; canonical missing.
2. Canonical-only values exist; legacy missing.
3. Canonical default + legacy non-default.
4. Canonical non-default + legacy non-default with different values.
5. Prompt override keys with empty, default-literal, and custom values.

For each scenario:

1. Start Zotero with the updated plugin.
2. Let startup migration run once.
3. Inspect both branches in `about:config` or equivalent pref inspection tooling.
4. Confirm canonical contains the expected winner.
5. Confirm the plugin UI loads the expected value.
6. Confirm editing and saving from the preference pane updates canonical only.
7. Confirm runtime actions use the same value the preference pane shows.

### Functional verification

1. Set `density`, `focusMode`, and `minConfidence` to recognizable values and verify selection and global highlighting behavior follow them.
2. Set a custom `baseURL`, `model`, and `apiKey`, then confirm LLM calls log the expected endpoint/model behavior without exposing secret contents.
3. Set custom `systemPrompt` and `globalSystemPrompt`, reload, and confirm the preference pane and runtime both use the same canonical values.
4. Re-launch Zotero and confirm migration does not re-run after the marker is set.

## Rollback / Safety Considerations

1. Write canonical values before clearing legacy values.
2. Verify canonical writes by reading them back with `global=true`.
3. Do not delete legacy keys if migration fails partway through.
4. Keep migration one-time and versioned so a future follow-up migration can be introduced safely.
5. Redact sensitive pref values such as `apiKey` in logs.
6. If an unexpected issue is found after release, a temporary rollback strategy is to keep helper reads canonical-first but still inspect legacy for diagnostics; do not reintroduce direct runtime dependence on the duplicated branch.

## Open Questions or Follow-Ups

1. Should the migration marker live in canonical prefs only, or also include a debug-only timestamp/result key for easier support diagnostics?
2. Should legacy duplicated keys be cleared in the same release as migration, or one release later after observing successful field behavior?
3. Should prompt-override normalization trim whitespace-only values before writing canonical, or preserve exact raw strings once a value is classified as non-default?
4. Should the helper layer expose typed getters like `getDensityPreference()` and `getFocusModePreference()` to avoid repeating string coercion in runtime code?
5. Should a temporary startup warning be logged if a legacy duplicated key reappears after migration, indicating a new regression path?
