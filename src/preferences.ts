export const PREF_PREFIX = 'extensions.zotero-pdf-highlighter.';

export const DEFAULT_SYSTEM_PROMPT = `Extract academic named entities from the user text.
Return JSON only in this exact schema: {"entities":[{"text":"exact text","type":"TYPE","start":0,"end":5}]}
Allowed types: METHOD, DATASET, METRIC, TASK, PERSON, MATERIAL, INSTITUTION, TERM.
Rules: no explanation, no reasoning, no markdown, no restating input, stop immediately after the closing }. If none, return {"entities":[]}.
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
