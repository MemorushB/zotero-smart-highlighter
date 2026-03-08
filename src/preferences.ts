declare const Zotero: any;

export const PREF_PREFIX = 'extensions.zotero-pdf-highlighter.';
export const LEGACY_DUPLICATED_PREF_PREFIX = 'extensions.zotero.extensions.zotero-pdf-highlighter.';
export const PREF_PREFIX_MIGRATION_VERSION_KEY = 'prefPrefixMigrationVersion';
export const PREF_PREFIX_MIGRATION_VERSION = '1';

export type DensityLevel = 'sparse' | 'balanced' | 'dense';
export type FocusMode = 'balanced' | 'results-first' | 'methods-first' | 'caveats-first';
export type HighlightBackendMode = 'auto' | 'llm-preferred' | 'non-llm-only';
export type NonLlmLexicalMethod = 'bm25' | 'tfidf';

export const DEFAULT_SYSTEM_PROMPT = `You are a precision highlighting assistant for academic papers.

Task: From the given text selection, extract only the short spans most worth revisiting during a skim read. You may return zero highlights if nothing qualifies.

A span qualifies only if ALL of these hold:
1. Standalone: intelligible without surrounding sentences - no unresolved "this", "these", "it", or "they".
2. Informative: contains a specific claim, finding, method detail, limitation, or defined concept - not generic framing or boilerplate.
3. Concise: short enough to highlight cleanly - one clause or short sentence, never a full paragraph.

Reason taxonomy (assign exactly one):
- claim: core contribution, hypothesis, or positioning statement
- result: quantitative finding, comparison outcome, or concrete evidence
- method: design decision, technique, dataset, or setup detail that matters for validity
- caveat: limitation, failure case, assumption, or scope boundary
- background: problem framing, research gap, or motivation that sets up the contribution

Confidence tiers:
- high: clear category match with direct textual evidence
- medium: plausible category, mild ambiguity
- low: weak evidence or cross-category overlap

Rules:
- Prefer fewer, better highlights over many marginal ones.
- Never highlight section headers, citations-only fragments, or figure/table references that need visual context.
- If nothing in the selection passes all three gates, return an empty highlights array.
- Offsets are 0-based; end is exclusive; text must exactly equal selection_text[start:end].`;

export const DEFAULT_GLOBAL_SYSTEM_PROMPT = `You are selecting sparse, high-value highlights to help a researcher skim an academic paper efficiently.

TASK
From the numbered candidate list, select at most the given budget of spans that maximize skimming utility. Return JSON only in the exact schema: {"selections":[{"id":"P1-C1","reason":"method"}]}. You may select fewer than the budget - and should, if precision is uncertain. An empty selection is valid.

SELECTION RUBRIC - a candidate must pass ALL gates:
1. Standalone readability: The span makes sense without its surrounding paragraph. It has a clear subject, does not depend on unresolved references (this, these, it, they, the above), and is not a sentence fragment.
2. Scholarly value: The span carries specific, non-trivial information - a claim, finding, method detail, limitation, or defined concept. Generic transitions, boilerplate, or restatements of common knowledge do not qualify.
3. Specificity: The span names concrete objects, quantities, relationships, or conditions rather than vague generalities.
4. Non-redundancy: The span adds information not already covered by another selected candidate. If two candidates express substantially the same idea, keep only the more self-contained one.
5. Not citation-list content: The span must not come from References, Bibliography, Works Cited, or other citation-list sections, and must not be a standalone citation-list entry even if it contains technical terms or appears content-rich.

REASON TAXONOMY (assign exactly one)
- claim: core contribution, hypothesis, or positioning statement
- result: quantitative finding, comparison outcome, or concrete evidence
- method: design decision, technique, dataset, or setup detail that matters for validity
- caveat: limitation, failure case, assumption, or scope boundary
- background: problem framing, research gap, or motivation that sets up the contribution

SECTION-AWARE PRIORITIES
Apply these priors based on the candidate's section label, but let content override heading when they conflict:
- Abstract / Introduction: favor claims, contributions, problem framing, and headline results
- Methods: favor design decisions, unusual setup details, and validity-critical assumptions - skip routine procedure
- Results / Evaluation: favor outcome statements, comparisons, and evidence-bearing claims - skip table/figure narration
- Discussion / Conclusion: favor interpretation, limitations, implications, and future directions
- Related Work: only select if the span positions this paper's novelty against prior work; skip pure citation lists

PENALTIES - downweight candidates that:
- Are redundant with an already-selected highlight
- Consist mostly of citations without a substantive claim
- Depend on a figure, table, or equation to convey meaning
- Contain heavy pronoun use or ambiguous referents
- Are unusually long or combine multiple loosely related ideas
- Appear to be selected only because of their position (first or last in the list)

ORDERING RULES
- Judge each candidate on its own merits, not by its index in the list.
- Do not favor earlier or later candidates due to position.
- Spread selections across sections when the paper content supports it - avoid clustering all highlights in one area.

PRECISION POLICY
- When in doubt, do not select.
- It is always better to return fewer high-confidence highlights than to pad the selection with marginal ones.
- If no candidate clearly satisfies the rubric, return {"selections":[]}.
- Do not invent IDs. Only return IDs present in the candidate list.`;

