/**
 * LLM API client for NER extraction.
 * Uses Zotero.HTTP.request() to bypass CookieSandbox header stripping.
 * Settings read from Zotero.Prefs at call time.
 */

declare const Zotero: any;

import { PREF_PREFIX, resolveSystemPromptPreference } from "./preferences";

// ── Types ────────────────────────────────────────────────────────────

export interface NerEntity {
  text: string;
  type: string;
  start: number; // 0-based char offset
  end: number;   // exclusive
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ExtractEntitiesOptions {
  timeoutMs?: number;
  maxRetries?: number;
  callerLabel?: string;
}

interface LlmErrorClassification {
  kind: "rate_limit" | "server_error" | "client_error";
  retryable: boolean;
}

class EmptyLlmContentError extends Error {
  constructor(message = "LLM returned empty content") {
    super(message);
    this.name = "EmptyLlmContentError";
  }
}

class NonRetryableLlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableLlmError";
  }
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

function getSystemPrompt(): string {
  return resolveSystemPromptPreference(getPref("systemPrompt"));
}

function getLogPrefix(callerLabel?: string): string {
  return callerLabel ? `[NER:${callerLabel}]` : "[NER]";
}

// ── Preference helpers ───────────────────────────────────────────────

function getPref(key: string): string {
  return String(Zotero.Prefs.get(PREF_PREFIX + key) ?? "");
}

// ── Error classification ─────────────────────────────────────────────

function classifyHttpError(status: number): LlmErrorClassification {
  if (status === 429) return { kind: "rate_limit", retryable: true };
  if (status >= 500)  return { kind: "server_error", retryable: true };
  return { kind: "client_error", retryable: false };
}

// ── JSON extraction ──────────────────────────────────────────────────

function cleanMarkdownCodeBlock(raw: string): string {
  let cleaned = raw.trim();

  // Remove leading ```json or ```
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }

  // Remove trailing ```
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }

  return cleaned.trim();
}

function isJsonWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function findBalancedJsonEnd(input: string, startIndex = 0): number | null {
  const startChar = input[startIndex];
  if (startChar !== "{" && startChar !== "[") {
    return null;
  }

  const stack: string[] = [startChar];
  let inString = false;
  let isEscaped = false;

  for (let index = startIndex + 1; index < input.length; index++) {
    const char = input[index];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (char === "\\") {
        isEscaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }

    if (char === "}") {
      if (stack[stack.length - 1] !== "{") {
        return null;
      }
      stack.pop();
      if (stack.length === 0) {
        return index + 1;
      }
      continue;
    }

    if (char === "]") {
      if (stack[stack.length - 1] !== "[") {
        return null;
      }
      stack.pop();
      if (stack.length === 0) {
        return index + 1;
      }
    }
  }

  return null;
}

function hasOnlySafeJsonSuffixNoise(suffix: string): boolean {
  return /^[\s)]*$/.test(suffix);
}

function extractBalancedJsonPrefix(input: string): string | null {
  if (!input || (input[0] !== "{" && input[0] !== "[")) {
    return null;
  }

  const balancedEnd = findBalancedJsonEnd(input);
  if (balancedEnd === null) {
    return null;
  }

  const suffix = input.slice(balancedEnd);
  if (!hasOnlySafeJsonSuffixNoise(suffix)) {
    return null;
  }

  return input.slice(0, balancedEnd);
}

function extractSingletonArrayElement(input: string): string | null {
  if (!input.startsWith("[")) {
    return null;
  }

  let valueStart = 1;
  while (valueStart < input.length && isJsonWhitespace(input[valueStart])) {
    valueStart++;
  }

  if (valueStart >= input.length || (input[valueStart] !== "{" && input[valueStart] !== "[")) {
    return null;
  }

  const valueEnd = findBalancedJsonEnd(input, valueStart);
  if (valueEnd === null) {
    return null;
  }

  const suffix = input.slice(valueEnd);
  if (!/^[\s\]]*$/.test(suffix)) {
    return null;
  }

  return input.slice(valueStart, valueEnd);
}

