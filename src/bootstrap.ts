declare const Zotero: any;
declare const cloneInto: ((value: any, targetScope: any, options?: any) => any) | undefined;

import { extractEntities, type NerEntity } from "./llm";
import { colorForEntityType } from "./entity-colors";
import { computeEntityRects } from "./rect-splitter";
import { DEFAULT_SYSTEM_PROMPT, PREF_DEFAULTS, PREF_PREFIX, getStoredSystemPromptOverride } from "./preferences";

export interface BootstrapData {
    id: string;
    version: string;
    resourceURI: string;
    rootURI: string;
}

let registeredHandler: ((event: any) => void) | null = null;
let toolbarHandler: ((event: any) => void) | null = null;
const selectionNerInFlight = new Map<string, Promise<void>>();
const FALLBACK_HIGHLIGHT_COLOR = '#ffd400';
const HIGHLIGHT_FAILURE_MESSAGE = 'Could not create a highlight from this selection.';
const SELECTION_RECT_OVERLAP_TOLERANCE = 2;
const SELECTION_CHAR_WINDOW_PADDING = 24;
const SELECTION_NER_REQUEST_TIMEOUT_MS = 45_000;
const SELECTION_NER_REQUEST_ATTEMPTS = 1;
const SELECTION_GEOMETRY_TIMEOUT_MS = 5_000;
const POPUP_PAGE_BOOTSTRAP_TIMEOUT_MS = 750;
const MATCH_SPACE_CHARACTERS = /[\s\u00A0\u1680\u180E\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/u;
const MATCH_ZERO_WIDTH_CHARACTERS = /[\u200B\u200C\u200D\u2060\uFEFF]/u;
const MATCH_OPENING_PUNCTUATION = new Set(['(', '[', '{']);
const MATCH_TIGHT_LEADING_PUNCTUATION = new Set([')', ']', '}', ',', '.', ';', ':', '!', '?']);

type PreferenceControl = HTMLInputElement | HTMLTextAreaElement;

function setPreferenceControlValue(control: PreferenceControl, value: string): void {
    control.value = value;

    if (control.localName === 'textarea') {
        control.defaultValue = value;
        control.textContent = value;
    }
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

interface LayeredEntityGeometry {
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

type SelectionPopupProgressStage = 'extracting-entities' | 'preparing-geometry' | 'applying-highlights' | 'falling-back';

type SelectionPopupProgressHandler = (stage: SelectionPopupProgressStage) => void;

// ── Preferences ──────────────────────────────────────────────────────

function registerPreferenceDefaults(): void {
    for (const [key, val] of Object.entries(PREF_DEFAULTS)) {
        if (Zotero.Prefs.get(PREF_PREFIX + key) === undefined) {
            Zotero.Prefs.set(PREF_PREFIX + key, val, true);
        }
    }
}

// ── UI feedback helpers ──────────────────────────────────────────────

function setButtonState(button: any, text: string, disabled: boolean): void {
    button.textContent = text;
    button.disabled = disabled;
}

function showTemporaryButtonState(button: any, event: any, text: string, durationMs: number): void {
    setButtonState(button, text, true);

    const timerHost = event?.doc?.defaultView;
    if (timerHost && typeof timerHost.setTimeout === 'function') {
        timerHost.setTimeout(() => {
            setButtonState(button, '🔬 NER Highlight', false);
        }, durationMs);
        return;
    }

    setButtonState(button, '🔬 NER Highlight', false);
}

function clearPreference(prefKey: string): void {
    const isFullyQualifiedKey = prefKey.startsWith(PREF_PREFIX);

    if (typeof Zotero.Prefs.clear === 'function') {
        Zotero.Prefs.clear(prefKey, isFullyQualifiedKey);
        return;
    }

    Zotero.Prefs.set(prefKey, '', isFullyQualifiedKey);
}

function getSelectionPopupProgressText(stage: SelectionPopupProgressStage): string {
    switch (stage) {
        case 'extracting-entities':
            return '⏳ Extracting entities...';
        case 'preparing-geometry':
            return '⏳ Locating text...';
        case 'applying-highlights':
            return '⏳ Applying highlights...';
        case 'falling-back':
            return '⏳ Falling back...';
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
    showTemporaryButtonState(button, event, '❌ Failed', 1500);
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
        color: typeof annotation?.color === 'string' && annotation.color.length ? annotation.color : FALLBACK_HIGHLIGHT_COLOR,
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

function getEntityFallbackSortIndex(annotationBase: any, pageIndex: number, entityOffset: number, rects: number[][]): string {
    const baseSortIndex = annotationBase?.sortIndex;
    const segments = typeof baseSortIndex === 'string' ? baseSortIndex.split('|') : [];
    const baseOffset = Number.parseInt(segments[1] ?? '', 10);
    if (Number.isFinite(baseOffset)) {
        return getSortIndexForRects(pageIndex, baseOffset + Math.max(0, entityOffset), rects);
    }

    return getSortIndexForRects(pageIndex, Math.max(0, entityOffset), rects);
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

function tryFindAnchoredEntityNormalizedRange(
    normalizedPageText: string,
    selectionMap: NormalizedTextMap,
    anchorRange: AnchorRange,
    entityText: string,
    entityStart: number,
    entityEnd: number,
    selectionLength: number
): { start: number; end: number } | null {
    const safeStart = Math.max(0, Math.min(entityStart, selectionLength));
    const safeEnd = Math.max(safeStart, Math.min(entityEnd, selectionLength));
    if (safeEnd <= safeStart || !normalizedPageText.length) return null;

    const normalizedEntityText = buildNormalizedTextMap(entityText).text;
    if (!normalizedEntityText.length) return null;

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
        normalizedEntityText.length,
        Math.abs(pageSpanLength - selectionSpanLength),
        8
    );
    const localWindow = clampOffsetWindow(
        estimatedStart - anchorWindow.start - driftAllowance,
        estimatedEnd - anchorWindow.start + driftAllowance,
        anchorWindow.end - anchorWindow.start
    );

    const anchoredPageText = normalizedPageText.slice(anchorWindow.start, anchorWindow.end);
    const anchoredEntityStart = findBestSubstringStart(anchoredPageText, normalizedEntityText, localWindow ?? undefined);
    if (anchoredEntityStart < 0) return null;

    const start = anchorWindow.start + anchoredEntityStart;
    return {
        start,
        end: start + normalizedEntityText.length,
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

function mapEntityRangeToNormalizedPage(
    normalizedPageText: string,
    match: InternalPageMatchResult,
    entityText: string,
    entityStart: number,
    entityEnd: number,
    selectionLength: number
): { start: number; end: number } | null {
    const safeStart = Math.max(0, Math.min(entityStart, selectionLength));
    const safeEnd = Math.max(safeStart, Math.min(entityEnd, selectionLength));
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
        const directEntityRange = tryFindAnchoredEntityNormalizedRange(
            normalizedPageText,
            selectionMap,
            match.anchorRange,
            entityText,
            safeStart,
            safeEnd,
            selectionLength
        );
        if (directEntityRange) return directEntityRange;
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

// ── Fallback: single yellow highlight ────────────────────────────────

async function createFallbackHighlight(event: any): Promise<boolean> {
    const base = getSafeSelectionAnnotationSnapshot(event?.params?.annotation);
    if (!base?.position) return false;

    Zotero.debug('[Zotero PDF Highlighter] using fallback single yellow highlight');
    return createSingleHighlight(
        event,
        base,
        FALLBACK_HIGHLIGHT_COLOR,
        base.position.rects,
        base.text || '',
        'save'
    );
}

// ── NER-powered multi-entity highlighting ────────────────────────────

async function createNerHighlightsFallback(
    reader: any,
    annotationBase: any,
    text: string,
    entities: NerEntity[]
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

    for (const entity of entities) {
        try {
            const color = colorForEntityType(entity.type) || '#ffd400';
            const rects = computeEntityRects(text, baseRects, entity.start, entity.end);
            if (rects.length === 0) continue;

            const annotationKey = Zotero.DataObjectUtilities?.generateKey?.()
                || Zotero.Utilities?.generateObjectKey?.()
                || `ner_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

            const annotationData = {
                key: annotationKey,
                type: 'highlight',
                color: color,
                text: entity.text,
                comment: `[${entity.type}]`,
                position: {
                    pageIndex: pageIndex,
                    rects: rects,
                },
                pageLabel: annotationBase.pageLabel || String(pageIndex + 1),
                sortIndex: getEntityFallbackSortIndex(annotationBase, pageIndex, entity.start, rects),
                tags: [],
            };

            Zotero.debug(`[Zotero PDF Highlighter] Creating annotation with color: ${color}`);

            // Primary: Use Zotero.Annotations.saveFromJSON (most reliable)
            if (attachment && typeof Zotero.Annotations?.saveFromJSON === 'function') {
                try {
                    await saveAnnotationJsonToAttachment(attachment, annotationData);
                    Zotero.debug(`[Zotero PDF Highlighter] Created highlight for "${entity.text}" via saveFromJSON`);
                    created++;
                    refreshAnnotationView(internal);
                    continue;  // Success, move to next entity
                } catch (saveErr: any) {
                    Zotero.debug(`[Zotero PDF Highlighter] saveFromJSON failed: ${saveErr?.message}`);
                }
            } else {
                Zotero.debug(`[Zotero PDF Highlighter] Fallback: Skipping saveFromJSON: attachment=${!!attachment}, saveFromJSON=${typeof Zotero.Annotations?.saveFromJSON}`);
            }

            // Secondary fallback: Try annotation manager
            if (mgr && typeof mgr.addAnnotation === 'function') {
                try {
                    if (await addAnnotationViaManager(reader, mgr, annotationData)) {
                        Zotero.debug(`[Zotero PDF Highlighter] Created highlight for "${entity.text}" via addAnnotation`);
                        created++;
                        refreshAnnotationView(internal);
                        continue;
                    }
                } catch (mgrErr: any) {
                    Zotero.debug(`[Zotero PDF Highlighter] addAnnotation failed: ${mgrErr?.message}`);
                }
            }

            Zotero.debug(`[Zotero PDF Highlighter] All methods failed for "${entity.text}"`);
        } catch (e: any) {
            Zotero.debug(`[Zotero PDF Highlighter] Fallback error for "${entity.text}": ${e?.message}`);
        }
    }

    return created;
}

async function createNerHighlightsWithCharPositions(
    reader: any,
    annotationBase: any,
    text: string,
    entities: NerEntity[],
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
        onProgress?.('falling-back');
        Zotero.debug('[Zotero PDF Highlighter] Popup final layer 3 fallback reason: popup pageIndex was unavailable for safe current-page geometry');
        return createNerHighlightsFallback(reader, annotationBase, text, entities);
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
        onProgress?.('falling-back');
        const layer3FallbackReason = geometryTimedOut
            ? 'selection geometry timed out before layer 1 or layer 2 resolved'
            : popupGeometryDiagnostics.layer2SelectionMatchFailureReason
                || popupGeometryDiagnostics.layer1CharsUnavailableReason
                || 'selection geometry was unavailable in both layer 1 and layer 2';
        Zotero.debug(`[Zotero PDF Highlighter] Popup final layer 3 fallback reason: ${layer3FallbackReason}`);
        return createNerHighlightsFallback(reader, annotationBase, text, entities);
    }

    onProgress?.('applying-highlights');
    for (const entity of entities) {
        try {
            const color = colorForEntityType(entity.type) || '#ffd400';
            let layer1AttemptedForEntity = false;
            let layer1EntityGeometryFailed = false;
            let layer2AttemptedForEntity = false;
            let layer2EntityGeometryFailed = false;

            let geometry: LayeredEntityGeometry | null = null;

            if (internalPageData) {
                layer1AttemptedForEntity = true;
                geometry = getEntityGeometryFromReaderInternals(internalPageData, text, entity.start, entity.end, selectionRects);
                if (!geometry) {
                    layer1EntityGeometryFailed = true;
                    Zotero.debug(`[Zotero PDF Highlighter] Popup layer 1 attempted but entity geometry failed for "${entity.text}"`);
                }
            }

            if (!geometry && internalPageData) {
                layer2AttemptedForEntity = true;
                const fallbackSelectionMatch = await ensureLayer2SelectionMatch();
                geometry = getEntityGeometryFromCharPositions(fallbackSelectionMatch, charPositions, text, entity.start, entity.end);
                if (!geometry) {
                    layer2EntityGeometryFailed = true;
                    Zotero.debug(`[Zotero PDF Highlighter] Popup layer 2 entity geometry failed for "${entity.text}"`);
                }
            } else if (!geometry) {
                layer2AttemptedForEntity = true;
                geometry = getEntityGeometryFromCharPositions(layer2SelectionMatch, charPositions, text, entity.start, entity.end);
                if (!geometry) {
                    layer2EntityGeometryFailed = true;
                    Zotero.debug(`[Zotero PDF Highlighter] Popup layer 2 entity geometry failed for "${entity.text}"`);
                }
            }

            const mergedRects = geometry?.rects ?? computeEntityRects(text, annotationBase.position?.rects ?? [], entity.start, entity.end);

            if (!mergedRects.length) continue;

            if (geometry) {
                Zotero.debug(`[Zotero PDF Highlighter] Using layer ${geometry.layer} geometry for "${entity.text}"`);
            } else {
                const layer3FallbackReason = geometryTimedOut
                    ? 'selection geometry timed out before entity geometry resolved'
                    : layer2AttemptedForEntity && layer2EntityGeometryFailed
                        ? layer1AttemptedForEntity && layer1EntityGeometryFailed
                            ? 'layer 1 entity geometry failed and layer 2 entity geometry failed'
                            : 'layer 2 entity geometry failed'
                        : layer1AttemptedForEntity && layer1EntityGeometryFailed
                            ? 'layer 1 entity geometry failed'
                            : popupGeometryDiagnostics.layer2SelectionMatchFailureReason
                                || popupGeometryDiagnostics.layer1CharsUnavailableReason
                                || 'precise popup geometry was unavailable';
                Zotero.debug(`[Zotero PDF Highlighter] Popup final layer 3 fallback reason for "${entity.text}": ${layer3FallbackReason}`);
                Zotero.debug(`[Zotero PDF Highlighter] Using layer 3 geometry for "${entity.text}"`);
            }

            const annotationKey = Zotero.DataObjectUtilities?.generateKey?.()
                || Zotero.Utilities?.generateObjectKey?.()
                || `ner_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

            const annotationData = {
                key: annotationKey,
                type: 'highlight',
                color: color,
                text: entity.text,
                comment: `[${entity.type}]`,
                position: {
                    pageIndex: pageIndex,
                    rects: mergedRects,
                },
                pageLabel: annotationBase.pageLabel || String(pageIndex + 1),
                sortIndex: geometry
                    ? getSortIndexForRects(pageIndex, geometry.sortIndexOffset, mergedRects)
                    : getEntityFallbackSortIndex(annotationBase, pageIndex, entity.start, mergedRects),
                tags: [],
            };

            // Primary: Use Zotero.Annotations.saveFromJSON (most reliable)
            if (attachment && typeof Zotero.Annotations?.saveFromJSON === 'function') {
                try {
                    await saveAnnotationJsonToAttachment(attachment, annotationData);
                    Zotero.debug(`[Zotero PDF Highlighter] Created highlight for "${entity.text}" via saveFromJSON`);
                    created++;
                    refreshAnnotationView(internal);
                    continue;  // Success, move to next entity
                } catch (saveErr: any) {
                    Zotero.debug(`[Zotero PDF Highlighter] saveFromJSON failed: ${saveErr?.message}`);
                }
            } else {
                Zotero.debug(`[Zotero PDF Highlighter] CharPositions: Skipping saveFromJSON: attachment=${!!attachment}, saveFromJSON=${typeof Zotero.Annotations?.saveFromJSON}`);
            }

            // Secondary fallback: Try annotation manager
            if (mgr && typeof mgr.addAnnotation === 'function') {
                try {
                    if (await addAnnotationViaManager(reader, mgr, annotationData)) {
                        Zotero.debug(`[Zotero PDF Highlighter] Created highlight for "${entity.text}" via addAnnotation`);
                        created++;
                        refreshAnnotationView(internal);
                        continue;
                    }
                } catch (mgrErr: any) {
                    Zotero.debug(`[Zotero PDF Highlighter] addAnnotation failed: ${mgrErr?.message}`);
                }
            }

            Zotero.debug(`[Zotero PDF Highlighter] All methods failed for "${entity.text}"`);
        } catch (e: any) {
            Zotero.debug(`[Zotero PDF Highlighter] CharPositions failed for "${entity.text}": ${e?.message}`);
        }
    }

    return created;
}

async function createNerHighlights(event: any, button: any): Promise<void> {
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
    if (selectionNerInFlight.has(selectionRequestKey)) {
        Zotero.debug('[Zotero PDF Highlighter] Duplicate selection NER request ignored');
        showTemporaryButtonState(button, event, '⏳ Already running', 1200);
        return;
    }

    const fullRects: number[][] = base.position.rects || [];
    if (fullRects.length === 0) {
        notifyHighlightFailure(event, button);
        return;
    }

    const requestPromise = (async () => {
        setSelectionPopupProgress(button, 'extracting-entities');

        let entities: NerEntity[];
        try {
            entities = await extractEntities(selectedText, {
                callerLabel: 'selection',
                timeoutMs: SELECTION_NER_REQUEST_TIMEOUT_MS,
                maxRetries: SELECTION_NER_REQUEST_ATTEMPTS,
            });
        } catch (err: any) {
            Zotero.debug(`[Zotero PDF Highlighter] NER extraction failed: ${err?.message || err}`);
            const fallbackOk = await createFallbackHighlight(event);
            if (fallbackOk) {
                showTemporaryButtonState(button, event, '⚠️ Fallback (1)', 2000);
            } else {
                notifyHighlightFailure(event, button);
            }
            return;
        }

        if (entities.length === 0) {
            Zotero.debug('[Zotero PDF Highlighter] NER returned 0 entities, using fallback');
            const fallbackOk = await createFallbackHighlight(event);
            if (fallbackOk) {
                showTemporaryButtonState(button, event, '⚠️ No entities', 2000);
            } else {
                notifyHighlightFailure(event, button);
            }
            return;
        }

        Zotero.debug(`[Zotero PDF Highlighter] creating highlights for ${entities.length} entities`);

        const created = await createNerHighlightsWithCharPositions(
            reader,
            base,
            selectedText,
            entities,
            stage => setSelectionPopupProgress(button, stage)
        );
        const failCount = entities.length - created;
        if (failCount === 0) {
            showTemporaryButtonState(button, event, `✓ Done (${created})`, 2000);
        } else {
            showTemporaryButtonState(button, event, `⚠️ ${created}ok/${failCount}err`, 2500);
        }
    })();

    selectionNerInFlight.set(selectionRequestKey, requestPromise);
    try {
        await requestPromise;
    } finally {
        selectionNerInFlight.delete(selectionRequestKey);
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

function mapEntityRangeToPage(
    match: TextMatchResult,
    entityText: string,
    entityStart: number,
    entityEnd: number,
    selectionLength: number
): { start: number; end: number } | null {
    const safeStart = Math.max(0, Math.min(entityStart, selectionLength));
    const safeEnd = Math.max(safeStart, Math.min(entityEnd, selectionLength));
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
        const directEntityRange = tryFindAnchoredEntityNormalizedRange(
            pageMap.text,
            selectionMap,
            match.anchorRange,
            entityText,
            safeStart,
            safeEnd,
            selectionLength
        );
        if (directEntityRange) {
            const mappedStart = match.rawOffsetBase + normalizedBoundaryToRawOffset(pageMap, directEntityRange.start);
            let mappedEnd = match.rawOffsetBase + normalizedBoundaryToRawOffset(pageMap, directEntityRange.end);
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

function getEntityGeometryFromReaderInternals(
    pageData: ReaderInternalPageData,
    selectionText: string,
    entityStart: number,
    entityEnd: number,
    selectionRects?: number[][]
): LayeredEntityGeometry | null {
    const selectionCharWindow = selectionRects?.length
        ? findSelectionReaderCharWindow(pageData.chars, selectionRects)
        : null;
    const preferredWindow = mapCharWindowToRawTextWindow(pageData.charMapping, pageData.pageText.length, selectionCharWindow);
    const selectionMatch = findInternalPageMatch(pageData.pageText, selectionText, preferredWindow ?? undefined);
    if (!selectionMatch) return null;

    const normalizedRange = mapEntityRangeToNormalizedPage(
        pageData.pageText,
        selectionMatch,
        selectionText.slice(entityStart, entityEnd),
        entityStart,
        entityEnd,
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

function getEntityGeometryFromCharPositions(
    selectionMatch: TextMatchResult | null,
    charPositions: CharPosition[],
    selectionText: string,
    entityStart: number,
    entityEnd: number
): LayeredEntityGeometry | null {
    if (!selectionMatch || !charPositions.length) return null;

    const mappedRange = mapEntityRangeToPage(
        selectionMatch,
        selectionText.slice(entityStart, entityEnd),
        entityStart,
        entityEnd,
        selectionText.length
    );
    if (!mappedRange) return null;

    const entityStartInPage = Math.max(0, Math.min(mappedRange.start, charPositions.length));
    const entityEndInPage = Math.max(entityStartInPage, Math.min(mappedRange.end, charPositions.length));
    const entityRects: number[][] = [];

    for (let i = entityStartInPage; i < entityEndInPage; i++) {
        const charPosition = charPositions[i];
        if (charPosition.rect[2] - charPosition.rect[0] <= 0.1) continue;
        entityRects.push(charPosition.rect);
    }

    if (!entityRects.length) return null;

    return {
        layer: 2,
        rects: mergeAdjacentRects(entityRects),
        sortIndexOffset: entityStartInPage,
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

// ── Bootstrap lifecycle ──────────────────────────────────────────────

export function install(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: installed");
}

export function startup(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: startup");

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

            const inputs: Record<string, string> = {
                'pref-apiKey': 'apiKey',
                'pref-baseURL': 'baseURL',
                'pref-model': 'model',
                'pref-systemPrompt': 'systemPrompt',
            };

            const handlers: Array<{ el: Element; type: string; fn: () => void }> = [];

            for (const [inputId, prefKey] of Object.entries(inputs)) {
                const input = doc.getElementById(inputId) as PreferenceControl | null;
                Zotero.debug(`[Zotero PDF Highlighter] Input ${inputId}: ${!!input}`);

                if (!input) continue;

                // Load current value
                const fullKey = PREF_PREFIX + prefKey;
                const currentValue = prefKey === 'systemPrompt'
                    ? (getStoredSystemPromptOverride(Zotero.Prefs.get(fullKey)) ?? '')
                    : String(Zotero.Prefs.get(fullKey) ?? '');
                setPreferenceControlValue(input, currentValue);
                if (prefKey === 'systemPrompt') {
                    input.placeholder = DEFAULT_SYSTEM_PROMPT;
                }
                Zotero.debug(`[Zotero PDF Highlighter] Loaded ${fullKey} = ${currentValue ? '***' : '(empty)'}`);

                // Save on change
                const saveHandler = () => {
                    try {
                        const value = input.value;
                        if (prefKey === 'systemPrompt') {
                            const storedOverride = getStoredSystemPromptOverride(value);

                            if (!storedOverride) {
                                clearPreference(fullKey);
                                setPreferenceControlValue(input, '');
                            } else {
                                Zotero.Prefs.set(fullKey, storedOverride);
                            }
                        } else {
                            Zotero.Prefs.set(fullKey, value);
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
            label: 'PDF Highlighter',
        });
    }

    registeredHandler = (event: any) => {
        const { append, doc } = event;
        const button = doc.createElement('button');
        button.textContent = '🔬 NER Highlight';
        button.style.backgroundColor = '#1e1e1e';
        button.style.color = '#d4d4d4';
        button.style.border = '1px solid #333';
        button.style.borderRadius = '3px';
        button.style.padding = '2px 5px';
        button.style.cursor = 'pointer';

        button.onclick = async () => {
            await createNerHighlights(event, button);
        };

        append(button);
    };
    Zotero.Reader.registerEventListener('renderTextSelectionPopup', registeredHandler, 'zotero-pdf-highlighter');

    // Register toolbar button for whole-document NER (all pages)
    toolbarHandler = (event: any) => {
        const { append, doc, reader } = event;
        const button = doc.createElement('button');
        button.id = 'zotero-pdf-highlighter-toolbar-btn';
        button.textContent = '🔬 NER';
        button.title = 'Run NER highlighting on ALL pages';
        button.style.cssText = 'background:#1e1e1e;color:#d4d4d4;border:1px solid #333;border-radius:3px;padding:2px 8px;cursor:pointer;font-size:12px;margin-left:4px;';

        button.onclick = async () => {
            button.disabled = true;
            button.textContent = '⏳ Starting...';

            try {
                const internal = reader?._internalReader;
                const attachment = getReaderAttachment(reader);

                // Get total page count
                const pdfViewer = internal?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer;
                const totalPages = pdfViewer?.pagesCount || 1;

                Zotero.debug(`[Zotero PDF Highlighter] Processing ${totalPages} pages`);

                let totalCreated = 0;

                for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
                    try {
                        button.textContent = `⏳ Page ${pageIdx + 1}/${totalPages}`;

                        const charPositions = await getCharPositionsForPage(internal, pageIdx, {
                            includeSyntheticEOL: false,
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

                        Zotero.debug(`[Zotero PDF Highlighter] Page ${pageIdx} text length: ${pageText.length}`);

                        // Call NER for this page
                        const entities = await extractEntities(pageText, { callerLabel: 'toolbar' });
                        if (!entities || entities.length === 0) {
                            Zotero.debug(`[Zotero PDF Highlighter] No entities found on page ${pageIdx}`);
                            continue;
                        }

                        Zotero.debug(`[Zotero PDF Highlighter] Found ${entities.length} entities on page ${pageIdx}`);

                        // Create highlights for each entity
                        for (const entity of entities) {
                            try {
                                const entityColor = colorForEntityType(entity.type) || '#ffd400';

                                const geometry = getEntityGeometryFromCharPositions(
                                    { mode: 'exact', rawStart: 0, rawOffsetBase: 0 },
                                    charPositions,
                                    pageText,
                                    entity.start,
                                    entity.end
                                );
                                const mergedRects = geometry?.rects;

                                if (!mergedRects?.length) {
                                    Zotero.debug(`[Zotero PDF Highlighter] No rects for "${entity.text}", skipping`);
                                    continue;
                                }

                                const annotationKey = Zotero.DataObjectUtilities?.generateKey?.()
                                    || Zotero.Utilities?.generateObjectKey?.()
                                    || `ner_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

                                const annotationData = {
                                    key: annotationKey,
                                    type: 'highlight',
                                    color: entityColor,
                                    text: entity.text,
                                    comment: `[${entity.type}]`,
                                    position: {
                                        pageIndex: pageIdx,
                                        rects: mergedRects,
                                    },
                                    pageLabel: String(pageIdx + 1),
                                    sortIndex: getSortIndexForRects(pageIdx, geometry!.sortIndexOffset, mergedRects),
                                    tags: [],
                                };

                                // Try to create annotation
                                if (attachment && typeof Zotero.Annotations?.saveFromJSON === 'function') {
                                    await saveAnnotationJsonToAttachment(attachment, annotationData);
                                    totalCreated++;
                                    // Refresh view after each highlight for live feedback
                                    refreshAnnotationView(internal);
                                    Zotero.debug(`[Zotero PDF Highlighter] Created highlight for "${entity.text}" on page ${pageIdx}`);
                                }
                            } catch (e: any) {
                                Zotero.debug(`[Zotero PDF Highlighter] Failed to create highlight for "${entity.text}": ${e?.message}`);
                            }
                        }

                    } catch (pageErr: any) {
                        Zotero.debug(`[Zotero PDF Highlighter] Error processing page ${pageIdx}: ${pageErr?.message}`);
                    }
                }

                Zotero.debug(`[Zotero PDF Highlighter] Total highlights created: ${totalCreated}`);
                button.textContent = `✓ ${totalCreated} entities`;
                setTimeout(() => { button.textContent = '🔬 NER'; button.disabled = false; }, 3000);

            } catch (error: any) {
                Zotero.debug(`[Zotero PDF Highlighter] Toolbar NER failed: ${error?.message || error}`);
                button.textContent = '❌ Error';
                setTimeout(() => { button.textContent = '🔬 NER'; button.disabled = false; }, 2000);
            }
        };

        append(button);
    };
    Zotero.Reader.registerEventListener('renderToolbar', toolbarHandler, 'zotero-pdf-highlighter');
}

export function shutdown(data: BootstrapData, reason: number) {
    Zotero.debug("Zotero PDF Highlighter: shutdown");
    selectionNerInFlight.clear();

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