export const PREF_DEFAULTS = {
    apiKey: '',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    backendMode: 'auto',
    nonLlmLexicalMethod: 'bm25',
    systemPrompt: '',
    globalSystemPrompt: '',
    density: 'balanced',
    focusMode: 'balanced',
    minConfidence: '0.5',
} as const;

const BLANK_DEFAULT_EQUIVALENT_PREFERENCES = new Set<PreferenceKey>(['minConfidence']);

export type PreferenceKey = keyof typeof PREF_DEFAULTS;
export type PreferenceClearOutcome = 'cleared' | 'default-equivalent-written';

export type PreferenceBranchState = 'missing' | 'default-equivalent' | 'non-default';

export interface PreferenceBranchSnapshot {
    key: PreferenceKey;
    canonicalRaw: string | undefined;
    legacyRaw: string | undefined;
    canonicalNormalized: string | null;
    legacyNormalized: string | null;
    canonicalState: PreferenceBranchState;
    legacyState: PreferenceBranchState;
}

export function getCanonicalPrefKey(key: PreferenceKey | typeof PREF_PREFIX_MIGRATION_VERSION_KEY): string {
    return `${PREF_PREFIX}${key}`;
}

export function getLegacyDuplicatedPrefKey(key: PreferenceKey): string {
    return `${LEGACY_DUPLICATED_PREF_PREFIX}${key}`;
}

export function getGlobalPrefByFullKey(fullKey: string): unknown {
    return Zotero.Prefs.get(fullKey, true);
}

export function setGlobalPrefByFullKey(fullKey: string, value: string): void {
    Zotero.Prefs.set(fullKey, value, true);
}

export function clearGlobalPrefByFullKey(fullKey: string, fallbackValue = ''): PreferenceClearOutcome {
    if (typeof Zotero.Prefs.clear === 'function') {
        Zotero.Prefs.clear(fullKey, true);
        return 'cleared';
    }

    Zotero.Prefs.set(fullKey, fallbackValue, true);
    return 'default-equivalent-written';
}

function getRawStringPrefByFullKey(fullKey: string): string | undefined {
    const value = getGlobalPrefByFullKey(fullKey);
    if (value === undefined) {
        return undefined;
    }

    return typeof value === 'string' ? value : String(value);
}

export function getCanonicalRawPref(key: PreferenceKey): string | undefined {
    return getRawStringPrefByFullKey(getCanonicalPrefKey(key));
}

export function getLegacyRawPref(key: PreferenceKey): string | undefined {
    return getRawStringPrefByFullKey(getLegacyDuplicatedPrefKey(key));
}

export function getCanonicalPref(key: PreferenceKey): string {
    const rawValue = getCanonicalRawPref(key);
    const normalizedValue = normalizePreferenceValue(key, rawValue);
    return normalizedValue ?? PREF_DEFAULTS[key];
}

export function setCanonicalPref(key: PreferenceKey, value: string): void {
    setGlobalPrefByFullKey(getCanonicalPrefKey(key), value);
}

export function clearCanonicalPref(key: PreferenceKey): void {
    clearGlobalPrefByFullKey(getCanonicalPrefKey(key));
}

export function clearLegacyDuplicatedPrefToDefaultEquivalent(key: PreferenceKey): PreferenceClearOutcome {
    return clearGlobalPrefByFullKey(getLegacyDuplicatedPrefKey(key), PREF_DEFAULTS[key]);
}

