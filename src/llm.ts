declare const Zotero: any;

import { DEFAULT_GLOBAL_SYSTEM_PROMPT, getCanonicalPref, getNonEmptyPreferenceValue, resolveSystemPromptPreference, type PreferenceKey } from "./preferences";
import type { ReadingHighlightCandidate, ReadingHighlightSpan } from "./reading-highlights";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequestOptions {
  timeoutMs?: number;
  maxRetries?: number;
  callerLabel?: string;
}

export interface SelectionHighlightPromptInput {
  selectionText: string;
  paperTitle?: string | null;
  sectionTitle?: string | null;
  beforeContext?: string;
  afterContext?: string;
}

interface SelectionHighlightResponse {
  highlights?: Array<{
    text?: unknown;
    start?: unknown;
    end?: unknown;
    reason?: unknown;
    confidence?: unknown;
  }>;
}

interface CandidateSelectionResponse {
  selectedIds?: unknown;
  selections?: Array<{
    id?: unknown;
    reason?: unknown;
  }>;
}

export interface GlobalHighlightSelection {
  id: string;
  reason?: string;
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

const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;
const GLOBAL_CANDIDATE_HARD_LIMIT = 150;

function getQuickHighlightSystemPrompt(): string {
  return resolveSystemPromptPreference(getPref("systemPrompt"));
}

function getGlobalRankingSystemPrompt(focusMode: string = 'balanced'): string {
  const storedOverride = getNonEmptyPreferenceValue(getPref("globalSystemPrompt"));
  if (storedOverride && storedOverride !== DEFAULT_GLOBAL_SYSTEM_PROMPT) {
    return storedOverride;
  }

  const focusGuidance: Record<string, string> = {
    'results-first': '\nFOCUS ADJUSTMENT\nGive extra weight to results, evidence, and quantitative outcomes when applying the rubric.',
    'methods-first': '\nFOCUS ADJUSTMENT\nGive extra weight to method details, design decisions, and technical contributions when applying the rubric.',
    'caveats-first': '\nFOCUS ADJUSTMENT\nGive extra weight to limitations, caveats, failure cases, and scope boundaries when applying the rubric.',
  };

  return DEFAULT_GLOBAL_SYSTEM_PROMPT + (focusGuidance[focusMode] || '');
}

function getLogPrefix(callerLabel?: string): string {
  return callerLabel ? `[Reading:${callerLabel}]` : "[Reading]";
}

function getPref(key: PreferenceKey): string {
  return getCanonicalPref(key);
}

function classifyHttpError(status: number): LlmErrorClassification {
  if (status === 429) return { kind: "rate_limit", retryable: true };
  if (status >= 500) return { kind: "server_error", retryable: true };
  return { kind: "client_error", retryable: false };
}

function cleanMarkdownCodeBlock(raw: string): string {
  let cleaned = raw.trim();

  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }

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
  const trimmed = raw.trim();
  const balancedTrimmed = extractBalancedJsonPrefix(trimmed);
  if (balancedTrimmed) return balancedTrimmed;

  const singletonArrayElement = extractSingletonArrayElement(trimmed);
  if (singletonArrayElement) return singletonArrayElement;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

  const cleaned = cleanMarkdownCodeBlock(trimmed);
  const balancedCleaned = extractBalancedJsonPrefix(cleaned);
  if (balancedCleaned) return balancedCleaned;

  const singletonCleanedArrayElement = extractSingletonArrayElement(cleaned);
  if (singletonCleanedArrayElement) return singletonCleanedArrayElement;

  if (cleaned.startsWith("{") || cleaned.startsWith("[")) return cleaned;

