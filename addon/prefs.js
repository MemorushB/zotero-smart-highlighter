pref("extensions.zotero-pdf-highlighter.apiKey", "");
pref("extensions.zotero-pdf-highlighter.baseURL", "https://openrouter.ai/api/v1");
pref("extensions.zotero-pdf-highlighter.model", "z-ai/glm-4.5-air:free");
pref("extensions.zotero-pdf-highlighter.systemPrompt", `Extract academic named entities from the user text.
Return JSON only in this exact schema: {"entities":[{"text":"exact text","type":"TYPE","start":0,"end":5}]}
Allowed types: METHOD, DATASET, METRIC, TASK, PERSON, MATERIAL, INSTITUTION, TERM.
Rules: no explanation, no reasoning, no markdown, no restating input, stop immediately after the closing }. If none, return {"entities":[]}.
Offsets: start is 0-based, end is exclusive, and text must be the exact substring at [start, end).`);