export function setCanonicalPrefToDefaultEquivalent(key: PreferenceKey): void {
    if (typeof Zotero.Prefs.clear === 'function') {
        clearCanonicalPref(key);
        return;
    }

    setCanonicalPref(key, PREF_DEFAULTS[key]);
}

export function getPrefPrefixMigrationVersion(): string | undefined {
    return getRawStringPrefByFullKey(getCanonicalPrefKey(PREF_PREFIX_MIGRATION_VERSION_KEY));
}

export function setPrefPrefixMigrationVersion(version: string): void {
    setGlobalPrefByFullKey(getCanonicalPrefKey(PREF_PREFIX_MIGRATION_VERSION_KEY), version);
}

export function isPrefDefaultEquivalent(key: PreferenceKey, value: unknown): boolean {
    if (key === 'systemPrompt') {
        return getStoredSystemPromptOverride(value) === null;
    }

    if (key === 'globalSystemPrompt') {
        return getStoredGlobalSystemPromptOverride(value) === null;
    }

    if (isBlankDefaultEquivalentPreferenceValue(key, value)) {
        return true;
    }

    return String(value ?? '') === PREF_DEFAULTS[key];
}

export function normalizePreferenceValue(key: PreferenceKey, value: unknown): string | null {
    if (value === undefined) {
        return null;
    }

    if (key === 'systemPrompt') {
        return getStoredSystemPromptOverride(value);
    }

    if (key === 'globalSystemPrompt') {
        return getStoredGlobalSystemPromptOverride(value);
    }

    const stringValue = typeof value === 'string' ? value : String(value ?? '');
    return isPrefDefaultEquivalent(key, stringValue) ? null : stringValue;
}

export function isBlankDefaultEquivalentPreferenceValue(key: PreferenceKey, value: unknown): boolean {
    if (!BLANK_DEFAULT_EQUIVALENT_PREFERENCES.has(key)) {
        return false;
    }

    return getNonEmptyPreferenceValue(value) === null;
}

function getPreferenceBranchState(key: PreferenceKey, value: string | undefined): PreferenceBranchState {
    if (value === undefined) {
        return 'missing';
    }

    return isPrefDefaultEquivalent(key, value) ? 'default-equivalent' : 'non-default';
}

export function getBranchSnapshot(key: PreferenceKey): PreferenceBranchSnapshot {
    const canonicalRaw = getCanonicalRawPref(key);
    const legacyRaw = getLegacyRawPref(key);

    return {
        key,
        canonicalRaw,
        legacyRaw,
        canonicalNormalized: normalizePreferenceValue(key, canonicalRaw),
        legacyNormalized: normalizePreferenceValue(key, legacyRaw),
        canonicalState: getPreferenceBranchState(key, canonicalRaw),
        legacyState: getPreferenceBranchState(key, legacyRaw),
    };
}

export function getNonEmptyPreferenceValue(value: unknown): string | null {
    const stringValue = typeof value === 'string' ? value : String(value ?? '');
    return stringValue.trim() ? stringValue : null;
}

export function getStoredSystemPromptOverride(value: unknown): string | null {
    const stringValue = typeof value === 'string' ? value : String(value ?? '');
    const nonEmptyValue = getNonEmptyPreferenceValue(stringValue);

    if (!nonEmptyValue || stringValue === DEFAULT_SYSTEM_PROMPT) {
        return null;
    }

    return stringValue;
}

export function getStoredGlobalSystemPromptOverride(value: unknown): string | null {
    const stringValue = typeof value === 'string' ? value : String(value ?? '');
    const nonEmptyValue = getNonEmptyPreferenceValue(stringValue);

    if (!nonEmptyValue || stringValue === DEFAULT_GLOBAL_SYSTEM_PROMPT) {
        return null;
    }

    return stringValue;
}

export function resolveSystemPromptPreference(value: unknown): string {
    return getStoredSystemPromptOverride(value) ?? DEFAULT_SYSTEM_PROMPT;
}

export function resolveGlobalSystemPromptPreference(value: unknown): string {
    const stringValue = typeof value === 'string' ? value : String(value ?? '');
    const nonEmptyValue = getNonEmptyPreferenceValue(stringValue);

    if (!nonEmptyValue || stringValue === DEFAULT_GLOBAL_SYSTEM_PROMPT) {
        return DEFAULT_GLOBAL_SYSTEM_PROMPT;
    }

    return stringValue;
}
