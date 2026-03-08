declare const Zotero: any;
declare const cloneInto: ((value: any, targetScope: any, options?: any) => any) | undefined;

import { extractSelectionHighlights, selectGlobalHighlightCandidateIds } from "./llm";
import { computeSpanRects } from "./rect-splitter";
import {
    DEFAULT_GLOBAL_SYSTEM_PROMPT,
    DEFAULT_SYSTEM_PROMPT,
    PREF_DEFAULTS,
    PREF_PREFIX_MIGRATION_VERSION,
    getNonEmptyPreferenceValue,
    type PreferenceClearOutcome,
    type PreferenceBranchSnapshot,
    type PreferenceKey,
    clearCanonicalPref,
    clearLegacyDuplicatedPrefToDefaultEquivalent,
    getBranchSnapshot,
    getCanonicalPref,
    getCanonicalPrefKey,
    getCanonicalRawPref,
    getLegacyDuplicatedPrefKey,
    getPrefPrefixMigrationVersion,
    isBlankDefaultEquivalentPreferenceValue,
    getStoredGlobalSystemPromptOverride,
    getStoredSystemPromptOverride,
    normalizePreferenceValue,
    resolveGlobalSystemPromptPreference,
    resolveSystemPromptPreference,
    setCanonicalPref,
    setCanonicalPrefToDefaultEquivalent,
    setPrefPrefixMigrationVersion,
} from "./preferences";
import {
    extractSelectionHighlightsNonLlm,
    finalizeGlobalHighlightSelection,
    getQuickHighlightDefaults,
    inferSectionTitle,
    inferHighlightReason,
    prepareGlobalHighlightSelection,
    selectGlobalHighlightCandidateIdsNonLlm,
    validateQuickHighlightSpans,
    type PaperPageText,
    type PreparedGlobalHighlightSelection,
    type ReadingHighlightCandidate,
    type ReadingHighlightSpan,
    type RankedHighlightSelection,
} from "./reading-highlights";

export interface BootstrapData {
    id: string;
    version: string;
    resourceURI: string;
    rootURI: string;
}

