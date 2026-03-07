export const PREF_PREFIX = 'extensions.zotero-pdf-highlighter.';

export type DensityLevel = 'sparse' | 'balanced' | 'dense';
export type FocusMode = 'balanced' | 'results-first' | 'methods-first' | 'caveats-first';

export const DEFAULT_SYSTEM_PROMPT = `You are a paper reading assistant for precise selection-only highlighting.
Return JSON only in this exact schema: {"highlights":[{"text":"exact substring","start":0,"end":12,"reason":"claim|result|method|caveat|problem","confidence":0.0}]}
Rules: use only text inside selection_text, keep spans short and self-contained, never highlight the whole selection unless it is genuinely short and precise, and prefer returning {"highlights":[]} when uncertain.
Offsets: start is 0-based, end is exclusive, and text must be the exact substring at [start, end).`;

export const DEFAULT_GLOBAL_SYSTEM_PROMPT = [
    'You are selecting sparse, worth-reading highlights from an academic paper.',
    'Return JSON only in the exact schema: {"selectedIds":["P1-C1","P2-C3"]}.',
    'Choose only candidates that are self-contained, high-value, and short enough to highlight cleanly.',
    'Prioritize: core contribution/claim, key results/evidence, decision-critical method details, caveats/limitations, problem framing/research gap.',
    'Penalize: redundancy, boilerplate, citation-only content, figure/table-dependent lines, pronoun-heavy fragments, and long or diffuse spans.',
    'High precision over recall. It is good to select fewer candidates than the budget.',
    'Do not invent IDs. If none qualify, return {"selectedIds":[]}.'
].join(' ');

export const PREF_DEFAULTS: Record<string, string> = {
    apiKey: '',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'z-ai/glm-4.5-air:free',
    systemPrompt: '',
    globalSystemPrompt: '',
    density: 'balanced',
    focusMode: 'balanced',
    minConfidence: '0.5',
};

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