function extractJsonFromResponse(raw: string): string {
  // Try raw parse first
  const trimmed = raw.trim();
  const balancedTrimmed = extractBalancedJsonPrefix(trimmed);
  if (balancedTrimmed) return balancedTrimmed;

  const singletonArrayElement = extractSingletonArrayElement(trimmed);
  if (singletonArrayElement) return singletonArrayElement;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

  // Strip markdown code fences (handles both block and inline formats)
  // Inline: ```json {"entities":[...]}```
  // Block: ```json\n{"entities":[...]}\n```
  const cleaned = cleanMarkdownCodeBlock(trimmed);
  const balancedCleaned = extractBalancedJsonPrefix(cleaned);
  if (balancedCleaned) return balancedCleaned;

  const singletonCleanedArrayElement = extractSingletonArrayElement(cleaned);
  if (singletonCleanedArrayElement) return singletonCleanedArrayElement;

  if (cleaned.startsWith("{") || cleaned.startsWith("[")) return cleaned;

  // Fallback: regex for multi-line code blocks with extra text around them
  const fencePattern = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/;
  const fenceMatch = fencePattern.exec(trimmed);
  if (fenceMatch) {
    const fencedContent = fenceMatch[1].trim();
    return extractBalancedJsonPrefix(fencedContent)
      ?? extractSingletonArrayElement(fencedContent)
      ?? fencedContent;
  }

  // Last resort: find first { ... last }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function extractTextFromContentPart(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";

  const text = (part as { text?: unknown }).text;
  if (typeof text === "string") return text;

  const nestedContent = (part as { content?: unknown }).content;
  if (typeof nestedContent === "string") return nestedContent;

  return "";
}

function extractMessageContent(responseJson: any): string {
  const choice = responseJson?.choices?.[0];
  const message = choice?.message;
  const directContent = message?.content ?? choice?.text ?? responseJson?.output_text;

  if (typeof directContent === "string") return directContent.trim();

  if (Array.isArray(directContent)) {
    return directContent
      .map(extractTextFromContentPart)
      .join("")
      .trim();
  }

  if (directContent && typeof directContent === "object") {
    const text = extractTextFromContentPart(directContent);
    if (text) return text.trim();
  }

  const alternativeSegments = message?.tool_calls ?? message?.parts ?? responseJson?.content;
  if (Array.isArray(alternativeSegments)) {
    return alternativeSegments
      .map(extractTextFromContentPart)
      .join("")
      .trim();
  }

  return "";
}

function describeParsedRootShape(value: unknown): "array" | "object" | "primitive" {
  if (Array.isArray(value)) return "array";
  if (value && typeof value === "object") return "object";
  return "primitive";
}

function extractEntitiesArray(parsed: unknown): NerEntity[] | null {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const directEntities = (parsed as { entities?: unknown }).entities;
    return Array.isArray(directEntities) ? directEntities as NerEntity[] : null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const itemEntities = (item as { entities?: unknown }).entities;
    if (Array.isArray(itemEntities)) {
      return itemEntities as NerEntity[];
    }
  }

  return null;
}

// ── Offset validation & repair ───────────────────────────────────────

function validateAndRepairEntities(entities: NerEntity[], sourceText: string): NerEntity[] {
  const validated: NerEntity[] = [];

  for (const entity of entities) {
    if (!entity.text || !entity.type || typeof entity.start !== "number" || typeof entity.end !== "number") {
      continue;
    }

    const normalizedType = entity.type.toUpperCase();
    const entityLen = entity.text.length;

    // Strategy 1: exact match at declared offsets
    const sliceAtOffset = sourceText.slice(entity.start, entity.end);
    if (sliceAtOffset === entity.text) {
      validated.push({ text: entity.text, type: normalizedType, start: entity.start, end: entity.end });
      continue;
    }

    // Strategy 2: search nearby (±30 chars) for exact substring
    const searchStart = Math.max(0, entity.start - 30);
    const searchEnd = Math.min(sourceText.length, entity.end + 30);
    const nearbyWindow = sourceText.slice(searchStart, searchEnd);
    const nearbyIdx = nearbyWindow.indexOf(entity.text);
    if (nearbyIdx !== -1) {
      const repairedStart = searchStart + nearbyIdx;
      validated.push({ text: entity.text, type: normalizedType, start: repairedStart, end: repairedStart + entityLen });
      continue;
    }

    // Strategy 3: global search for first occurrence
    const globalIdx = sourceText.indexOf(entity.text);
    if (globalIdx !== -1) {
      validated.push({ text: entity.text, type: normalizedType, start: globalIdx, end: globalIdx + entityLen });
      continue;
    }

    // Discard: entity text not found in source
    Zotero.debug(`[NER] discarding entity "${entity.text}" — not found in source text`);
  }

  return validated;
}