let registeredHandler: ((event: any) => void) | null = null;
let toolbarHandler: ((event: any) => void) | null = null;
const selectionHighlightInFlight = new Map<string, Promise<void>>();
const READING_HIGHLIGHT_COLOR = '#ffd400';
const HIGHLIGHT_FAILURE_MESSAGE = 'Could not create reading highlights from this selection.';
const SELECTION_RECT_OVERLAP_TOLERANCE = 2;
const SELECTION_CHAR_WINDOW_PADDING = 24;
const SELECTION_HIGHLIGHT_REQUEST_TIMEOUT_MS = 30_000;
const SELECTION_HIGHLIGHT_REQUEST_ATTEMPTS = 1;
const SELECTION_GEOMETRY_TIMEOUT_MS = 5_000;
const POPUP_PAGE_BOOTSTRAP_TIMEOUT_MS = 750;
const SELECTION_CONTEXT_WINDOW_CHARS = 180;
const GLOBAL_HIGHLIGHT_REQUEST_TIMEOUT_MS = 45_000;
const GLOBAL_HIGHLIGHT_REQUEST_ATTEMPTS = 1;
const MATCH_SPACE_CHARACTERS = /[\s\u00A0\u1680\u180E\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/u;
const MATCH_ZERO_WIDTH_CHARACTERS = /[\u200B\u200C\u200D\u2060\uFEFF]/u;
const MATCH_OPENING_PUNCTUATION = new Set(['(', '[', '{']);
const MATCH_TIGHT_LEADING_PUNCTUATION = new Set([')', ']', '}', ',', '.', ';', ':', '!', '?']);

type PreferenceControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type HighlightBackend = 'llm' | 'non-llm';

interface HighlightBackendPolicy {
    mode: string;
    apiKeyConfigured: boolean;
    initialBackend: HighlightBackend;
    allowFallbackToNonLlm: boolean;
    reason: string;
}

function getHighlightColor(reason?: string): string {
    const normalizedReason = reason?.toLowerCase() || '';
    if (normalizedReason.includes('method')) return '#2ea8e5';
    if (normalizedReason.includes('background')) return '#5fb236';
    if (normalizedReason.includes('claim')) return '#ffd400';
    if (normalizedReason.includes('result')) return '#ff6666';
    if (normalizedReason.includes('caveat')) return '#f9a942';
    return '#ffd400';
}

function getHighlightBackendPolicy(): HighlightBackendPolicy {
    const mode = getCanonicalPref('backendMode');
    const apiKeyConfigured = getNonEmptyPreferenceValue(getCanonicalPref('apiKey')) !== null;

    if (mode === 'non-llm-only') {
        return {
            mode,
            apiKeyConfigured,
            initialBackend: 'non-llm',
            allowFallbackToNonLlm: false,
            reason: 'backend-mode-non-llm-only',
        };
    }

    if (!apiKeyConfigured) {
        return {
            mode,
            apiKeyConfigured,
            initialBackend: 'non-llm',
            allowFallbackToNonLlm: false,
            reason: 'missing-api-key',
        };
    }

    return {
        mode,
        apiKeyConfigured,
        initialBackend: 'llm',
        allowFallbackToNonLlm: true,
        reason: mode === 'llm-preferred' ? 'llm-preferred' : 'auto-with-api-key',
    };
}

function isTextareaPreferenceControl(control: Element): boolean {
    const tagName = control.tagName?.toLowerCase();
    return tagName === 'textarea' || tagName === 'html:textarea';
}

function setPreferenceControlValue(control: Element, value: string): void {
    const valueControl = control as PreferenceControl & { defaultValue?: string };
    valueControl.value = value;

    if (!isTextareaPreferenceControl(control)) {
        return;
    }

    valueControl.defaultValue = value;
    control.textContent = value;

    const view = control.ownerDocument?.defaultView;
    if (!view || typeof view.setTimeout !== 'function') {
        return;
    }

    view.setTimeout(() => {
        valueControl.value = value;
        valueControl.defaultValue = value;
        control.textContent = value;
    }, 0);
}

interface AsyncTimeoutOptions {
    timeoutMs?: number;
    timeoutLabel?: string;
    onTimeout?: () => void;
}

interface CharPositionExtractionOptions extends AsyncTimeoutOptions {
    includeSyntheticEOL?: boolean;
    allowUnsafeDefaultTextExtraction?: boolean;
    forcePageBootstrap?: boolean;
}

class AsyncStageTimeoutError extends Error {
    constructor(timeoutLabel: string, timeoutMs: number) {
        super(`${timeoutLabel} timed out after ${timeoutMs}ms`);
        this.name = 'AsyncStageTimeoutError';
    }
}

interface CharPosition {
    char: string;
    rect: number[];
}

interface NormalizedTextMap {
    text: string;
    normToRaw: number[];
    rawToNorm: number[];
    rawLength: number;
}

interface TextMatchResult {
    mode: 'exact' | 'normalized' | 'anchored';
    rawStart: number;
    rawOffsetBase: number;
    normalizedPageStart?: number;
    pageMap?: NormalizedTextMap;
    selectionMap?: NormalizedTextMap;
    anchorRange?: AnchorRange;
}

interface ReaderChar {
    c?: string;
    u?: string;
    rect: number[];
    inlineRect?: number[];
    rotation?: number;
    spaceAfter?: boolean;
    lineBreakAfter?: boolean;
    paragraphBreakAfter?: boolean;
}

interface InternalPageMatchResult {
    mode: 'exact' | 'normalized' | 'anchored';
    normalizedStart: number;
    selectionMap?: NormalizedTextMap;
    anchorRange?: AnchorRange;
}

interface AnchorRange {
    selectionStart: number;
    selectionEnd: number;
    pageStart: number;
    pageEnd: number;
}

interface LayeredSpanGeometry {
    layer: 1 | 2 | 3;
    rects: number[][];
    sortIndexOffset: number;
}

interface OffsetWindow {
    start: number;
    end: number;
}

interface ReaderInternalPageData {
    chars: ReaderChar[];
    pageText: string;
    charMapping: Array<number | undefined>;
    pageDiffs: number[][];
}

interface PopupGeometryDiagnostics {
    layer1CharsUnavailable: boolean;
    layer1CharsUnavailableReason: string | null;
    layer2SelectionMatchFailed: boolean;
    layer2SelectionMatchFailureReason: string | null;
}

interface PopupPageIndexResolution {
    pageIndex: number | null;
    debugMessage: string | null;
}

type SelectionPopupProgressStage = 'analyzing-selection' | 'preparing-geometry' | 'applying-highlights';

type SelectionPopupProgressHandler = (stage: SelectionPopupProgressStage) => void;

// ── Preferences ──────────────────────────────────────────────────────

const PREFERENCE_KEYS = Object.keys(PREF_DEFAULTS) as PreferenceKey[];

function registerPreferenceDefaults(): void {
    for (const [key, val] of Object.entries(PREF_DEFAULTS) as Array<[PreferenceKey, string]>) {
        if (getCanonicalRawPref(key) === undefined) {
            setCanonicalPref(key, val);
        }
    }
}

async function runHighlightBackendWithFallback<T>(
    label: 'selection' | 'global',
    runLlm: () => Promise<T>,
    runNonLlm: () => T | Promise<T>
): Promise<{ result: T; backend: HighlightBackend; usedFallback: boolean }> {
    const policy = getHighlightBackendPolicy();
    Zotero.debug(
        `[Zotero PDF Highlighter] ${label} backend policy: mode=${policy.mode}, apiKeyConfigured=${policy.apiKeyConfigured ? 'yes' : 'no'}, initial=${policy.initialBackend}, reason=${policy.reason}`
    );

    if (policy.initialBackend === 'non-llm') {
        return {
            result: await runNonLlm(),
            backend: 'non-llm',
            usedFallback: false,
        };
    }

    try {
        return {
            result: await runLlm(),
            backend: 'llm',
            usedFallback: false,
        };
    } catch (error: any) {
        if (!policy.allowFallbackToNonLlm) {
            throw error;
        }

        Zotero.debug(`[Zotero PDF Highlighter] ${label} LLM backend failed (${error?.message || error}); falling back to non-LLM`);
        return {
            result: await runNonLlm(),
            backend: 'non-llm',
            usedFallback: true,
        };
    }
}

// ── UI feedback helpers ──────────────────────────────────────────────

function setButtonState(button: any, text: string, disabled: boolean): void {
    button.textContent = text;
    button.disabled = disabled;
}

function attachToolbarButtonHoverState(button: any): void {
    button.addEventListener('mouseenter', () => {
        if (!button.disabled) {
            button.style.background = 'rgba(128,128,128,0.2)';
        }
    });

    button.addEventListener('mouseleave', () => {
        button.style.background = 'transparent';
    });
}

function showTemporaryButtonState(button: any, event: any, text: string, durationMs: number): void {
    setButtonState(button, text, true);

    const timerHost = event?.doc?.defaultView;
    if (timerHost && typeof timerHost.setTimeout === 'function') {
        timerHost.setTimeout(() => {
            setButtonState(button, 'Smart Highlight', false);
        }, durationMs);
        return;
    }

    setButtonState(button, 'Smart Highlight', false);
}

function formatPreferenceValueForLog(key: PreferenceKey, value: string | undefined): string {
    if (value === undefined) {
        return 'missing';
    }

    if (key === 'apiKey') {
        return value ? `[redacted len=${value.length}]` : 'default-empty';
    }

    const normalizedWhitespace = value.replace(/\s+/g, ' ').trim();
    const preview = normalizedWhitespace.length > 80
        ? `${normalizedWhitespace.slice(0, 80)}...`
        : normalizedWhitespace;

    return JSON.stringify(preview || value);
}

function resolveMigrationWinner(snapshot: PreferenceBranchSnapshot): {
    winnerSource: 'canonical' | 'legacy' | 'default';
    winnerValue: string | null;
    cleanupLegacy: boolean;
    reason: string;
} {
    const { canonicalState, legacyState, canonicalNormalized, legacyNormalized } = snapshot;

    if (canonicalState === 'missing' && legacyState === 'missing') {
        return {
            winnerSource: 'default',
            winnerValue: null,
            cleanupLegacy: true,
            reason: 'both-missing',
        };
    }

    if (canonicalState === 'non-default' && legacyState !== 'non-default') {
        return {
            winnerSource: 'canonical',
            winnerValue: canonicalNormalized,
            cleanupLegacy: true,
            reason: 'canonical-non-default',
        };
    }

    if (legacyState === 'non-default' && canonicalState !== 'non-default') {
        return {
            winnerSource: 'legacy',
            winnerValue: legacyNormalized,
            cleanupLegacy: true,
            reason: 'legacy-non-default',
        };
    }

    if (canonicalState !== 'non-default' && legacyState !== 'non-default') {
        return {
            winnerSource: 'canonical',
            winnerValue: null,
            cleanupLegacy: true,
            reason: 'both-default-equivalent',
        };
    }

    if (canonicalNormalized === legacyNormalized) {
        return {
            winnerSource: 'canonical',
            winnerValue: canonicalNormalized,
            cleanupLegacy: true,
            reason: 'both-non-default-equal',
        };
    }

    return {
        winnerSource: 'legacy',
        winnerValue: legacyNormalized,
        cleanupLegacy: true,
        reason: 'conflict-legacy-wins',
    };
}

function verifyCanonicalPreferenceState(key: PreferenceKey, expectedValue: string | null): void {
    const canonicalValue = getCanonicalRawPref(key);

    if (expectedValue === null) {
        const normalizedCanonicalValue = normalizePreferenceValue(key, canonicalValue);
        if (normalizedCanonicalValue !== null) {
            throw new Error(
                `Expected canonical ${key} to be default-equivalent, found ${formatPreferenceValueForLog(key, canonicalValue)}`
            );
        }
        return;
    }

    if (canonicalValue !== expectedValue) {
        throw new Error(
            `Expected canonical ${key}=${formatPreferenceValueForLog(key, expectedValue)}, found ${formatPreferenceValueForLog(key, canonicalValue)}`
        );
    }
}

function verifyLegacyPreferenceCleanupState(key: PreferenceKey, cleanupOutcome: PreferenceClearOutcome): void {
    const legacySnapshot = getBranchSnapshot(key);

    if (cleanupOutcome === 'cleared') {
        if (legacySnapshot.legacyState !== 'missing') {
            throw new Error(
                `Expected legacy ${key} to be missing after cleanup, found ${legacySnapshot.legacyState}:${formatPreferenceValueForLog(key, legacySnapshot.legacyRaw)}`
            );
        }
        return;
    }

    if (legacySnapshot.legacyState === 'non-default') {
        throw new Error(
            `Expected legacy ${key} to be default-equivalent after fallback cleanup, found ${formatPreferenceValueForLog(key, legacySnapshot.legacyRaw)}`
        );
    }
}

function migratePreferencePrefixIfNeeded(): void {
    const existingVersion = getPrefPrefixMigrationVersion();
    if (existingVersion === PREF_PREFIX_MIGRATION_VERSION) {
        Zotero.debug(`[Zotero PDF Highlighter] Preference prefix migration already complete (version ${existingVersion})`);
        return;
    }

    Zotero.debug('[Zotero PDF Highlighter] Starting preference prefix migration');

    const legacyKeysToClear: PreferenceKey[] = [];

    for (const key of PREFERENCE_KEYS) {
        const snapshot = getBranchSnapshot(key);
        const decision = resolveMigrationWinner(snapshot);

        Zotero.debug(
            `[Zotero PDF Highlighter] Pref migration ${key}: canonical=${snapshot.canonicalState}:${formatPreferenceValueForLog(key, snapshot.canonicalRaw)} `
            + `legacy=${snapshot.legacyState}:${formatPreferenceValueForLog(key, snapshot.legacyRaw)} `
            + `winner=${decision.winnerSource} reason=${decision.reason}`
        );

        if (decision.winnerValue === null) {
            setCanonicalPrefToDefaultEquivalent(key);
        } else {
            setCanonicalPref(key, decision.winnerValue);
        }

        verifyCanonicalPreferenceState(key, decision.winnerValue);

        if (decision.cleanupLegacy && snapshot.legacyRaw !== undefined) {
            legacyKeysToClear.push(key);
        }
    }

    for (const key of legacyKeysToClear) {
        const cleanupOutcome = clearLegacyDuplicatedPrefToDefaultEquivalent(key);
        verifyLegacyPreferenceCleanupState(key, cleanupOutcome);
    }

    setPrefPrefixMigrationVersion(PREF_PREFIX_MIGRATION_VERSION);

    const storedVersion = getPrefPrefixMigrationVersion();
    if (storedVersion !== PREF_PREFIX_MIGRATION_VERSION) {
        throw new Error(`Failed to persist pref migration marker: ${storedVersion ?? 'missing'}`);
    }

    Zotero.debug('[Zotero PDF Highlighter] Preference prefix migration complete');
}

function getSelectionPopupProgressText(stage: SelectionPopupProgressStage): string {
    switch (stage) {
        case 'analyzing-selection':
            return 'Analyzing...';
        case 'preparing-geometry':
            return 'Locating...';
        case 'applying-highlights':
            return 'Applying...';
    }
}

function setSelectionPopupProgress(button: any, stage: SelectionPopupProgressStage): void {
    setButtonState(button, getSelectionPopupProgressText(stage), true);
}

function notifyHighlightFailure(event: any, button: any): 'zotero.alert' | 'inline-hint' {
    if (typeof Zotero?.alert === 'function') {
        const hostWindow = event?.doc?.defaultView || Zotero?.getMainWindow?.();
        try {
            Zotero.alert(hostWindow, 'Zotero PDF Highlighter', HIGHLIGHT_FAILURE_MESSAGE);
            return 'zotero.alert';
        } catch {
            // Fallback handled below.
        }
    }

    Zotero.debug('[Zotero PDF Highlighter] highlight creation failed');
    showTemporaryButtonState(button, event, 'Failed', 1500);
    return 'inline-hint';
}

// ── Debug helper ─────────────────────────────────────────────────────

function summarizeResult(result: any): string {
    const MAX_STRING_PREVIEW = 80;

    if (result === null) return 'null';
    if (result === undefined) return 'undefined';

    const resultType = typeof result;
    if (resultType === 'string') {
        const isTruncated = result.length > MAX_STRING_PREVIEW;
        const preview = isTruncated ? `${result.slice(0, MAX_STRING_PREVIEW)}...` : result;
        return `string(len=${result.length}, preview=${JSON.stringify(preview)})`;
    }
    if (resultType === 'number' || resultType === 'boolean' || resultType === 'bigint') {
        return `${resultType}(${String(result)})`;
    }
    if (resultType === 'function') {
        return `function(${result.name || 'anonymous'})`;
    }

    const ctorName = result?.constructor?.name || 'Object';
    if (Array.isArray(result)) return `array(len=${result.length})`;
    if (resultType === 'object') return `object(type=${ctorName}, keys=${Object.keys(result).length})`;
    if (ctorName && ctorName !== 'Object') return `object(${ctorName})`;

    return `type(${resultType})`;
}

function getPrimaryView(reader: any): any {
    return reader?._internalReader?._primaryView ?? reader?._primaryView ?? null;
}

function getPdfViewerFromPrimaryView(primaryView: any): any {
    const iframeWindow = primaryView?._iframeWindow;
    return iframeWindow?.wrappedJSObject?.PDFViewerApplication?.pdfViewer ?? iframeWindow?.PDFViewerApplication?.pdfViewer ?? null;
}

function getCurrentPageChars(primaryView: any, pageIndex: number, pdfViewer?: any): ReaderChar[] | null {
    const refreshedChars = pdfViewer?._pages?.[pageIndex]?.chars;
    if (Array.isArray(refreshedChars) && refreshedChars.length) return refreshedChars;

    const primaryViewChars = primaryView?._pdfPages?.[pageIndex]?.chars;
    if (Array.isArray(primaryViewChars) && primaryViewChars.length) return primaryViewChars;

    return null;
}

function getReaderItemID(reader: any): string {
    const internal = reader?._internalReader;
    const itemID = reader?._itemID ?? internal?._itemID ?? reader?.itemID ?? internal?.itemID ?? reader?._item?.id;
    return itemID === undefined || itemID === null ? 'unknown-item' : String(itemID);
}

function getReaderAttachment(reader: any): any {
    const internal = reader?._internalReader;
    const itemID = reader?._itemID ?? internal?._itemID ?? reader?.itemID ?? internal?.itemID;
    if (itemID !== undefined && itemID !== null) {
        const attachment = Zotero.Items?.get?.(itemID);
        if (attachment) return attachment;
    }
    return reader?._item ?? null;
}

function getPaperTitle(reader: any): string | null {
    const attachment = getReaderAttachment(reader);
    const parentItem = typeof attachment?.parentItem === 'function'
        ? attachment.parentItem()
        : attachment?.parentItem ?? null;

    const title = parentItem?.getField?.('title')
        ?? attachment?.getField?.('title')
        ?? parentItem?.title
        ?? attachment?.title;

    return typeof title === 'string' && title.trim() ? title.trim() : null;
}

async function buildSelectionContext(reader: any, annotationBase: any, selectedText: string): Promise<{
    paperTitle: string | null;
    sectionTitle: string | null;
    beforeContext: string;
    afterContext: string;
}> {
    const paperTitle = getPaperTitle(reader);
    const popupPageIndex = resolvePopupPageIndex(reader, annotationBase);
    if (popupPageIndex.pageIndex === null) {
        return {
            paperTitle,
            sectionTitle: null,
            beforeContext: '',
            afterContext: '',
        };
    }

    const internal = reader?._internalReader || reader;
    const selectionRects = annotationBase.position?.rects ?? [];
    const charPositions = await getCharPositionsForPage(internal, popupPageIndex.pageIndex, {
        includeSyntheticEOL: true,
        allowUnsafeDefaultTextExtraction: false,
        timeoutMs: SELECTION_GEOMETRY_TIMEOUT_MS,
    });
    if (!charPositions.length) {
        return {
            paperTitle,
            sectionTitle: null,
            beforeContext: '',
            afterContext: '',
        };
    }

    const pageText = charPositions.map(position => position.char).join('');
    const selectionWindow = findSelectionCharWindow(charPositions, selectionRects);
    const selectionMatch = findTextMatch(
        pageText,
        selectedText,
        0,
        selectionWindow ? { start: selectionWindow.start, end: selectionWindow.end + 1 } : undefined
    );
    if (!selectionMatch) {
        return {
            paperTitle,
            sectionTitle: null,
            beforeContext: '',
            afterContext: '',
        };
    }

    const selectionStart = selectionMatch.rawStart;
    const selectionEnd = selectionStart + selectedText.length;
    return {
        paperTitle,
        sectionTitle: inferSectionTitle(pageText, selectionStart),
        beforeContext: pageText.slice(Math.max(0, selectionStart - SELECTION_CONTEXT_WINDOW_CHARS), selectionStart).trim(),
        afterContext: pageText.slice(selectionEnd, Math.min(pageText.length, selectionEnd + SELECTION_CONTEXT_WINDOW_CHARS)).trim(),
    };
}

async function awaitWithOptionalTimeout<T>(promise: Promise<T>, options: AsyncTimeoutOptions = {}): Promise<T> {
    const { timeoutMs, timeoutLabel = 'Async operation', onTimeout } = options;
    if (!timeoutMs || timeoutMs <= 0) return promise;

    let timeoutID: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timeoutID = setTimeout(() => {
                    onTimeout?.();
                    reject(new AsyncStageTimeoutError(timeoutLabel, timeoutMs));
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timeoutID !== undefined) {
            clearTimeout(timeoutID);
        }
    }
}

function getSelectionRequestKey(reader: any, annotationBase: any, selectedText: string): string {
    const pageIndex = annotationBase?.position?.pageIndex ?? 0;
    const sortIndex = annotationBase?.sortIndex ?? 'no-sort-index';
    const key = annotationBase?.key ?? 'no-annotation-key';
    const rects = Array.isArray(annotationBase?.position?.rects)
        ? JSON.stringify(annotationBase.position.rects)
        : '[]';
    return [getReaderItemID(reader), pageIndex, sortIndex, key, selectedText, rects].join('::');
}

function getAnnotationManagerScope(reader: any): any {
    const primaryView = getPrimaryView(reader);
    return primaryView?._iframeWindow ?? reader?._internalReader?._iframeWindow ?? reader?._iframeWindow ?? null;
}

function cloneAnnotationForReader(reader: any, annotation: any): any {
    const targetScope = getAnnotationManagerScope(reader);
    if (!targetScope || typeof cloneInto !== 'function') return annotation;

    try {
        return cloneInto(annotation, targetScope, { cloneFunctions: false, wrapReflectors: true });
    } catch (err: any) {
        Zotero.debug(`[Zotero PDF Highlighter] cloneInto failed, using original annotation: ${err?.message || err}`);
        return annotation;
    }
}

function cloneValueForScope<T>(value: T, targetScope: any): T {
    if (!targetScope || typeof cloneInto !== 'function') return value;

    try {
        return cloneInto(value, targetScope, { cloneFunctions: false, wrapReflectors: true });
    } catch {
        return value;
    }
}

function cloneAnnotationRects(rects: unknown): number[][] {
    if (!Array.isArray(rects)) return [];

    const safeRects: number[][] = [];
    for (const rect of rects) {
        const normalizedRect = normalizeRect(rect);
        if (!normalizedRect) continue;
        safeRects.push(normalizedRect.map(roundRectValue));
    }

    return safeRects;
}

function getSafeAnnotationTags(tags: unknown): string[] {
    if (!Array.isArray(tags)) return [];
    return tags.filter((tag): tag is string => typeof tag === 'string');
}

function getSafeAnnotationPayload(annotation: any): any {
    const safePayload: any = {
        key: typeof annotation?.key === 'string' && annotation.key.length
            ? annotation.key
            : Zotero.DataObjectUtilities?.generateKey?.() || Zotero.Utilities?.generateObjectKey?.() || `highlight_${Date.now()}`,
        type: typeof annotation?.type === 'string' && annotation.type.length ? annotation.type : 'highlight',
        color: typeof annotation?.color === 'string' && annotation.color.length ? annotation.color : READING_HIGHLIGHT_COLOR,
        text: typeof annotation?.text === 'string' ? annotation.text : '',
        comment: typeof annotation?.comment === 'string' ? annotation.comment : '',
        tags: getSafeAnnotationTags(annotation?.tags),
        position: {
            pageIndex: Number.isFinite(annotation?.position?.pageIndex) ? annotation.position.pageIndex : 0,
            rects: cloneAnnotationRects(annotation?.position?.rects),
        },
    };

    if (typeof annotation?.pageLabel === 'string' && annotation.pageLabel.length) {
        safePayload.pageLabel = annotation.pageLabel;
    }
    if (typeof annotation?.sortIndex === 'string' && annotation.sortIndex.length) {
        safePayload.sortIndex = annotation.sortIndex;
    }

    return safePayload;
}

function getSafeSelectionAnnotationSnapshot(annotation: any): any | null {
    if (!annotation?.position) return null;

    const safeSnapshot: any = {
        text: typeof annotation?.text === 'string' ? annotation.text : '',
        position: {
            pageIndex: Number.isFinite(annotation?.position?.pageIndex) ? annotation.position.pageIndex : 0,
            rects: cloneAnnotationRects(annotation?.position?.rects),
        },
    };

    if (typeof annotation?.key === 'string' && annotation.key.length) {
        safeSnapshot.key = annotation.key;
    }
    if (typeof annotation?.pageLabel === 'string' && annotation.pageLabel.length) {
        safeSnapshot.pageLabel = annotation.pageLabel;
    }
    if (typeof annotation?.sortIndex === 'string' && annotation.sortIndex.length) {
        safeSnapshot.sortIndex = annotation.sortIndex;
    }

    return safeSnapshot;
}

async function saveAnnotationJsonToAttachment(attachment: any, annotation: any): Promise<boolean> {
    if (!attachment || typeof Zotero.Annotations?.saveFromJSON !== 'function') return false;

    let result = Zotero.Annotations.saveFromJSON(attachment, getSafeAnnotationPayload(annotation));
    if (result && typeof result.then === 'function') result = await result;
    return result !== false;
}

async function addAnnotationViaManager(reader: any, mgr: any, annotation: any): Promise<boolean> {
    if (!mgr || typeof mgr.addAnnotation !== 'function') return false;

    const annotationForManager = cloneAnnotationForReader(reader, getSafeAnnotationPayload(annotation));
    let result = mgr.addAnnotation(annotationForManager);
    if (result && typeof result.then === 'function') result = await result;
    return result !== false && result !== null;
}

async function saveAnnotationViaJson(reader: any, annotation: any): Promise<boolean> {
    const attachment = getReaderAttachment(reader);
    return saveAnnotationJsonToAttachment(attachment, annotation);
}

function roundRectValue(value: number): number {
    return Number(value.toFixed(3));
}

function normalizeRect(rect?: number[] | null): number[] | null {
    if (!Array.isArray(rect) || rect.length < 4) return null;
    const [x1, y1, x2, y2] = rect;
    if (![x1, y1, x2, y2].every(value => Number.isFinite(value))) return null;
    return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

function getReaderCharInlineRect(char: ReaderChar | undefined): number[] | null {
    return normalizeRect(char?.inlineRect ?? char?.rect);
}

function getReaderCharHighlightRect(char: ReaderChar | undefined): number[] | null {
    const rect = normalizeRect(char?.rect);
    if (!rect) return null;

    const inlineRect = normalizeRect(char?.inlineRect);
    if (!inlineRect) return rect;

    const rotation = char?.rotation ?? 0;
    return rotation === 90 || rotation === 270
        ? [inlineRect[0], rect[1], inlineRect[2], rect[3]]
        : [rect[0], inlineRect[1], rect[2], inlineRect[3]];
}

function getRangeRectsFromReaderChars(chars: ReaderChar[], offsetStart: number, offsetEnd: number): number[][] {
    if (!chars.length || offsetStart < 0 || offsetEnd < offsetStart || offsetEnd >= chars.length) return [];

    const rects: number[][] = [];
    let rangeStart = offsetStart;

    for (let i = offsetStart; i <= offsetEnd; i++) {
        const char = chars[i];
        if (!char) return [];
        const isBreak = Boolean(char.lineBreakAfter) || i === offsetEnd;
        if (!isBreak) continue;

        const firstChar = chars[rangeStart];
        const lastChar = char;
        const firstRect = normalizeRect(firstChar?.rect);
        const lastRect = normalizeRect(lastChar?.rect);
        const firstInlineRect = getReaderCharInlineRect(firstChar);
        const lastInlineRect = getReaderCharInlineRect(lastChar);
        if (!firstRect || !lastRect || !firstInlineRect || !lastInlineRect) return [];

        const rotation = firstChar?.rotation ?? 0;
        const isVertical = rotation === 90 || rotation === 270;
        const rect = isVertical
            ? [firstInlineRect[0], firstRect[1], lastInlineRect[2], lastRect[3]]
            : [firstRect[0], firstInlineRect[1], lastRect[2], lastInlineRect[3]];

        rects.push(rect.map(roundRectValue));
        rangeStart = i + 1;
    }

    return rects;
}

function getSortIndexForRects(pageIndex: number, charOffset: number, rects: number[][]): string {
    const top = rects.length ? Math.floor(rects[0][1]) : 0;
    return [
        String(pageIndex).padStart(5, '0'),
        String(charOffset).padStart(6, '0'),
        String(top).padStart(5, '0'),
    ].join('|');
}

function getSpanFallbackSortIndex(annotationBase: any, pageIndex: number, spanOffset: number, rects: number[][]): string {
    const baseSortIndex = annotationBase?.sortIndex;
    const segments = typeof baseSortIndex === 'string' ? baseSortIndex.split('|') : [];
    const baseOffset = Number.parseInt(segments[1] ?? '', 10);
    if (Number.isFinite(baseOffset)) {
        return getSortIndexForRects(pageIndex, baseOffset + Math.max(0, spanOffset), rects);
    }

    return getSortIndexForRects(pageIndex, Math.max(0, spanOffset), rects);
}

function getDiffShiftAtOffset(pageDiffs: number[][], offset: number): number {
    if (!pageDiffs?.length) return 0;

    let low = 0;
    let high = pageDiffs.length - 1;
    let shift = 0;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const [diffOffset, diffShift] = pageDiffs[mid] ?? [];
        if (typeof diffOffset !== 'number' || typeof diffShift !== 'number') {
            high = mid - 1;
            continue;
        }
        if (diffOffset <= offset) {
            shift = diffShift;
            low = mid + 1;
            continue;
        }
        high = mid - 1;
    }

    return shift;
}

function getOriginalRangeFromNormalizedRange(pageDiffs: number[][], normalizedStart: number, normalizedEnd: number): { start: number; end: number } | null {
    if (normalizedEnd <= normalizedStart) return null;

    const startShift = getDiffShiftAtOffset(pageDiffs, normalizedStart);
    const endShift = getDiffShiftAtOffset(pageDiffs, normalizedEnd);
    const originalStart = normalizedStart - startShift;
    const originalEnd = normalizedEnd - endShift;
    if (originalEnd <= originalStart) return null;

    return { start: originalStart, end: originalEnd };
}

function findNearestCharIndex(charMapping: Array<number | undefined>, offset: number, direction: -1 | 1): number | null {
    if (!Array.isArray(charMapping) || !charMapping.length) return null;

    let cursor = Math.max(0, Math.min(offset, charMapping.length - 1));
    while (cursor >= 0 && cursor < charMapping.length) {
        const mappedIndex = charMapping[cursor];
        if (typeof mappedIndex === 'number') return mappedIndex;
        cursor += direction;
    }

    return null;
}

function clampOffsetWindow(start: number, end: number, upperBound: number): OffsetWindow | null {
    const safeUpperBound = Math.max(0, upperBound);
    const safeStart = Math.max(0, Math.min(start, safeUpperBound));
    const safeEnd = Math.max(0, Math.min(end, safeUpperBound));
    if (safeEnd <= safeStart) return null;
    return { start: safeStart, end: safeEnd };
}

function getWindowMatchDistance(matchStart: number, matchLength: number, preferredWindow?: OffsetWindow): { gap: number; centerDistance: number; startDistance: number } {
    if (!preferredWindow) {
        return {
            gap: 0,
            centerDistance: 0,
            startDistance: matchStart,
        };
    }

    const matchEnd = matchStart + matchLength;
    const overlaps = matchStart < preferredWindow.end && matchEnd > preferredWindow.start;
    const gap = overlaps
        ? 0
        : Math.min(Math.abs(matchEnd - preferredWindow.start), Math.abs(matchStart - preferredWindow.end));
    const matchCenter = matchStart + (matchLength / 2);
    const preferredCenter = preferredWindow.start + ((preferredWindow.end - preferredWindow.start) / 2);

    return {
        gap,
        centerDistance: Math.abs(matchCenter - preferredCenter),
        startDistance: Math.abs(matchStart - preferredWindow.start),
    };
}

function findBestSubstringStart(haystack: string, needle: string, preferredWindow?: OffsetWindow): number {
    if (!needle.length || !haystack.length || needle.length > haystack.length) return -1;

    let bestStart = -1;
    let bestScore: { gap: number; centerDistance: number; startDistance: number } | null = null;

    for (let fromIndex = 0; fromIndex <= haystack.length - needle.length;) {
        const matchStart = haystack.indexOf(needle, fromIndex);
        if (matchStart < 0) break;

        const score = getWindowMatchDistance(matchStart, needle.length, preferredWindow);
        if (
            !bestScore
            || score.gap < bestScore.gap
            || (score.gap === bestScore.gap && score.centerDistance < bestScore.centerDistance)
            || (score.gap === bestScore.gap && score.centerDistance === bestScore.centerDistance && score.startDistance < bestScore.startDistance)
            || (score.gap === bestScore.gap && score.centerDistance === bestScore.centerDistance && score.startDistance === bestScore.startDistance && matchStart < bestStart)
        ) {
            bestStart = matchStart;
            bestScore = score;
        }

        fromIndex = matchStart + 1;
    }

    return bestStart;
}

function collectSubstringStarts(haystack: string, needle: string, preferredWindow?: OffsetWindow, maxMatches = 24): number[] {
    if (!needle.length || !haystack.length || needle.length > haystack.length) return [];

    const matches: Array<{ start: number; score: { gap: number; centerDistance: number; startDistance: number } }> = [];
    for (let fromIndex = 0; fromIndex <= haystack.length - needle.length;) {
        const matchStart = haystack.indexOf(needle, fromIndex);
        if (matchStart < 0) break;

        matches.push({
            start: matchStart,
            score: getWindowMatchDistance(matchStart, needle.length, preferredWindow),
        });
        fromIndex = matchStart + 1;
    }

    matches.sort((left, right) => {
        if (left.score.gap !== right.score.gap) return left.score.gap - right.score.gap;
        if (left.score.centerDistance !== right.score.centerDistance) return left.score.centerDistance - right.score.centerDistance;
        if (left.score.startDistance !== right.score.startDistance) return left.score.startDistance - right.score.startDistance;
        return left.start - right.start;
    });

    return matches.slice(0, maxMatches).map(match => match.start);
}

function getStableAnchorLength(selectionLength: number): number {
    if (selectionLength < 24) return 0;
    return Math.min(48, Math.max(16, Math.floor(selectionLength / 6)));
}

function getAnchoredSelectionRange(pageMap: NormalizedTextMap, selectionMap: NormalizedTextMap, preferredWindow?: OffsetWindow): AnchorRange | null {
    const selectionText = selectionMap.text;
    const pageText = pageMap.text;
    const anchorLength = getStableAnchorLength(selectionText.length);
    if (!anchorLength || selectionText.length < anchorLength * 2 || !pageText.length) return null;

    const normalizedWindow = preferredWindow
        ? clampOffsetWindow(pageMap.rawToNorm[preferredWindow.start], pageMap.rawToNorm[preferredWindow.end], pageText.length)
        : null;

    const startAnchor = selectionText.slice(0, anchorLength);
    const endAnchorSelectionStart = selectionText.length - anchorLength;
    const endAnchor = selectionText.slice(endAnchorSelectionStart);
    const startCandidates = collectSubstringStarts(pageText, startAnchor, normalizedWindow ?? undefined);
    const endCandidates = collectSubstringStarts(pageText, endAnchor, normalizedWindow ?? undefined);
    if (!startCandidates.length || !endCandidates.length) return null;

    let bestRange: AnchorRange | null = null;
    let bestScore: { gap: number; spanDelta: number; centerDistance: number; startDistance: number } | null = null;

    for (const startCandidate of startCandidates) {
        for (const endCandidate of endCandidates) {
            const pageStart = startCandidate;
            const pageEnd = endCandidate + anchorLength;
            if (pageEnd <= pageStart) continue;

            const score = {
                ...getWindowMatchDistance(pageStart, pageEnd - pageStart, normalizedWindow ?? undefined),
                spanDelta: Math.abs((pageEnd - pageStart) - selectionText.length),
            };

            if (
                !bestScore
                || score.gap < bestScore.gap
                || (score.gap === bestScore.gap && score.spanDelta < bestScore.spanDelta)
                || (score.gap === bestScore.gap && score.spanDelta === bestScore.spanDelta && score.centerDistance < bestScore.centerDistance)
                || (score.gap === bestScore.gap && score.spanDelta === bestScore.spanDelta && score.centerDistance === bestScore.centerDistance && score.startDistance < bestScore.startDistance)
            ) {
                bestRange = {
                    selectionStart: 0,
                    selectionEnd: selectionText.length,
                    pageStart,
                    pageEnd,
                };
                bestScore = score;
            }
        }
    }

    if (!bestRange) return null;

    const minimumCoveredLength = Math.max(anchorLength * 2, Math.floor(selectionText.length * 0.6));
    if (bestRange.pageEnd - bestRange.pageStart < minimumCoveredLength) return null;

    return bestRange;
}

function mapNormalizedSelectionOffsetToPage(match: { mode: 'exact' | 'normalized' | 'anchored'; normalizedStart: number; anchorRange?: AnchorRange }, selectionOffset: number): number {
    if (match.mode !== 'anchored' || !match.anchorRange) {
        return match.normalizedStart + selectionOffset;
    }

    const { selectionStart, selectionEnd, pageStart, pageEnd } = match.anchorRange;
    if (selectionEnd <= selectionStart) return pageStart + selectionOffset;
    if (selectionOffset <= selectionStart) return pageStart - (selectionStart - selectionOffset);
    if (selectionOffset >= selectionEnd) return pageEnd + (selectionOffset - selectionEnd);

    const ratio = (selectionOffset - selectionStart) / (selectionEnd - selectionStart);
    return Math.round(pageStart + ((pageEnd - pageStart) * ratio));
}

function tryFindAnchoredSpanNormalizedRange(
    normalizedPageText: string,
    selectionMap: NormalizedTextMap,
    anchorRange: AnchorRange,
    spanText: string,
    spanStart: number,
    spanEnd: number,
    selectionLength: number
): { start: number; end: number } | null {
    const safeStart = Math.max(0, Math.min(spanStart, selectionLength));
    const safeEnd = Math.max(safeStart, Math.min(spanEnd, selectionLength));
    if (safeEnd <= safeStart || !normalizedPageText.length) return null;

    const normalizedSpanText = buildNormalizedTextMap(spanText).text;
    if (!normalizedSpanText.length) return null;

    const anchorWindow = clampOffsetWindow(anchorRange.pageStart, anchorRange.pageEnd, normalizedPageText.length);
    if (!anchorWindow) return null;

    const selectionNormalizedStart = selectionMap.rawToNorm[safeStart];
    const selectionNormalizedEnd = selectionMap.rawToNorm[safeEnd];
    const estimatedStart = mapNormalizedSelectionOffsetToPage({
        mode: 'anchored',
        normalizedStart: anchorRange.pageStart,
        anchorRange,
    }, selectionNormalizedStart);
    const estimatedEnd = mapNormalizedSelectionOffsetToPage({
        mode: 'anchored',
        normalizedStart: anchorRange.pageStart,
        anchorRange,
    }, selectionNormalizedEnd);

    const selectionSpanLength = Math.max(1, anchorRange.selectionEnd - anchorRange.selectionStart);
    const pageSpanLength = Math.max(1, anchorRange.pageEnd - anchorRange.pageStart);
    const driftAllowance = Math.max(
        normalizedSpanText.length,
        Math.abs(pageSpanLength - selectionSpanLength),
        8
    );
    const localWindow = clampOffsetWindow(
        estimatedStart - anchorWindow.start - driftAllowance,
        estimatedEnd - anchorWindow.start + driftAllowance,
        anchorWindow.end - anchorWindow.start
    );

    const anchoredPageText = normalizedPageText.slice(anchorWindow.start, anchorWindow.end);
    const anchoredSpanStart = findBestSubstringStart(anchoredPageText, normalizedSpanText, localWindow ?? undefined);
    if (anchoredSpanStart < 0) return null;

    const start = anchorWindow.start + anchoredSpanStart;
    return {
        start,
        end: start + normalizedSpanText.length,
    };
}

function findInternalPageMatch(pageText: string, selectionText: string, preferredWindow?: OffsetWindow): InternalPageMatchResult | null {
    const exactIdx = findBestSubstringStart(pageText, selectionText, preferredWindow);
    if (exactIdx >= 0) {
        return {
            mode: 'exact',
            normalizedStart: exactIdx,
        };
    }

    const pageMap = buildNormalizedTextMap(pageText);
    const selectionMap = buildNormalizedTextMap(selectionText);
    if (!pageMap.text.length || !selectionMap.text.length) return null;

    const normalizedWindow = preferredWindow
        ? clampOffsetWindow(pageMap.rawToNorm[preferredWindow.start], pageMap.rawToNorm[preferredWindow.end], pageMap.text.length)
        : null;
    const normalizedIdx = findBestSubstringStart(pageMap.text, selectionMap.text, normalizedWindow ?? undefined);
    if (normalizedIdx >= 0) {
        return {
            mode: 'normalized',
            normalizedStart: normalizedIdx,
            selectionMap,
        };
    }

    const anchorRange = getAnchoredSelectionRange(pageMap, selectionMap, preferredWindow);
    if (!anchorRange) return null;

    return {
        mode: 'anchored',
        normalizedStart: anchorRange.pageStart,
        selectionMap,
        anchorRange,
    };
}

function findSelectionReaderCharWindow(chars: ReaderChar[], selectionRects: number[][]): { start: number; end: number } | null {
    const canonicalSelectionRects = selectionRects
        .map(rect => toCanonicalRect(rect))
        .filter((rect): rect is number[] => !!rect);
    if (!canonicalSelectionRects.length || !chars.length) return null;

    let start = -1;
    let end = -1;

    for (let i = 0; i < chars.length; i++) {
        const charRect = getReaderCharInlineRect(chars[i]) ?? normalizeRect(chars[i]?.rect);
        if (!charRect) continue;
        const overlaps = canonicalSelectionRects.some(selRect =>
            rectsOverlap(charRect, selRect, SELECTION_RECT_OVERLAP_TOLERANCE)
        );
        if (!overlaps) continue;
        if (start === -1) start = i;
        end = i;
    }

    if (start < 0 || end < start) return null;
    return {
        start: Math.max(0, start - SELECTION_CHAR_WINDOW_PADDING),
        end: Math.min(chars.length - 1, end + SELECTION_CHAR_WINDOW_PADDING),
    };
}

function mapCharWindowToRawTextWindow(
    charMapping: Array<number | undefined>,
    pageTextLength: number,
    charWindow: { start: number; end: number } | null
): OffsetWindow | null {
    if (!charWindow || !Array.isArray(charMapping) || !charMapping.length || pageTextLength <= 0) return null;

    let rawStart = -1;
    let rawEndExclusive = -1;

    const limit = Math.min(charMapping.length, pageTextLength);
    for (let rawOffset = 0; rawOffset < limit; rawOffset++) {
        const mappedIndex = charMapping[rawOffset];
        if (typeof mappedIndex !== 'number') continue;
        if (mappedIndex < charWindow.start || mappedIndex > charWindow.end) continue;
        if (rawStart === -1) rawStart = rawOffset;
        rawEndExclusive = rawOffset + 1;
    }

    if (rawStart < 0 || rawEndExclusive <= rawStart) return null;
    return clampOffsetWindow(rawStart, rawEndExclusive, pageTextLength);
}

function mapSpanRangeToNormalizedPage(
    normalizedPageText: string,
    match: InternalPageMatchResult,
    spanText: string,
    spanStart: number,
    spanEnd: number,
    selectionLength: number
): { start: number; end: number } | null {
    const safeStart = Math.max(0, Math.min(spanStart, selectionLength));
    const safeEnd = Math.max(safeStart, Math.min(spanEnd, selectionLength));
    if (safeEnd <= safeStart) return null;

    if (match.mode === 'exact') {
        return {
            start: match.normalizedStart + safeStart,
            end: match.normalizedStart + safeEnd,
        };
    }

    const selectionMap = match.selectionMap;
    if (!selectionMap) return null;

    if (match.mode === 'anchored' && match.anchorRange) {
        const directSpanRange = tryFindAnchoredSpanNormalizedRange(
            normalizedPageText,
            selectionMap,
            match.anchorRange,
            spanText,
            safeStart,
            safeEnd,
            selectionLength
        );
        if (directSpanRange) return directSpanRange;
    }

    const mappedStart = mapNormalizedSelectionOffsetToPage(match, selectionMap.rawToNorm[safeStart]);
    let mappedEnd = mapNormalizedSelectionOffsetToPage(match, selectionMap.rawToNorm[safeEnd]);
    if (mappedEnd <= mappedStart) {
        mappedEnd = mappedStart + 1;
    }

    return {
        start: mappedStart,
        end: mappedEnd,
    };
}

async function getReaderInternalPageData(
    reader: any,
    pageIndex: number,
    timeoutOptions: AsyncTimeoutOptions = {},
    options: {
        allowPageBootstrap?: boolean;
        allowTextExtraction?: boolean;
        forcePageBootstrap?: boolean;
    } = {}
): Promise<ReaderInternalPageData | null> {
    const primaryView = getPrimaryView(reader);
    if (!primaryView) return null;

    const {
        allowPageBootstrap = true,
        allowTextExtraction = true,
        forcePageBootstrap = false,
    } = options;

    try {
        const pdfViewer = getPdfViewerFromPrimaryView(primaryView);

        if (allowPageBootstrap) {
            if (typeof primaryView._ensureBasicPageData === 'function') {
                await awaitWithOptionalTimeout(
                    primaryView._ensureBasicPageData(pageIndex),
                    {
                        ...timeoutOptions,
                        timeoutLabel: `Selection geometry page bootstrap for page ${pageIndex}`,
                    }
                );
            }

            const currentPageChars = getCurrentPageChars(primaryView, pageIndex, pdfViewer);
            if (allowTextExtraction && (forcePageBootstrap || !currentPageChars)) {
                if (pdfViewer?.pdfDocument?.getPageData) {
                    await awaitWithOptionalTimeout(
                        pdfViewer.pdfDocument.getPageData(getSafePageDataRequest(primaryView, pageIndex)),
                        {
                            ...timeoutOptions,
                            timeoutLabel: `Selection geometry getPageData bootstrap for page ${pageIndex}`,
                        }
                    );
                }
            }
        }
    } catch (err: any) {
        Zotero.debug(`[Zotero PDF Highlighter] Layer 1 ensure page data failed: ${err?.message || err}`);
        return null;
    }

    const chars = getCurrentPageChars(primaryView, pageIndex, getPdfViewerFromPrimaryView(primaryView));
    if (!Array.isArray(chars) || !chars.length) return null;

    const { pageText: rawText, charMapping } = reconstructPageTextAndMapping(chars);
    const normMap = buildNormalizedTextMap(rawText);
    const pageDiffs = buildPageDiffs(normMap);

    return {
        chars,
        pageText: normMap.text,
        charMapping,
        pageDiffs,
    };
}

// ── Single annotation creation (shared by NER + fallback) ────────────

async function createSingleHighlight(
    event: any,
    annotationBase: any,
    color: string,
    rects: number[][],
    text: string,
    preferredPath: 'manager' | 'save' = 'manager'
): Promise<boolean> {
    const reader = event?.reader;

    const fullAnnotation = {
        ...annotationBase,
        type: 'highlight',
        color,
        text,
        position: {
            ...annotationBase.position,
            rects,
        },
    };

    const highlightCreationPaths = preferredPath === 'save'
        ? ['save', 'manager'] as const
        : ['manager', 'save'] as const;

    for (const path of highlightCreationPaths) {
        if (path === 'manager') {
            try {
                const internal = reader?._internalReader;
                const mgr = internal?._annotationManager ?? internal?.annotationManager;
                if (await addAnnotationViaManager(reader, mgr, fullAnnotation)) return true;
            } catch (err: any) {
                Zotero.debug(`[Zotero PDF Highlighter] Path A failed: ${err?.message || err}`);
            }
            continue;
        }

        try {
            if (await saveAnnotationViaJson(reader, fullAnnotation)) return true;
        } catch (err: any) {
            Zotero.debug(`[Zotero PDF Highlighter] Path B failed: ${err?.message || err}`);
        }
    }

    // Path C: _onSetAnnotation
    try {
        const internal = reader?._internalReader;
        if (internal && typeof internal._onSetAnnotation === 'function') {
            let result = internal._onSetAnnotation(cloneAnnotationForReader(reader, getSafeAnnotationPayload(fullAnnotation)));
            if (result && typeof result.then === 'function') result = await result;
            if (result !== false) return true;
        }
    } catch (err: any) {
        Zotero.debug(`[Zotero PDF Highlighter] Path C failed: ${err?.message || err}`);
    }

    return false;
}

// ── Selection-only reading highlights ────────────────────────────────

async function createSelectionHighlightsFallback(
    reader: any,
    annotationBase: any,
    text: string,
    spans: ReadingHighlightSpan[]
): Promise<number> {
    let created = 0;
    const internal = reader?._internalReader || reader;
    const mgr = internal?._annotationManager;
    const baseRects = annotationBase.position?.rects ?? [];
    const popupPageIndex = resolvePopupPageIndex(reader, annotationBase);
    if (popupPageIndex.debugMessage) {
        Zotero.debug(`[Zotero PDF Highlighter] ${popupPageIndex.debugMessage}`);
    }
    if (popupPageIndex.pageIndex === null) {
        Zotero.debug('[Zotero PDF Highlighter] Popup final layer 3 fallback aborted: unresolved popup pageIndex would create unsafe highlights on page 0');
        return 0;
    }
    const pageIndex = popupPageIndex.pageIndex;

    // Get attachment for saveFromJSON - try multiple paths
    const itemID = reader?._itemID || internal?._itemID || reader?.itemID || internal?.itemID;
    let attachment = null;
    if (itemID) {
        try {
            attachment = await Zotero.Items.getAsync(itemID);
            Zotero.debug(`[Zotero PDF Highlighter] Fallback: Got attachment from itemID ${itemID}: ${!!attachment}`);
        } catch (e: any) {
            Zotero.debug(`[Zotero PDF Highlighter] Fallback: Failed to get attachment from itemID: ${e?.message}`);
        }
    }
    // Also try reader._item directly
    if (!attachment && reader?._item) {
        attachment = reader._item;
        Zotero.debug(`[Zotero PDF Highlighter] Fallback: Got attachment from reader._item: ${!!attachment}`);
    }
    if (!attachment) {
        Zotero.debug(`[Zotero PDF Highlighter] Fallback: No attachment found, itemID=${itemID}`);
    }

    for (const span of spans) {
        try {
            const rects = computeSpanRects(text, baseRects, span.start, span.end);
            if (rects.length === 0) continue;
            const reason = span.reason || inferHighlightReason(span.text);

            const annotationKey = Zotero.DataObjectUtilities?.generateKey?.()
                || Zotero.Utilities?.generateObjectKey?.()
                || `reading_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

            const annotationData = {
                key: annotationKey,
                type: 'highlight',
                color: getHighlightColor(reason),
                text: span.text,
                comment: reason ? `[${reason}]` : '',
                position: {
                    pageIndex: pageIndex,
                    rects: rects,
                },
                pageLabel: annotationBase.pageLabel || String(pageIndex + 1),
                sortIndex: getSpanFallbackSortIndex(annotationBase, pageIndex, span.start, rects),
                tags: [],
            };

            Zotero.debug('[Zotero PDF Highlighter] Creating selection reading highlight');

            if (attachment && typeof Zotero.Annotations?.saveFromJSON === 'function') {
                try {
                    if (await saveAnnotationJsonToAttachment(attachment, annotationData)) {
                        Zotero.debug(`[Zotero PDF Highlighter] Created selection highlight for "${span.text}" via saveFromJSON`);
                        created++;
                        refreshAnnotationView(internal);
                        continue;
                    }

                    Zotero.debug(`[Zotero PDF Highlighter] saveFromJSON returned false for selection highlight "${span.text}"`);
                } catch (saveErr: any) {
                    Zotero.debug(`[Zotero PDF Highlighter] saveFromJSON failed: ${saveErr?.message}`);
                }
            } else {
                Zotero.debug(`[Zotero PDF Highlighter] Selection fallback: Skipping saveFromJSON: attachment=${!!attachment}, saveFromJSON=${typeof Zotero.Annotations?.saveFromJSON}`);
            }

            if (mgr && typeof mgr.addAnnotation === 'function') {
                try {
                    if (await addAnnotationViaManager(reader, mgr, annotationData)) {
                        Zotero.debug(`[Zotero PDF Highlighter] Created selection highlight for "${span.text}" via addAnnotation`);
                        created++;
                        refreshAnnotationView(internal);
                        continue;
                    }
                } catch (mgrErr: any) {
                    Zotero.debug(`[Zotero PDF Highlighter] addAnnotation failed: ${mgrErr?.message}`);
                }
            }

            Zotero.debug(`[Zotero PDF Highlighter] All methods failed for "${span.text}"`);
        } catch (e: any) {
            Zotero.debug(`[Zotero PDF Highlighter] Selection fallback error for "${span.text}": ${e?.message}`);
        }
    }

    return created;
}

async function createSelectionHighlightsWithCharPositions(
    reader: any,
    annotationBase: any,
    text: string,
    spans: ReadingHighlightSpan[],
    onProgress?: SelectionPopupProgressHandler
): Promise<number> {
    let created = 0;
    let geometryTimedOut = false;
    const popupGeometryDiagnostics: PopupGeometryDiagnostics = {
        layer1CharsUnavailable: false,
        layer1CharsUnavailableReason: null,
        layer2SelectionMatchFailed: false,
        layer2SelectionMatchFailureReason: null,
    };

    const internal = reader?._internalReader || reader;
    const mgr = internal?._annotationManager;
    const popupPageIndex = resolvePopupPageIndex(reader, annotationBase);
    if (popupPageIndex.debugMessage) {
        Zotero.debug(`[Zotero PDF Highlighter] ${popupPageIndex.debugMessage}`);
    }
    if (popupPageIndex.pageIndex === null) {
        Zotero.debug('[Zotero PDF Highlighter] Popup final layer 3 fallback reason: popup pageIndex was unavailable for safe current-page geometry');
        return 0;
    }

    const pageIndex = popupPageIndex.pageIndex;
    const onGeometryTimeout = (): void => {
        geometryTimedOut = true;
    };

    // Get attachment for saveFromJSON - try multiple paths
    const itemID = reader?._itemID || internal?._itemID || reader?.itemID || internal?.itemID;
    let attachment = null;
    if (itemID) {
        try {
            attachment = await Zotero.Items.getAsync(itemID);
            Zotero.debug(`[Zotero PDF Highlighter] Got attachment from itemID ${itemID}: ${!!attachment}`);
        } catch (e: any) {
            Zotero.debug(`[Zotero PDF Highlighter] Failed to get attachment from itemID: ${e?.message}`);
        }
    }
    // Also try reader._item directly
    if (!attachment && reader?._item) {
        attachment = reader._item;
        Zotero.debug(`[Zotero PDF Highlighter] Got attachment from reader._item: ${!!attachment}`);
    }
    if (!attachment) {
        Zotero.debug(`[Zotero PDF Highlighter] No attachment found, itemID=${itemID}`);
    }

    const selectionRects = annotationBase.position?.rects ?? [];
    onProgress?.('preparing-geometry');

    const getValidatedInternalPageData = async (): Promise<ReaderInternalPageData | null> => {
        const firstAttempt = await getReaderInternalPageData(reader, pageIndex, {
            timeoutMs: POPUP_PAGE_BOOTSTRAP_TIMEOUT_MS,
            onTimeout: onGeometryTimeout,
        }, {
            allowPageBootstrap: true,
            allowTextExtraction: true,
        });
        if (!firstAttempt) return null;

        const firstSelectionCharWindow = selectionRects.length
            ? findSelectionReaderCharWindow(firstAttempt.chars, selectionRects)
            : null;
        const firstPreferredWindow = mapCharWindowToRawTextWindow(firstAttempt.charMapping, firstAttempt.pageText.length, firstSelectionCharWindow);
        if (findInternalPageMatch(firstAttempt.pageText, text, firstPreferredWindow ?? undefined)) {
            return firstAttempt;
        }

        logSelectionInPageFailure('Popup layer 1 current-page sanity check failed', text, firstAttempt.pageText);
        Zotero.debug('[Zotero PDF Highlighter] Popup layer 1 retrying bounded current-page refresh after stale current-page chars were detected');

        const refreshedAttempt = await getReaderInternalPageData(reader, pageIndex, {
            timeoutMs: POPUP_PAGE_BOOTSTRAP_TIMEOUT_MS,
            onTimeout: onGeometryTimeout,
        }, {
            allowPageBootstrap: true,
            allowTextExtraction: true,
            forcePageBootstrap: true,
        });
        if (!refreshedAttempt) return null;

        const refreshedSelectionCharWindow = selectionRects.length
            ? findSelectionReaderCharWindow(refreshedAttempt.chars, selectionRects)
            : null;
        const refreshedPreferredWindow = mapCharWindowToRawTextWindow(refreshedAttempt.charMapping, refreshedAttempt.pageText.length, refreshedSelectionCharWindow);
        if (findInternalPageMatch(refreshedAttempt.pageText, text, refreshedPreferredWindow ?? undefined)) {
            Zotero.debug('[Zotero PDF Highlighter] Popup layer 1 current-page refresh repaired stale page chars');
            return refreshedAttempt;
        }

        popupGeometryDiagnostics.layer1CharsUnavailable = true;
        popupGeometryDiagnostics.layer1CharsUnavailableReason = logSelectionInPageFailure('Popup layer 1 current-page sanity check still failed after refresh', text, refreshedAttempt.pageText);
        return null;
    };

    const internalPageData = await getValidatedInternalPageData();
    if (!internalPageData && !popupGeometryDiagnostics.layer1CharsUnavailable) {
        popupGeometryDiagnostics.layer1CharsUnavailable = true;
        popupGeometryDiagnostics.layer1CharsUnavailableReason = geometryTimedOut
            ? 'page bootstrap timed out before chars became available'
            : 'current-page chars were unavailable after bounded bootstrap';
        Zotero.debug(`[Zotero PDF Highlighter] Popup layer 1 skipped because page chars were unavailable: ${popupGeometryDiagnostics.layer1CharsUnavailableReason}`);
    }

    let charPositions: CharPosition[] = [];
    let layer2SelectionMatch: TextMatchResult | null = null;
    let layer2Attempted = false;

    const getLayer2SelectionMatchAttempt = async (forcePageBootstrap = false): Promise<TextMatchResult | null> => {
        charPositions = await getCharPositionsForPage(internal, pageIndex, {
            timeoutMs: SELECTION_GEOMETRY_TIMEOUT_MS,
            onTimeout: onGeometryTimeout,
            allowUnsafeDefaultTextExtraction: false,
            forcePageBootstrap,
        });
        if (!charPositions.length) {
            popupGeometryDiagnostics.layer2SelectionMatchFailed = true;
            popupGeometryDiagnostics.layer2SelectionMatchFailureReason = geometryTimedOut
                ? 'layer 2 text extraction timed out'
                : 'safe current-page text extraction produced no character positions';
            Zotero.debug(`[Zotero PDF Highlighter] Popup layer 2 selection matching failed: ${popupGeometryDiagnostics.layer2SelectionMatchFailureReason}`);
            return null;
        }

        const pageText = charPositions.map(cp => cp.char).join('');
        const selectionWindow = findSelectionCharWindow(charPositions, selectionRects);
        const selectionMatch = findTextMatch(
            pageText,
            text,
            0,
            selectionWindow ? { start: selectionWindow.start, end: selectionWindow.end + 1 } : undefined
        );
        if (!selectionMatch) {
            popupGeometryDiagnostics.layer2SelectionMatchFailed = true;
            popupGeometryDiagnostics.layer2SelectionMatchFailureReason = logSelectionInPageFailure('Popup layer 2 selection matching failed', text, pageText);
        }
        return selectionMatch;
    };

    const ensureLayer2SelectionMatch = async (): Promise<TextMatchResult | null> => {
        if (layer2Attempted) return layer2SelectionMatch;
        layer2Attempted = true;

        layer2SelectionMatch = await getLayer2SelectionMatchAttempt(false);
        if (!layer2SelectionMatch && !geometryTimedOut) {
            Zotero.debug('[Zotero PDF Highlighter] Popup layer 2 retrying bounded current-page refresh after stale current-page text was detected');
            layer2SelectionMatch = await getLayer2SelectionMatchAttempt(true);
            if (layer2SelectionMatch) {
                Zotero.debug('[Zotero PDF Highlighter] Popup layer 2 current-page refresh repaired stale page text');
            }
        }

        return layer2SelectionMatch;
    };

    if (!internalPageData) {
        Zotero.debug('[Zotero PDF Highlighter] Reader internal geometry not ready; using layer 2 geometry path');
        layer2SelectionMatch = await ensureLayer2SelectionMatch();
    }

    if (!internalPageData && !layer2SelectionMatch) {
        const layer3FallbackReason = geometryTimedOut
            ? 'selection geometry timed out before layer 1 or layer 2 resolved'
            : popupGeometryDiagnostics.layer2SelectionMatchFailureReason
                || popupGeometryDiagnostics.layer1CharsUnavailableReason
                || 'selection geometry was unavailable in both layer 1 and layer 2';
        Zotero.debug(`[Zotero PDF Highlighter] Popup final layer 3 fallback reason: ${layer3FallbackReason}`);
        return createSelectionHighlightsFallback(reader, annotationBase, text, spans);
    }

    onProgress?.('applying-highlights');
    for (const span of spans) {
        try {
            let layer1AttemptedForSpan = false;
            let layer1SpanGeometryFailed = false;
            let layer2AttemptedForSpan = false;
            let layer2SpanGeometryFailed = false;
            const reason = span.reason || inferHighlightReason(span.text);

            let geometry: LayeredSpanGeometry | null = null;

            if (internalPageData) {
                layer1AttemptedForSpan = true;
                geometry = getSpanGeometryFromReaderInternals(internalPageData, text, span.start, span.end, selectionRects);
                if (!geometry) {
                    layer1SpanGeometryFailed = true;
                    Zotero.debug(`[Zotero PDF Highlighter] Popup layer 1 attempted but span geometry failed for "${span.text}"`);
                }
            }

            if (!geometry && internalPageData) {
                layer2AttemptedForSpan = true;
                const fallbackSelectionMatch = await ensureLayer2SelectionMatch();
                geometry = getSpanGeometryFromCharPositions(fallbackSelectionMatch, charPositions, text, span.start, span.end);
                if (!geometry) {
                    layer2SpanGeometryFailed = true;
                    Zotero.debug(`[Zotero PDF Highlighter] Popup layer 2 span geometry failed for "${span.text}"`);
                }
            } else if (!geometry) {
                layer2AttemptedForSpan = true;
                geometry = getSpanGeometryFromCharPositions(layer2SelectionMatch, charPositions, text, span.start, span.end);
                if (!geometry) {
                    layer2SpanGeometryFailed = true;
                    Zotero.debug(`[Zotero PDF Highlighter] Popup layer 2 span geometry failed for "${span.text}"`);
                }
            }

            const mergedRects = geometry?.rects ?? computeSpanRects(text, annotationBase.position?.rects ?? [], span.start, span.end);

            if (!mergedRects.length) continue;

            if (geometry) {
                Zotero.debug(`[Zotero PDF Highlighter] Using layer ${geometry.layer} geometry for "${span.text}"`);
            } else {
                const layer3FallbackReason = geometryTimedOut
                    ? 'selection geometry timed out before span geometry resolved'
                    : layer2AttemptedForSpan && layer2SpanGeometryFailed
                        ? layer1AttemptedForSpan && layer1SpanGeometryFailed
                            ? 'layer 1 span geometry failed and layer 2 span geometry failed'
                            : 'layer 2 span geometry failed'
                        : layer1AttemptedForSpan && layer1SpanGeometryFailed
                            ? 'layer 1 span geometry failed'
                            : popupGeometryDiagnostics.layer2SelectionMatchFailureReason
                                || popupGeometryDiagnostics.layer1CharsUnavailableReason
                                || 'precise popup geometry was unavailable';
                Zotero.debug(`[Zotero PDF Highlighter] Popup final layer 3 fallback reason for "${span.text}": ${layer3FallbackReason}`);
                Zotero.debug(`[Zotero PDF Highlighter] Using layer 3 geometry for "${span.text}"`);
            }

            const annotationKey = Zotero.DataObjectUtilities?.generateKey?.()
                || Zotero.Utilities?.generateObjectKey?.()
                || `reading_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

            const annotationData = {
                key: annotationKey,
                type: 'highlight',
                color: getHighlightColor(reason),
                text: span.text,
                comment: reason ? `[${reason}]` : '',
                position: {
                    pageIndex: pageIndex,
                    rects: mergedRects,
                },
                pageLabel: annotationBase.pageLabel || String(pageIndex + 1),
                sortIndex: geometry
                    ? getSortIndexForRects(pageIndex, geometry.sortIndexOffset, mergedRects)
                    : getSpanFallbackSortIndex(annotationBase, pageIndex, span.start, mergedRects),
                tags: [],
            };

            if (attachment && typeof Zotero.Annotations?.saveFromJSON === 'function') {
                try {
                    if (await saveAnnotationJsonToAttachment(attachment, annotationData)) {
                        Zotero.debug(`[Zotero PDF Highlighter] Created selection highlight for "${span.text}" via saveFromJSON`);
                        created++;
                        refreshAnnotationView(internal);
                        continue;
                    }

                    Zotero.debug(`[Zotero PDF Highlighter] saveFromJSON returned false for selection highlight "${span.text}"`);
                } catch (saveErr: any) {
                    Zotero.debug(`[Zotero PDF Highlighter] saveFromJSON failed: ${saveErr?.message}`);
                }
            } else {
                Zotero.debug(`[Zotero PDF Highlighter] CharPositions: Skipping saveFromJSON: attachment=${!!attachment}, saveFromJSON=${typeof Zotero.Annotations?.saveFromJSON}`);
            }

            if (mgr && typeof mgr.addAnnotation === 'function') {
                try {
                    if (await addAnnotationViaManager(reader, mgr, annotationData)) {
                        Zotero.debug(`[Zotero PDF Highlighter] Created selection highlight for "${span.text}" via addAnnotation`);
                        created++;
                        refreshAnnotationView(internal);
                        continue;
                    }
                } catch (mgrErr: any) {
                    Zotero.debug(`[Zotero PDF Highlighter] addAnnotation failed: ${mgrErr?.message}`);
                }
            }

            Zotero.debug(`[Zotero PDF Highlighter] All methods failed for "${span.text}"`);
        } catch (e: any) {
            Zotero.debug(`[Zotero PDF Highlighter] CharPositions failed for "${span.text}": ${e?.message}`);
        }
    }

    return created;
}

async function createSelectionReadingHighlights(event: any, button: any): Promise<void> {
    const base = getSafeSelectionAnnotationSnapshot(event?.params?.annotation);
    if (!base?.position) {
        notifyHighlightFailure(event, button);
        return;
    }

    const selectedText: string = base.text || '';
    if (!selectedText.trim()) {
        notifyHighlightFailure(event, button);
        return;
    }

    const reader = event?.reader;
    const selectionRequestKey = getSelectionRequestKey(reader, base, selectedText);
    if (selectionHighlightInFlight.has(selectionRequestKey)) {
        Zotero.debug('[Zotero PDF Highlighter] Duplicate selection reading-highlight request ignored');
        showTemporaryButtonState(button, event, 'Already running', 1200);
        return;
    }

    const fullRects: number[][] = base.position.rects || [];
    if (fullRects.length === 0) {
        notifyHighlightFailure(event, button);
        return;
    }

    const requestPromise = (async () => {
        setSelectionPopupProgress(button, 'analyzing-selection');

        const density = getCanonicalPref('density');
        const lexicalMethod = getCanonicalPref('nonLlmLexicalMethod');
        const quickDefaults = getQuickHighlightDefaults(density);

        const selectionContext = await buildSelectionContext(reader, base, selectedText);
        let spans: ReadingHighlightSpan[];
        try {
            const backendResult = await runHighlightBackendWithFallback(
                'selection',
                async () => extractSelectionHighlights({
                    selectionText: selectedText,
                    paperTitle: selectionContext.paperTitle,
                    sectionTitle: selectionContext.sectionTitle,
                    beforeContext: selectionContext.beforeContext,
                    afterContext: selectionContext.afterContext,
                }, {
                    callerLabel: 'selection',
                    timeoutMs: SELECTION_HIGHLIGHT_REQUEST_TIMEOUT_MS,
                    maxRetries: SELECTION_HIGHLIGHT_REQUEST_ATTEMPTS,
                }, quickDefaults.maxHighlights),
                () => extractSelectionHighlightsNonLlm({
                    selectionText: selectedText,
                    paperTitle: selectionContext.paperTitle,
                    sectionTitle: selectionContext.sectionTitle,
                    beforeContext: selectionContext.beforeContext,
                    afterContext: selectionContext.afterContext,
                }, {
                    density,
                    lexicalMethod,
                })
            );
            spans = validateQuickHighlightSpans(backendResult.result, selectedText, density);
            Zotero.debug(`[Zotero PDF Highlighter] Selection highlights resolved via ${backendResult.backend}${backendResult.usedFallback ? ' fallback' : ''}`);
        } catch (err: any) {
            Zotero.debug(`[Zotero PDF Highlighter] Selection highlight extraction failed: ${err?.message || err}`);
            showTemporaryButtonState(button, event, 'No highlight', 1800);
            return;
        }

        if (spans.length === 0) {
            Zotero.debug('[Zotero PDF Highlighter] Selection mode returned no valid highlights');
            showTemporaryButtonState(button, event, 'No highlight', 1800);
            return;
        }

        Zotero.debug(`[Zotero PDF Highlighter] creating highlights for ${spans.length} reading spans`);

        const created = await createSelectionHighlightsWithCharPositions(
            reader,
            base,
            selectedText,
            spans,
            stage => setSelectionPopupProgress(button, stage)
        );
        const failCount = spans.length - created;
        if (failCount === 0) {
            showTemporaryButtonState(button, event, `Done (${created})`, 2000);
        } else if (created === 0) {
            notifyHighlightFailure(event, button);
        } else {
            showTemporaryButtonState(button, event, `⚠️ ${created}ok/${failCount}err`, 2500);
        }
    })();

    selectionHighlightInFlight.set(selectionRequestKey, requestPromise);
    try {
        await requestPromise;
    } finally {
        selectionHighlightInFlight.delete(selectionRequestKey);
    }
}

// ── Selection/text matching helpers ──────────────────────────────────
    
function reconstructPageTextAndMapping(chars: ReaderChar[]): { pageText: string; charMapping: Array<number | undefined> } {
    let pageText = '';
    const charMapping: Array<number | undefined> = [];

    for (let charIndex = 0; charIndex < chars.length; charIndex++) {
        const char = chars[charIndex];
        const str = char.u ?? char.c ?? '';

        for (let j = 0; j < str.length; j++) {
            charMapping.push(charIndex);
        }
        pageText += str;

        if (char.spaceAfter || char.lineBreakAfter || char.paragraphBreakAfter) {
            charMapping.push(charIndex);
            pageText += ' ';
        }
    }

    return { pageText, charMapping };
}

function buildPageDiffs(normMap: NormalizedTextMap): number[][] {
    const pageDiffs: number[][] = [];
    let lastShift = 0;
    
    for (let i = 0; i < normMap.text.length; i++) {
        const rawIdx = normMap.normToRaw[i];
        const shift = i - rawIdx;
        if (shift !== lastShift) {
            pageDiffs.push([i, shift]);
            lastShift = shift;
        }
    }
    
    return pageDiffs;
}

function normalizeCharForMatch(char: string): string {
    if (!char) return '';

    const normalized = char.normalize('NFKC');
    let output = '';

    for (const normalizedChar of normalized) {
        if (normalizedChar === '\u00AD' || MATCH_ZERO_WIDTH_CHARACTERS.test(normalizedChar)) continue;
        if (MATCH_SPACE_CHARACTERS.test(normalizedChar)) {
            output += ' ';
            continue;
        }
        if (normalizedChar === '\u2018' || normalizedChar === '\u2019') {
            output += "'";
            continue;
        }
        if (normalizedChar === '\u201C' || normalizedChar === '\u201D') {
            output += '"';
            continue;
        }
        output += normalizedChar;
    }

    return output;
}

function buildNormalizedTextMap(rawText: string): NormalizedTextMap {
    const normChars: string[] = [];
    const normToRaw: number[] = [];
    let hasOutput = false;
    let pendingSpaceRawIndex: number | null = null;

    const pushNormalizedChar = (normalizedChar: string, rawIndex: number): void => {
        normChars.push(normalizedChar);
        normToRaw.push(rawIndex);
        hasOutput = true;
    };

    const getLastNormalizedChar = (): string | null => {
        return normChars.length ? normChars[normChars.length - 1] : null;
    };

    for (let i = 0; i < rawText.length; i++) {
        const normalized = normalizeCharForMatch(rawText[i]);
        if (!normalized) continue;

        for (const normalizedChar of normalized) {
            if (normalizedChar === ' ') {
                if (hasOutput && pendingSpaceRawIndex === null) {
                    pendingSpaceRawIndex = i;
                }
                continue;
            }

            if (pendingSpaceRawIndex !== null) {
                const lastNormalizedChar = getLastNormalizedChar();
                const shouldKeepPendingSpace = Boolean(
                    hasOutput
                    && lastNormalizedChar
                    && !MATCH_OPENING_PUNCTUATION.has(lastNormalizedChar)
                    && !MATCH_TIGHT_LEADING_PUNCTUATION.has(normalizedChar)
                );
                if (shouldKeepPendingSpace) {
                    pushNormalizedChar(' ', pendingSpaceRawIndex);
                }
                pendingSpaceRawIndex = null;
            }

            pushNormalizedChar(normalizedChar, i);
        }
    }

    if (normChars.length > 0 && normChars[normChars.length - 1] === ' ') {
        normChars.pop();
        normToRaw.pop();
    }

    const rawToNorm = new Array(rawText.length + 1).fill(0);
    let normCursor = 0;
    for (let rawOffset = 0; rawOffset <= rawText.length; rawOffset++) {
        while (normCursor < normToRaw.length && normToRaw[normCursor] < rawOffset) {
            normCursor++;
        }
        rawToNorm[rawOffset] = normCursor;
    }

    return {
        text: normChars.join(''),
        normToRaw,
        rawToNorm,
        rawLength: rawText.length,
    };
}

function getSelectionInPageFailureReason(selectionText: string, pageText: string): string {
    const normalizedPageText = buildNormalizedTextMap(pageText).text;
    const normalizedSelectionText = buildNormalizedTextMap(selectionText).text;
    return `selection text was not found in current-page text (selection raw=${selectionText.length}, normalized=${normalizedSelectionText.length}; page raw=${pageText.length}, normalized=${normalizedPageText.length})`;
}

function logSelectionInPageFailure(prefix: string, selectionText: string, pageText: string): string {
    const failureReason = getSelectionInPageFailureReason(selectionText, pageText);
    Zotero.debug(`[Zotero PDF Highlighter] ${prefix}: ${failureReason}`);
    Zotero.debug(`[Zotero PDF Highlighter] ${prefix} selection preview: ${getMatchDebugPreview(buildNormalizedTextMap(selectionText).text)}`);
    Zotero.debug(`[Zotero PDF Highlighter] ${prefix} page preview: ${getMatchDebugPreview(buildNormalizedTextMap(pageText).text)}`);
    return failureReason;
}

function parseNumericPageLabel(pageLabel: unknown): number | null {
    if (typeof pageLabel !== 'string') return null;
    const trimmedPageLabel = pageLabel.trim();
    if (!trimmedPageLabel) return null;

    const parsedPageNumber = Number.parseInt(trimmedPageLabel, 10);
    if (!Number.isFinite(parsedPageNumber) || parsedPageNumber <= 0) return null;
    return parsedPageNumber - 1;
}

function getReaderCurrentPageIndex(reader: any): number | null {
    const primaryViewStatsPageIndex = reader?._internalReader?._state?.primaryViewStats?.pageIndex;
    if (Number.isFinite(primaryViewStatsPageIndex) && primaryViewStatsPageIndex >= 0) {
        return primaryViewStatsPageIndex;
    }

    const secondaryViewStatsPageIndex = reader?._internalReader?._state?.secondaryViewStats?.pageIndex;
    if (Number.isFinite(secondaryViewStatsPageIndex) && secondaryViewStatsPageIndex >= 0) {
        return secondaryViewStatsPageIndex;
    }

    const currentPageNumber = getPdfViewerFromPrimaryView(getPrimaryView(reader))?.currentPageNumber;
    if (Number.isFinite(currentPageNumber) && currentPageNumber > 0) {
        return currentPageNumber - 1;
    }

    return null;
}

function resolvePopupPageIndex(reader: any, annotationBase: any): PopupPageIndexResolution {
    const rawPageIndex = annotationBase?.position?.pageIndex;
    const pageLabelIndex = parseNumericPageLabel(annotationBase?.pageLabel);

    if (Number.isFinite(rawPageIndex) && rawPageIndex >= 0) {
        return {
            pageIndex: rawPageIndex,
            debugMessage: null,
        };
    }

    if (pageLabelIndex !== null) {
        return {
            pageIndex: pageLabelIndex,
            debugMessage: `Popup geometry pageIndex was missing or invalid; using numeric pageLabel=${JSON.stringify(annotationBase?.pageLabel)} -> pageIndex=${pageLabelIndex}`,
        };
    }

    const readerCurrentPageIndex = getReaderCurrentPageIndex(reader);
    if (readerCurrentPageIndex !== null) {
        return {
            pageIndex: readerCurrentPageIndex,
            debugMessage: `Popup geometry pageIndex was missing or invalid and pageLabel=${JSON.stringify(annotationBase?.pageLabel)} was not safely parseable; using current reader pageIndex=${readerCurrentPageIndex}`,
        };
    }

    return {
        pageIndex: null,
        debugMessage: `Popup geometry pageIndex was missing or invalid, pageLabel=${JSON.stringify(annotationBase?.pageLabel)} was not safely parseable, and current reader pageIndex was unavailable`,
    };
}

function normalizedBoundaryToRawOffset(map: NormalizedTextMap, boundary: number): number {
    if (map.text.length === 0) return 0;
    if (boundary <= 0) return map.normToRaw[0] ?? 0;
    if (boundary >= map.text.length) return map.rawLength;
    return map.normToRaw[boundary];
}

function getMatchDebugPreview(text: string, maxLength = 80): string {
    if (text.length <= maxLength) return JSON.stringify(text);
    return JSON.stringify(`${text.slice(0, maxLength)}...`);
}

function getSafePageDataRequest(primaryView: any, pageIndex: number): { pageIndex: number } {
    return cloneValueForScope({ pageIndex }, primaryView?._iframeWindow);
}

function findTextMatch(pageText: string, selectionText: string, rawOffsetBase = 0, preferredWindow?: OffsetWindow): TextMatchResult | null {
    const exactIdx = findBestSubstringStart(pageText, selectionText, preferredWindow);
    if (exactIdx >= 0) {
        return {
            mode: 'exact',
            rawStart: exactIdx,
            rawOffsetBase,
        };
    }

    const pageMap = buildNormalizedTextMap(pageText);
    const selectionMap = buildNormalizedTextMap(selectionText);
    if (!selectionMap.text.length || !pageMap.text.length) return null;

    const normalizedWindow = preferredWindow
        ? clampOffsetWindow(pageMap.rawToNorm[preferredWindow.start], pageMap.rawToNorm[preferredWindow.end], pageMap.text.length)
        : null;
    const normalizedIdx = findBestSubstringStart(pageMap.text, selectionMap.text, normalizedWindow ?? undefined);
    if (normalizedIdx >= 0) {
        const rawStart = normalizedBoundaryToRawOffset(pageMap, normalizedIdx);
        return {
            mode: 'normalized',
            rawStart,
            rawOffsetBase,
            normalizedPageStart: normalizedIdx,
            pageMap,
            selectionMap,
        };
    }

    const anchorRange = getAnchoredSelectionRange(pageMap, selectionMap, preferredWindow);
    if (!anchorRange) return null;

    const rawStart = normalizedBoundaryToRawOffset(pageMap, anchorRange.pageStart);
    return {
        mode: 'anchored',
        rawStart,
        rawOffsetBase,
        normalizedPageStart: anchorRange.pageStart,
        pageMap,
        selectionMap,
        anchorRange,
    };
}

function toCanonicalRect(rect: number[]): number[] | null {
    if (!Array.isArray(rect) || rect.length < 4) return null;
    const [ax, ay, bx, by] = rect;
    if (![ax, ay, bx, by].every(v => Number.isFinite(v))) return null;
    const x1 = Math.min(ax, bx);
    const y1 = Math.min(ay, by);
    const x2 = Math.max(ax, bx);
    const y2 = Math.max(ay, by);
    if (x2 - x1 <= 0.1 || y2 - y1 <= 0.1) return null;
    return [x1, y1, x2, y2];
}

function rectsOverlap(rectA: number[], rectB: number[], tolerance = 0): boolean {
    return !(
        rectA[0] > rectB[2] + tolerance
        || rectA[2] < rectB[0] - tolerance
        || rectA[1] > rectB[3] + tolerance
        || rectA[3] < rectB[1] - tolerance
    );
}

function findSelectionCharWindow(charPositions: CharPosition[], selectionRects: number[][]): { start: number; end: number } | null {
    const canonicalSelectionRects = selectionRects
        .map(rect => toCanonicalRect(rect))
        .filter((rect): rect is number[] => !!rect);
    if (!canonicalSelectionRects.length || !charPositions.length) return null;

    let start = -1;
    let end = -1;

    for (let i = 0; i < charPositions.length; i++) {
        const charRect = toCanonicalRect(charPositions[i].rect);
        if (!charRect) continue;
        const overlaps = canonicalSelectionRects.some(selRect =>
            rectsOverlap(charRect, selRect, SELECTION_RECT_OVERLAP_TOLERANCE)
        );
        if (!overlaps) continue;
        if (start === -1) start = i;
        end = i;
    }

    if (start < 0 || end < start) return null;
    return {
        start: Math.max(0, start - SELECTION_CHAR_WINDOW_PADDING),
        end: Math.min(charPositions.length - 1, end + SELECTION_CHAR_WINDOW_PADDING),
    };
}

function mapSpanRangeToPage(
    match: TextMatchResult,
    spanText: string,
    spanStart: number,
    spanEnd: number,
    selectionLength: number
): { start: number; end: number } | null {
    const safeStart = Math.max(0, Math.min(spanStart, selectionLength));
    const safeEnd = Math.max(safeStart, Math.min(spanEnd, selectionLength));
    if (safeEnd <= safeStart) return null;

    if (match.mode === 'exact') {
        return {
            start: match.rawOffsetBase + match.rawStart + safeStart,
            end: match.rawOffsetBase + match.rawStart + safeEnd,
        };
    }

    const pageMap = match.pageMap;
    const selectionMap = match.selectionMap;
    const normalizedPageStart = match.normalizedPageStart;
    if (!pageMap || !selectionMap || normalizedPageStart === undefined) return null;

    if (match.mode === 'anchored' && match.anchorRange) {
        const directSpanRange = tryFindAnchoredSpanNormalizedRange(
            pageMap.text,
            selectionMap,
            match.anchorRange,
            spanText,
            safeStart,
            safeEnd,
            selectionLength
        );
        if (directSpanRange) {
            const mappedStart = match.rawOffsetBase + normalizedBoundaryToRawOffset(pageMap, directSpanRange.start);
            let mappedEnd = match.rawOffsetBase + normalizedBoundaryToRawOffset(pageMap, directSpanRange.end);
            if (mappedEnd <= mappedStart) {
                mappedEnd = mappedStart + 1;
            }
            return { start: mappedStart, end: mappedEnd };
        }
    }

    const normalizedStart = selectionMap.rawToNorm[safeStart];
    const normalizedEnd = selectionMap.rawToNorm[safeEnd];
    const pageNormalizedStart = mapNormalizedSelectionOffsetToPage({
        mode: match.mode,
        normalizedStart: normalizedPageStart,
        anchorRange: match.anchorRange,
    }, normalizedStart);
    const pageNormalizedEnd = mapNormalizedSelectionOffsetToPage({
        mode: match.mode,
        normalizedStart: normalizedPageStart,
        anchorRange: match.anchorRange,
    }, normalizedEnd);

    const mappedStart = match.rawOffsetBase + normalizedBoundaryToRawOffset(pageMap, pageNormalizedStart);
    let mappedEnd = match.rawOffsetBase + normalizedBoundaryToRawOffset(pageMap, pageNormalizedEnd);
    if (mappedEnd <= mappedStart) {
        mappedEnd = mappedStart + 1;
    }

    return { start: mappedStart, end: mappedEnd };
}

function getSpanGeometryFromReaderInternals(
    pageData: ReaderInternalPageData,
    selectionText: string,
    spanStart: number,
    spanEnd: number,
    selectionRects?: number[][]
): LayeredSpanGeometry | null {
    const selectionCharWindow = selectionRects?.length
        ? findSelectionReaderCharWindow(pageData.chars, selectionRects)
        : null;
    const preferredWindow = mapCharWindowToRawTextWindow(pageData.charMapping, pageData.pageText.length, selectionCharWindow);
    const selectionMatch = findInternalPageMatch(pageData.pageText, selectionText, preferredWindow ?? undefined);
    if (!selectionMatch) return null;

    const normalizedRange = mapSpanRangeToNormalizedPage(
        pageData.pageText,
        selectionMatch,
        selectionText.slice(spanStart, spanEnd),
        spanStart,
        spanEnd,
        selectionText.length
    );
    if (!normalizedRange) return null;

    const originalRange = getOriginalRangeFromNormalizedRange(pageData.pageDiffs, normalizedRange.start, normalizedRange.end);
    if (!originalRange) return null;

    const charStart = findNearestCharIndex(pageData.charMapping, originalRange.start, 1);
    const charEnd = findNearestCharIndex(pageData.charMapping, originalRange.end - 1, -1);
    if (charStart === null || charEnd === null || charEnd < charStart) return null;

    const rects = getRangeRectsFromReaderChars(pageData.chars, charStart, charEnd);
    if (!rects.length) return null;

    return {
        layer: 1,
        rects,
        sortIndexOffset: charStart,
    };
}

function getSpanGeometryFromCharPositions(
    selectionMatch: TextMatchResult | null,
    charPositions: CharPosition[],
    selectionText: string,
    spanStart: number,
    spanEnd: number
): LayeredSpanGeometry | null {
    if (!selectionMatch || !charPositions.length) return null;

    const mappedRange = mapSpanRangeToPage(
        selectionMatch,
        selectionText.slice(spanStart, spanEnd),
        spanStart,
        spanEnd,
        selectionText.length
    );
    if (!mappedRange) return null;

    const spanStartInPage = Math.max(0, Math.min(mappedRange.start, charPositions.length));
    const spanEndInPage = Math.max(spanStartInPage, Math.min(mappedRange.end, charPositions.length));
    const spanRects: number[][] = [];

    for (let i = spanStartInPage; i < spanEndInPage; i++) {
        const charPosition = charPositions[i];
        if (charPosition.rect[2] - charPosition.rect[0] <= 0.1) continue;
        spanRects.push(charPosition.rect);
    }

    if (!spanRects.length) return null;

    return {
        layer: 2,
        rects: mergeAdjacentRects(spanRects),
        sortIndexOffset: spanStartInPage,
    };
}

// ── Rect merging for character-level positions ──────────────────────

function mergeAdjacentRects(rects: number[][]): number[][] {
    if (rects.length === 0) return [];
    if (rects.length === 1) return rects;

    const merged: number[][] = [];
    let current = [...rects[0]];

    for (let i = 1; i < rects.length; i++) {
        const next = rects[i];
        // Check if same line (similar y values, within tolerance)
        const sameY = Math.abs(current[1] - next[1]) < 5 && Math.abs(current[3] - next[3]) < 5;
        // Check if adjacent (next x1 is close to current x2)
        const adjacent = Math.abs(next[0] - current[2]) < 10;

        if (sameY && adjacent) {
            // Merge: extend current rect
            current[2] = next[2]; // extend x2
        } else {
            // Different line or gap: save current and start new
            merged.push(current);
            current = [...next];
        }
    }
    merged.push(current);

    return merged;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function getUsablePdfJsTransform(transform: unknown): number[] | null {
    if (!Array.isArray(transform) || transform.length < 6) return null;
    return transform.every(value => isFiniteNumber(value)) ? transform : null;
}

function getUsablePdfJsItemHeight(item: any, transform: number[]): number | null {
    const height = isFiniteNumber(item?.height) && item.height > 0
        ? item.height
        : Math.abs(transform[3]);
    return height > 0 ? height : null;
}

function hasUsablePdfJsCharGeometry(item: any): boolean {
    if (typeof item?.str !== 'string' || item.str.length === 0) return true;
    if (!Array.isArray(item.chars) || item.chars.length !== item.str.length) return false;

    const itemTransform = getUsablePdfJsTransform(item.transform);
    if (!itemTransform) return false;

    const itemHeight = getUsablePdfJsItemHeight(item, itemTransform);
    if (!itemHeight) return false;

    const itemWidth = isFiniteNumber(item.width) && item.width > 0 ? item.width : null;
    const fallbackCharWidth = itemWidth ? itemWidth / item.str.length : null;
    if (!fallbackCharWidth || fallbackCharWidth <= 0) return false;

    return item.chars.every((charInfo: any) => {
        if (!charInfo || typeof charInfo !== 'object') return false;

        const charTransform = getUsablePdfJsTransform(charInfo.transform) ?? itemTransform;
        if (!charTransform) return false;
        if (!isFiniteNumber(charTransform[4]) || !isFiniteNumber(itemTransform[5])) return false;

        const charWidth = isFiniteNumber(charInfo.width) && charInfo.width > 0
            ? charInfo.width
            : fallbackCharWidth;
        return isFiniteNumber(charWidth) && charWidth > 0;
    });
}

// ── Character position extraction from PDF.js ───────────────────────

async function getCharPositionsForPage(
    internal: any,
    pageIndex: number,
    options: CharPositionExtractionOptions = {}
): Promise<CharPosition[]> {
    const charPositions: CharPosition[] = [];
    const {
        includeSyntheticEOL = true,
        allowUnsafeDefaultTextExtraction = true,
        forcePageBootstrap = false,
        ...timeoutOptions
    } = options;

    try {
        const primaryView = internal?._primaryView;
        let chars = primaryView?._pdfPages?.[pageIndex]?.chars;

        if (!chars || forcePageBootstrap) {
            if (typeof primaryView?._ensureBasicPageData === 'function') {
                try {
                    await awaitWithOptionalTimeout(
                        primaryView._ensureBasicPageData(pageIndex),
                        {
                            ...timeoutOptions,
                            timeoutLabel: `Layer 2 page bootstrap for page ${pageIndex}`,
                        }
                    );
                    chars = primaryView?._pdfPages?.[pageIndex]?.chars;
                } catch (e: any) {
                    Zotero.debug(`[Zotero PDF Highlighter] Layer 2 page bootstrap failed: ${e?.message || e}`);
                }
            }

            if (!chars || forcePageBootstrap) {
                const iframeWindow = primaryView?._iframeWindow;
                const pdfViewer = iframeWindow?.wrappedJSObject?.PDFViewerApplication?.pdfViewer || iframeWindow?.PDFViewerApplication?.pdfViewer;
                if (pdfViewer?.pdfDocument?.getPageData) {
                    try {
                        await awaitWithOptionalTimeout(
                            pdfViewer.pdfDocument.getPageData(getSafePageDataRequest(primaryView, pageIndex)),
                            {
                                ...timeoutOptions,
                                timeoutLabel: `Layer 2 getPageData for page ${pageIndex}`,
                            }
                        );
                        chars = pdfViewer?._pages?.[pageIndex]?.chars;
                    } catch (e: any) {
                        Zotero.debug(`[Zotero PDF Highlighter] Layer 2 getPageData failed: ${e?.message || e}`);
                    }
                }
            }
        }

        if (chars && Array.isArray(chars) && chars.length > 0) {
            for (let i = 0; i < chars.length; i++) {
                const char = chars[i];
                const str = char.u ?? char.c ?? '';
                const rect = getReaderCharHighlightRect(char) || [0, 0, 0, 0];

                for (let j = 0; j < str.length; j++) {
                    charPositions.push({
                        char: str[j],
                        rect,
                    });
                }

                if (char.spaceAfter || char.lineBreakAfter || char.paragraphBreakAfter) {
                    const separator = (includeSyntheticEOL && (char.lineBreakAfter || char.paragraphBreakAfter)) ? '\n' : ' ';
                    charPositions.push({
                        char: separator,
                        rect: [0, 0, 0, 0],
                    });
                }
            }
            return charPositions;
        }

        const iframeWindow = primaryView?._iframeWindow;
        const plainPdfPages = iframeWindow?.PDFViewerApplication?.pdfViewer?._pages;
        const plainPdfPage = plainPdfPages?.[pageIndex]?.pdfPage || null;
        if (!plainPdfPage) return charPositions;

        if (!allowUnsafeDefaultTextExtraction) {
            Zotero.debug('[Zotero PDF Highlighter] Popup layer-2 skipped unsafe default text extraction; falling back to layer 3 geometry');
            return charPositions;
        }

        const textContent = await awaitWithOptionalTimeout<any>(
            plainPdfPage.getTextContent(),
            {
                ...timeoutOptions,
                timeoutLabel: `Selection geometry PDF fallback text load for page ${pageIndex}`,
            }
        );

        const items = Array.isArray(textContent?.items) ? textContent.items : null;
        if (!items) {
            Zotero.debug('[Zotero PDF Highlighter] Plain PDF.js fallback exposed text content without per-character geometry; treating layer 2 geometry as unavailable');
            return charPositions;
        }

        const hasOnlyUsableCharGeometry = items.every((item: any) => hasUsablePdfJsCharGeometry(item));
        if (!hasOnlyUsableCharGeometry) {
            Zotero.debug('[Zotero PDF Highlighter] Plain PDF.js fallback exposed mixed text content; treating layer 2 geometry as unavailable');
            return charPositions;
        }

        for (const item of items) {
            if (!item.str) continue;
            const str = item.str;
            const transform = getUsablePdfJsTransform(item.transform);
            if (!transform) return [];
            const width = isFiniteNumber(item.width) && item.width > 0 ? item.width : 0;
            const height = getUsablePdfJsItemHeight(item, transform);
            if (!height) return [];
            const baseline = transform[5];

            // If char-level positions are available, use them
            if (item.chars && Array.isArray(item.chars) && item.chars.length === str.length) {
                for (let i = 0; i < item.chars.length; i++) {
                    const charInfo = item.chars[i];
                    const charTransform = getUsablePdfJsTransform(charInfo?.transform) ?? transform;
                    const charX = charTransform[4];
                    const charW = isFiniteNumber(charInfo?.width) && charInfo.width > 0
                        ? charInfo.width
                        : (width / str.length);
                    
                    const yShift = height * 0.25;
                    const y1 = baseline - yShift;
                    const y2 = baseline + height - yShift;
                    
                    charPositions.push({
                        char: str[i],
                        rect: [charX, y1, charX + charW, y2],
                    });
                }
                if (includeSyntheticEOL && item.hasEOL) {
                    charPositions.push({
                        char: '\n',
                        rect: [0, 0, 0, 0],
                    });
                }
                continue;
            }

        }
    } catch (e) {
        Zotero.debug(`[Zotero PDF Highlighter] getCharPositionsForPage error: ${e}`);
    }

    return charPositions;
}

// ── Annotation view refresh helper ──────────────────────────────────

function refreshAnnotationView(internal: any): void {
    try {
        // Try to trigger a re-render of annotations
        const annotationManager = internal?._annotationManager;
        if (annotationManager?.render) {
            annotationManager.render();
        }

        // Alternative: trigger PDF viewer update
        const pdfViewer = internal?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer;
        if (pdfViewer?.update) {
            pdfViewer.update();
        }
    } catch {
        // Silent fail - refresh is nice-to-have
    }
}

async function createPaperHighlightAnnotation(
    reader: any,
    attachment: any,
    pageIndex: number,
    candidate: ReadingHighlightCandidate,
    charPositions: CharPosition[],
    pageText?: string
): Promise<boolean> {
    const internal = reader?._internalReader || reader;
    const normalizedPageText = typeof pageText === 'string' && pageText.length
        ? pageText
        : charPositions.map(position => position.char).join('');
    const geometry = getSpanGeometryFromCharPositions(
        { mode: 'exact', rawStart: 0, rawOffsetBase: 0 },
        charPositions,
        normalizedPageText,
        candidate.start,
        candidate.end
    );
    const mergedRects = geometry?.rects;
    if (!mergedRects?.length) return false;

    const annotationKey = Zotero.DataObjectUtilities?.generateKey?.()
        || Zotero.Utilities?.generateObjectKey?.()
        || `reading_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const annotationData = {
        key: annotationKey,
        type: 'highlight',
        color: getHighlightColor(candidate.reason),
        text: candidate.text,
        comment: candidate.reason ? `[${candidate.reason}]` : (candidate.sectionTitle ? `[${candidate.sectionTitle}]` : ''),
        position: {
            pageIndex,
            rects: mergedRects,
        },
        pageLabel: String(pageIndex + 1),
        sortIndex: getSortIndexForRects(pageIndex, geometry!.sortIndexOffset, mergedRects),
        tags: [],
    };

    if (attachment && typeof Zotero.Annotations?.saveFromJSON === 'function') {
        if (await saveAnnotationJsonToAttachment(attachment, annotationData)) {
            refreshAnnotationView(internal);
            return true;
        }

        Zotero.debug(`[Zotero PDF Highlighter] saveFromJSON returned false for global highlight "${candidate.text}"`);
    }

    const mgr = internal?._annotationManager;
    if (mgr && typeof mgr.addAnnotation === 'function') {
        const added = await addAnnotationViaManager(reader, mgr, annotationData);
        if (added) {
            refreshAnnotationView(internal);
            return true;
        }
    }

    return false;
}

// ── Bootstrap lifecycle ──────────────────────────────────────────────

export function install(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: installed");
}

export function startup(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: startup");

    migratePreferencePrefixIfNeeded();
    registerPreferenceDefaults();

    // Create global namespace for hooks (must be before PreferencePanes.register)
    if (!Zotero.ZoteroPDFHighlighter) {
        Zotero.ZoteroPDFHighlighter = {};
    }
    Zotero.ZoteroPDFHighlighter.hooks = {
        _prefsCleanup: null as (() => void) | null,

        onPrefsLoad: (event: any) => {
            // Cleanup previous listeners if any
            Zotero.ZoteroPDFHighlighter.hooks._prefsCleanup?.();

            Zotero.debug('[Zotero PDF Highlighter] onPrefsLoad triggered');

            const doc = event.target?.ownerDocument || event.currentTarget?.ownerDocument;
            if (!doc) {
                Zotero.debug('[Zotero PDF Highlighter] WARNING: Could not get prefs document from event');
                return;
            }

            Zotero.debug(`[Zotero PDF Highlighter] Prefs doc: ${doc?.location?.href || 'unknown'}`);

            const inputs: Record<string, PreferenceKey> = {
                'pref-apiKey': 'apiKey',
                'pref-baseURL': 'baseURL',
                'pref-model': 'model',
                'pref-backendMode': 'backendMode',
                'pref-nonLlmLexicalMethod': 'nonLlmLexicalMethod',
                'pref-systemPrompt': 'systemPrompt',
                'pref-globalSystemPrompt': 'globalSystemPrompt',
                'pref-density': 'density',
                'pref-focusMode': 'focusMode',
                'pref-minConfidence': 'minConfidence',
            };

            const handlers: Array<{ el: Element; type: string; fn: EventListener }> = [];

            for (const [inputId, prefKey] of Object.entries(inputs)) {
                const input = doc.getElementById(inputId) as PreferenceControl | null;
                Zotero.debug(`[Zotero PDF Highlighter] Input ${inputId}: ${!!input}`);

                if (!input) continue;

                // Load current value
                const fullKey = getCanonicalPrefKey(prefKey);
                const currentValue = prefKey === 'systemPrompt'
                    ? resolveSystemPromptPreference(getCanonicalRawPref(prefKey))
                    : prefKey === 'globalSystemPrompt'
                        ? resolveGlobalSystemPromptPreference(getCanonicalRawPref(prefKey))
                        : getCanonicalPref(prefKey);
                setPreferenceControlValue(input, currentValue);
                Zotero.debug(`[Zotero PDF Highlighter] Loaded ${fullKey} = ${currentValue ? '***' : '(empty)'}`);

                // Save on change
                const saveHandler = () => {
                    try {
                        const value = input.value;
                        if (prefKey === 'systemPrompt') {
                            const storedOverride = getStoredSystemPromptOverride(value);

                            if (!storedOverride) {
                                clearCanonicalPref(prefKey);
                                setPreferenceControlValue(input, DEFAULT_SYSTEM_PROMPT);
                            } else {
                                setCanonicalPref(prefKey, storedOverride);
                            }
                        } else if (prefKey === 'globalSystemPrompt') {
                            const storedOverride = getStoredGlobalSystemPromptOverride(value);

                            if (!storedOverride) {
                                clearCanonicalPref(prefKey);
                                setPreferenceControlValue(input, DEFAULT_GLOBAL_SYSTEM_PROMPT);
                            } else {
                                setCanonicalPref(prefKey, storedOverride);
                            }
                        } else if (isBlankDefaultEquivalentPreferenceValue(prefKey, value)) {
                            clearCanonicalPref(prefKey);
                            setPreferenceControlValue(input, PREF_DEFAULTS[prefKey]);
                        } else {
                            setCanonicalPref(prefKey, value);
                        }
                        Zotero.debug(`[Zotero PDF Highlighter] Saved ${fullKey}`);
                    } catch (e) {
                        Zotero.debug(`[Zotero PDF Highlighter] Error saving ${fullKey}: ${e}`);
                    }
                };

                input.addEventListener('change', saveHandler);
                input.addEventListener('blur', saveHandler);
                handlers.push({ el: input, type: 'change', fn: saveHandler });
                handlers.push({ el: input, type: 'blur', fn: saveHandler });
            }

            const advToggle = doc.getElementById('advanced-toggle') as HTMLElement | null;
            const advContent = doc.getElementById('advanced-content') as HTMLElement | null;
            const advToggleArrow = doc.getElementById('advanced-toggle-arrow') as HTMLElement | null;
            Zotero.debug(`[Zotero PDF Highlighter] advanced toggle elements: toggle=${!!advToggle}, content=${!!advContent}`);

            const setAdvancedToggleExpanded = (expanded: boolean): void => {
                if (advContent) {
                    advContent.style.display = expanded ? '' : 'none';
                }
                if (advToggleArrow) {
                    advToggleArrow.textContent = expanded ? '\u25BC' : '\u25B6';
                }
                if (advToggle) {
                    advToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
                }
            };

            if (advToggle && advContent) {
                const toggleAdvancedSettings = () => {
                    const expanded = advContent.style.display === 'none';
                    setAdvancedToggleExpanded(expanded);
                };

                const handleAdvancedToggleKeydown: EventListener = (event) => {
                    if (!(event instanceof KeyboardEvent)) {
                        return;
                    }

                    if (event.key === 'Enter') {
                        event.preventDefault();
                        toggleAdvancedSettings();
                        return;
                    }

                    if (event.key === ' ') {
                        event.preventDefault();
                        toggleAdvancedSettings();
                    }
                };

                setAdvancedToggleExpanded(advContent.style.display !== 'none');
                advToggle.addEventListener('click', toggleAdvancedSettings);
                advToggle.addEventListener('keydown', handleAdvancedToggleKeydown);
                handlers.push({ el: advToggle, type: 'click', fn: toggleAdvancedSettings });
                handlers.push({ el: advToggle, type: 'keydown', fn: handleAdvancedToggleKeydown });
            }

            // Store cleanup function
            Zotero.ZoteroPDFHighlighter.hooks._prefsCleanup = () => {
                for (const { el, type, fn } of handlers) {
                    el.removeEventListener(type, fn);
                }
                Zotero.debug('[Zotero PDF Highlighter] Prefs listeners cleaned up');
            };
        }
    };

    // Register preferences pane (scaffold pattern)
    if (data.rootURI && Zotero.PreferencePanes?.register) {
        Zotero.PreferencePanes.register({
            pluginID: 'zotero-pdf-highlighter@memorushb.com',
            src: data.rootURI + 'content/preferences.xhtml',
            scripts: [data.rootURI + 'content/preferences.js'],
            label: 'Smart Highlight',
        });
    }

    registeredHandler = (event: any) => {
        const { append, doc } = event;
        const button = doc.createElement('button');
        button.textContent = 'Smart Highlight';
        button.className = 'smart-highlight-btn';
        button.style.cssText = 'padding:4px 10px;cursor:pointer;font-size:12px;border-radius:4px;border:1px solid transparent;background:transparent;transition:background 0.15s;';
        attachToolbarButtonHoverState(button);

        button.onclick = async () => {
            await createSelectionReadingHighlights(event, button);
        };

        append(button);
    };
    Zotero.Reader.registerEventListener('renderTextSelectionPopup', registeredHandler, 'zotero-pdf-highlighter');

    // Register toolbar button for whole-document reading highlights.
    toolbarHandler = (event: any) => {
        const { append, doc, reader } = event;
        const button = doc.createElement('button');
        button.id = 'zotero-pdf-highlighter-toolbar-btn';
        button.textContent = 'Smart Highlight All';
        button.title = 'Smart Highlight: scan entire paper';
        button.style.cssText = 'padding:4px 10px;cursor:pointer;font-size:12px;margin-left:4px;border-radius:4px;border:1px solid transparent;background:transparent;transition:background 0.15s;';
        attachToolbarButtonHoverState(button);

        button.onclick = async () => {
            button.disabled = true;
            button.textContent = 'Scanning...';

            try {
                const internal = reader?._internalReader;
                const attachment = getReaderAttachment(reader);
                const paperTitle = getPaperTitle(reader);

                const density = getCanonicalPref('density');
                const focusMode = getCanonicalPref('focusMode');
                const lexicalMethod = getCanonicalPref('nonLlmLexicalMethod');
                const minConfidence = parseFloat(getCanonicalPref('minConfidence')) || 0;

                const pdfViewer = internal?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer;
                const totalPages = pdfViewer?.pagesCount || 1;

                Zotero.debug(`[Zotero PDF Highlighter] Processing ${totalPages} pages`);

                const pageTexts: PaperPageText[] = [];
                const pageCharPositions = new Map<number, CharPosition[]>();
                const pageTextByIndex = new Map<number, string>();

                for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
                    try {
                        button.textContent = `Page ${pageIdx + 1}/${totalPages}`;

                        const charPositions = await getCharPositionsForPage(internal, pageIdx, {
                            includeSyntheticEOL: true,
                        });
                        if (!charPositions.length) {
                            Zotero.debug(`[Zotero PDF Highlighter] Page ${pageIdx} geometry unavailable, skipping`);
                            continue;
                        }

                        const pageText = charPositions.map(position => position.char).join('');

                        if (pageText.trim().length === 0) {
                            Zotero.debug(`[Zotero PDF Highlighter] Page ${pageIdx} has no text, skipping`);
                            continue;
                        }

                        pageTexts.push({ pageIndex: pageIdx, text: pageText });
                        pageCharPositions.set(pageIdx, charPositions);
                        pageTextByIndex.set(pageIdx, pageText);
                    } catch (pageErr: any) {
                        Zotero.debug(`[Zotero PDF Highlighter] Error processing page ${pageIdx}: ${pageErr?.message}`);
                    }
                }

                const preparedSelection: PreparedGlobalHighlightSelection = prepareGlobalHighlightSelection(pageTexts, density, focusMode, paperTitle);
                if (!preparedSelection.shortlist.length) {
                    button.textContent = 'No highlights';
                    setTimeout(() => { button.textContent = 'Smart Highlight All'; button.disabled = false; }, 2500);
                    return;
                }

                button.textContent = `Ranking ${preparedSelection.shortlist.length}...`;

                let selectedHighlights: RankedHighlightSelection[] = [];
                try {
                    const backendResult = await runHighlightBackendWithFallback(
                        'global',
                        async () => selectGlobalHighlightCandidateIds(
                            preparedSelection.shortlist,
                            preparedSelection.maxHighlights,
                            paperTitle,
                            {
                                callerLabel: 'toolbar',
                                timeoutMs: GLOBAL_HIGHLIGHT_REQUEST_TIMEOUT_MS,
                                maxRetries: GLOBAL_HIGHLIGHT_REQUEST_ATTEMPTS,
                            },
                            focusMode
                        ),
                        () => selectGlobalHighlightCandidateIdsNonLlm(preparedSelection, { lexicalMethod })
                    );
                    selectedHighlights = backendResult.result;
                    Zotero.debug(`[Zotero PDF Highlighter] Global ranking resolved via ${backendResult.backend}${backendResult.usedFallback ? ' fallback' : ''}`);
                    if (selectedHighlights.length) {
                        Zotero.debug(`[Zotero PDF Highlighter] Global ranking selected ${selectedHighlights.length} item(s)`);
                    } else {
                        Zotero.debug('[Zotero PDF Highlighter] Global ranking intentionally selected 0 item(s)');
                    }
                } catch (rankErr: any) {
                    Zotero.debug(`[Zotero PDF Highlighter] Global ranking failed: ${rankErr?.message || rankErr}`);
                    button.textContent = 'Error';
                    setTimeout(() => { button.textContent = 'Smart Highlight All'; button.disabled = false; }, 2000);
                    return;
                }

                const selectedIds = selectedHighlights.map(selection => selection.id);
                const reasonById = new Map(selectedHighlights.map(selection => [selection.id, selection.reason]));

                const finalCandidates = finalizeGlobalHighlightSelection(preparedSelection, selectedIds, minConfidence);
                if (!selectedHighlights.length) {
                    Zotero.debug('[Zotero PDF Highlighter] Global ranking produced 0 final candidates by design');
                }
                for (const candidate of finalCandidates) {
                    candidate.reason = reasonById.get(candidate.id) ?? candidate.reason;
                    if (!candidate.reason) {
                        candidate.reason = inferHighlightReason(candidate.text);
                    }
                }
                if (!finalCandidates.length) {
                    button.textContent = 'No highlights';
                    setTimeout(() => { button.textContent = 'Smart Highlight All'; button.disabled = false; }, 2500);
                    return;
                }

                let totalCreated = 0;
                for (const candidate of finalCandidates) {
                    const charPositions = pageCharPositions.get(candidate.pageIndex);
                    if (!charPositions?.length) continue;
                    const pageText = pageTextByIndex.get(candidate.pageIndex);

                    button.textContent = `Highlight ${totalCreated + 1}/${finalCandidates.length}`;
                    try {
                        const created = await createPaperHighlightAnnotation(reader, attachment, candidate.pageIndex, candidate, charPositions, pageText);
                        if (created) totalCreated++;
                    } catch (candidateErr: any) {
                        Zotero.debug(`[Zotero PDF Highlighter] Failed to create global highlight for "${candidate.text}": ${candidateErr?.message || candidateErr}`);
                    }
                }

                Zotero.debug(`[Zotero PDF Highlighter] Total reading highlights created: ${totalCreated}`);
                button.textContent = totalCreated > 0 ? `${totalCreated} highlights` : 'No highlights';
                setTimeout(() => { button.textContent = 'Smart Highlight All'; button.disabled = false; }, 3000);

            } catch (error: any) {
                Zotero.debug(`[Zotero PDF Highlighter] Toolbar reading pass failed: ${error?.message || error}`);
                button.textContent = 'Error';
                setTimeout(() => { button.textContent = 'Smart Highlight All'; button.disabled = false; }, 2000);
            }
        };

        append(button);
    };
    Zotero.Reader.registerEventListener('renderToolbar', toolbarHandler, 'zotero-pdf-highlighter');
}

export function shutdown(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: shutdown");
    selectionHighlightInFlight.clear();

    if (registeredHandler) {
        Zotero.Reader.unregisterEventListener('renderTextSelectionPopup', registeredHandler);
        registeredHandler = null;
    }

    if (toolbarHandler) {
        Zotero.Reader.unregisterEventListener('renderToolbar', toolbarHandler);
        toolbarHandler = null;
    }

    // Cleanup prefs listeners
    Zotero.ZoteroPDFHighlighter?.hooks?._prefsCleanup?.();

    // Clean up global namespace
    if (Zotero.ZoteroPDFHighlighter) {
        delete Zotero.ZoteroPDFHighlighter;
    }
}

export function uninstall(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: uninstalled");
}