  const fencePattern = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/;
  const fenceMatch = fencePattern.exec(trimmed);
  if (fenceMatch) {
    const fencedContent = fenceMatch[1].trim();
    return extractBalancedJsonPrefix(fencedContent)
      ?? extractSingletonArrayElement(fencedContent)
      ?? fencedContent;
  }

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

async function chatCompletion(messages: ChatMessage[], options: LlmRequestOptions = {}): Promise<string> {
  const apiKey = getPref("apiKey");
  const baseURL = getPref("baseURL") || "https://openrouter.ai/api/v1";
  const model = getPref("model") || "meta-llama/llama-3.3-70b-instruct:free";
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const logPrefix = getLogPrefix(options.callerLabel);

  Zotero.debug(`${logPrefix} API Key configured: ${apiKey ? "yes" : "no"}, length: ${apiKey?.length ?? 0}`);
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
      const xhr = await Zotero.HTTP.request("POST", url, {
        headers,
        body,
        responseType: "text",
        timeout: timeoutMs,
        successCodes: false,
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

      if (attempt < maxRetries - 1) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 500;
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
  }

  throw lastError ?? new Error("LLM API failed after all retries");
}

async function requestJson<T>(messages: ChatMessage[], options: LlmRequestOptions = {}): Promise<T> {
  const rawResponse = await chatCompletion(messages, options);
  const logPrefix = getLogPrefix(options.callerLabel);
  Zotero.debug(`${logPrefix} raw LLM response (${rawResponse.length} chars): ${rawResponse.slice(0, 300)}`);

  const jsonStr = extractJsonFromResponse(rawResponse);
  Zotero.debug(`${logPrefix} cleaned JSON (${jsonStr.length} chars): ${jsonStr.slice(0, 300)}`);

  try {
    return JSON.parse(jsonStr) as T;
  } catch (err: any) {
    throw new Error(`Failed to parse LLM JSON response. Raw: "${rawResponse.slice(0, 150)}" | Cleaned: "${jsonStr.slice(0, 150)}" | Error: ${err.message}`);
  }
}

function coerceReadingHighlightSpans(response: SelectionHighlightResponse, sourceText: string): ReadingHighlightSpan[] {
  if (!Array.isArray(response?.highlights)) {
    return [];
  }

  return response.highlights.flatMap((highlight): ReadingHighlightSpan[] => {
    if (!highlight || typeof highlight !== "object") return [];
    if (typeof highlight.start !== "number" || typeof highlight.end !== "number") return [];

    const safeStart = Math.max(0, Math.min(highlight.start, sourceText.length));
    const safeEnd = Math.max(safeStart, Math.min(highlight.end, sourceText.length));
    let normalizedText = typeof highlight.text === "string" ? highlight.text : "";

    if (!normalizedText.trim() && safeEnd > safeStart) {
      normalizedText = sourceText.slice(safeStart, safeEnd);
    }

    if (!normalizedText.trim()) {
      return [];
    }

    return [{
      text: normalizedText,
      start: highlight.start,
      end: highlight.end,
      reason: typeof highlight.reason === "string" ? highlight.reason : undefined,
      confidence: typeof highlight.confidence === "number" ? highlight.confidence : undefined,
    }];
  });
}

function pushSelectionIfValid(
  orderedSelections: GlobalHighlightSelection[],
  seen: Set<string>,
  validIds: Set<string>,
  id: unknown,
  reason?: unknown
): void {
  if (typeof id !== "string") return;
  if (!validIds.has(id) || seen.has(id)) return;

  seen.add(id);
  orderedSelections.push({
    id,
    reason: typeof reason === "string" ? reason.trim() : undefined,
  });
}

function coerceSelectedHighlights(response: CandidateSelectionResponse, validIds: Set<string>): GlobalHighlightSelection[] {
  const orderedSelections: GlobalHighlightSelection[] = [];
  const seen = new Set<string>();

  if (Array.isArray(response?.selections)) {
    for (const selection of response.selections) {
      if (!selection || typeof selection !== "object") continue;
      pushSelectionIfValid(orderedSelections, seen, validIds, selection.id, selection.reason);
    }
    return orderedSelections;
  }

  if (!Array.isArray(response?.selectedIds)) {
    return [];
  }

  for (const value of response.selectedIds) {
    pushSelectionIfValid(orderedSelections, seen, validIds, value, "");
  }

  return orderedSelections;
}

function buildSelectionUserPrompt(input: SelectionHighlightPromptInput, maxHighlights: number = 3): string {
  const parts = [
    `paper_title: ${input.paperTitle?.trim() || "unknown"}`,
    `section_title: ${input.sectionTitle?.trim() || "unknown"}`,
    `before_context: ${input.beforeContext?.trim() || ""}`,
    `selection_text: ${input.selectionText}`,
    `after_context: ${input.afterContext?.trim() || ""}`,
    `Task: return up to ${maxHighlights} short worth-reading spans from selection_text only.`,
    "Rules: spans must stay strictly inside selection_text, be self-contained, avoid long blocks, and may return none.",
    "Return JSON only: {\"highlights\":[{\"text\":\"exact substring\",\"start\":0,\"end\":10,\"reason\":\"claim|result|method|caveat|background\",\"confidence\":0.0}]}."
  ];

  return parts.join("\n");
}

function buildGlobalRankingUserPrompt(candidates: ReadingHighlightCandidate[], maxHighlights: number, paperTitle?: string | null): string {
  const header = [
    `paper_title: ${paperTitle?.trim() || "unknown"}`,
    `selection_budget: up to ${maxHighlights}`,
    "Select the best highlights from these candidates according to the rubric.",
    "Return JSON only: {\"selections\":[{\"id\":\"P1-C1\",\"reason\":\"method\"}]}",
    "Candidates:"
  ].join("\n");

  const candidateLines = candidates
    .slice(0, GLOBAL_CANDIDATE_HARD_LIMIT)
    .map(candidate => `${candidate.id} | page=${candidate.pageIndex + 1} | section=${candidate.sectionTitle || candidate.sectionKind} | score=${candidate.heuristicScore} | text=${JSON.stringify(candidate.text)}`);

  return `${header}\n${candidateLines.join("\n")}`;
}

export async function extractSelectionHighlights(
  input: SelectionHighlightPromptInput,
  options: LlmRequestOptions = {},
  maxHighlights: number = 3
): Promise<ReadingHighlightSpan[]> {
  if (!input.selectionText.trim()) return [];

  const parsed = await requestJson<SelectionHighlightResponse>([
    { role: "system", content: getQuickHighlightSystemPrompt() },
    { role: "user", content: buildSelectionUserPrompt(input, maxHighlights) },
  ], options);

  return coerceReadingHighlightSpans(parsed, input.selectionText);
}

export async function selectGlobalHighlightCandidateIds(
  candidates: ReadingHighlightCandidate[],
  maxHighlights: number,
  paperTitle?: string | null,
  options: LlmRequestOptions = {},
  focusMode: string = 'balanced'
): Promise<GlobalHighlightSelection[]> {
  if (!candidates.length || maxHighlights <= 0) return [];

  const validIds = new Set(candidates.map(candidate => candidate.id));
  const parsed = await requestJson<CandidateSelectionResponse>([
    { role: "system", content: getGlobalRankingSystemPrompt(focusMode) },
    { role: "user", content: buildGlobalRankingUserPrompt(candidates, maxHighlights, paperTitle) },
  ], options);

  const result = coerceSelectedHighlights(parsed, validIds);
  Zotero.debug(`[SmartHighlight] Global selection raw response keys: ${Object.keys(parsed).join(', ')}`);
  Zotero.debug(`[SmartHighlight] Global selection parsed ${result.length} highlights with reasons: ${result.map(r => r.reason || '(none)').join(', ')}`);
  return result;
}