// ── Core API call with retry ─────────────────────────────────────────

async function chatCompletion(messages: ChatMessage[], options: ExtractEntitiesOptions = {}): Promise<string> {
  const apiKey = getPref("apiKey");
  const baseURL = getPref("baseURL") || "https://openrouter.ai/api/v1";
  const model = getPref("model") || "z-ai/glm-4.5-air:free";
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const logPrefix = getLogPrefix(options.callerLabel);

  Zotero.debug(`${logPrefix} API Key configured: ${apiKey ? 'yes' : 'no'}, length: ${apiKey?.length ?? 0}`);
  Zotero.debug(`${logPrefix} Using baseURL: ${baseURL}, model: ${model}`);

  const url = `${baseURL.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const body = JSON.stringify({
    model,
    messages,
    enable_thinking: false,
    temperature: 0,
  });

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Use Zotero.HTTP.request to bypass CookieSandbox which strips
      // Authorization headers from regular fetch() calls.
      const xhr = await Zotero.HTTP.request("POST", url, {
        headers,
        body,
        responseType: "text",
        timeout: timeoutMs,
        successCodes: false, // Handle non-2xx responses manually
      });

      const status = xhr.status;
      const responseText = xhr.responseText;

      if (status < 200 || status >= 300) {
        const errClassification = classifyHttpError(status);
        lastError = new Error(`LLM API ${status}: ${responseText.slice(0, 200)}`);
        Zotero.debug(`${logPrefix} attempt ${attempt + 1}/${maxRetries} failed: ${lastError.message} (${errClassification.kind})`);

        if (!errClassification.retryable) {
          throw new NonRetryableLlmError(lastError.message);
        }

        // Exponential backoff with jitter before retry
        if (attempt < maxRetries - 1) {
          const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 500;
          await new Promise(resolve => setTimeout(resolve, backoff));
        }
        continue;
      }

      const trimmedResponseText = responseText.trim();
      if (!trimmedResponseText) {
        Zotero.debug(`${logPrefix} attempt ${attempt + 1}/${maxRetries}: successful response body was empty`);
        throw new EmptyLlmContentError();
      }

      const json = JSON.parse(trimmedResponseText);
      const content = extractMessageContent(json);
      if (!content) {
        Zotero.debug(`${logPrefix} attempt ${attempt + 1}/${maxRetries}: successful response had no usable content`);
        throw new EmptyLlmContentError();
      }
      return content;

    } catch (err: any) {
      if (!lastError || lastError.message !== err.message) {
        lastError = err;
        Zotero.debug(`${logPrefix} attempt ${attempt + 1}/${maxRetries}: ${err.message}`);
      }

      if (err instanceof EmptyLlmContentError) {
        throw err;
      }

      if (err instanceof NonRetryableLlmError) {
        throw err;
      }

      // Backoff before retry (unless it's a non-retryable error we already threw)
      if (attempt < maxRetries - 1) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 500;
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
  }

  throw lastError ?? new Error("LLM API failed after all retries");
}

// ── Public API ───────────────────────────────────────────────────────

export async function extractEntities(text: string, options: ExtractEntitiesOptions = {}): Promise<NerEntity[]> {
  if (!text.trim()) return [];

  const systemPrompt = getSystemPrompt();
  const logPrefix = getLogPrefix(options.callerLabel);

  const rawResponse = await chatCompletion([
    { role: "system", content: systemPrompt },
    { role: "user", content: text },
  ], options);

  Zotero.debug(`${logPrefix} raw LLM response (${rawResponse.length} chars): ${rawResponse.slice(0, 300)}`);

  const jsonStr = extractJsonFromResponse(rawResponse);
  Zotero.debug(`${logPrefix} cleaned JSON (${jsonStr.length} chars): ${jsonStr.slice(0, 300)}`);
  
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err: any) {
    throw new Error(`Failed to parse LLM JSON response. Raw: "${rawResponse.slice(0, 150)}" | Cleaned: "${jsonStr.slice(0, 150)}" | Error: ${err.message}`);
  }

  const rawEntities = extractEntitiesArray(parsed);
  if (!Array.isArray(rawEntities)) {
    throw new Error(`LLM response missing usable "entities" array (parsed root: ${describeParsedRootShape(parsed)})`);
  }

  const validated = validateAndRepairEntities(rawEntities, text);
  Zotero.debug(`${logPrefix} extracted ${validated.length} valid entities from ${rawEntities.length} raw`);
  return validated;
}
