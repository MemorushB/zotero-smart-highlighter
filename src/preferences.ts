export const PREF_PREFIX = 'extensions.zotero-pdf-highlighter.';

export const DEFAULT_SYSTEM_PROMPT = `You are a paper reading assistant for precise selection-only highlighting.
Return JSON only in this exact schema: {"highlights":[{"text":"exact substring","start":0,"end":12,"reason":"claim|result|method|caveat|problem","confidence":0.0}]}
Rules: use only text inside selection_text, keep spans short and self-contained, never highlight the whole selection unless it is genuinely short and precise, and prefer returning {"highlights":[]} when uncertain.
Offsets: start is 0-based, end is exclusive, and text must be the exact substring at [start, end).`;

export const PREF_DEFAULTS: Record<string, string> = {
    apiKey: '',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'z-ai/glm-4.5-air:free',
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

export function resolveSystemPromptPreference(value: unknown): string {
    return getStoredSystemPromptOverride(value) ?? DEFAULT_SYSTEM_PROMPT;
}
