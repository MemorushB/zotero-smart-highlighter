import { type DensityLevel, type FocusMode } from './preferences';

export interface ReadingHighlightSpan {
    text: string;
    start: number;
    end: number;
    reason?: string;
    confidence?: number;
}

export type ReadingSectionKind = 'abstract' | 'introduction' | 'related-work' | 'methods' | 'results' | 'discussion' | 'conclusion' | 'other';

export interface ReadingHighlightCandidate extends ReadingHighlightSpan {
    id: string;
    pageIndex: number;
    sectionTitle: string | null;
    sectionKind: ReadingSectionKind;
    heuristicScore: number;
}

export interface PaperPageText {
    pageIndex: number;
    text: string;
}

export interface QuickHighlightDefaults {
    minChars: number;
    maxChars: number;
    maxWords: number;
    maxHighlights: number;
}

export interface GlobalHighlightDefaults {
    minChars: number;
    maxChars: number;
    maxWords: number;
    shortlistSize: number;
    maxHighlights: number;
    maxPerPage: number;
}

export interface PreparedGlobalHighlightSelection {
    candidates: ReadingHighlightCandidate[];
    shortlist: ReadingHighlightCandidate[];
    maxHighlights: number;
    maxPerPage: number;
}

// ── Density-driven configuration ─────────────────────────────────────

export interface DensityConfig {
    quickMinChars: number;
    quickMaxChars: number;
    quickMaxWords: number;
    quickMaxHighlights: number;
    globalMinChars: number;
    globalMaxChars: number;
    globalMaxWords: number;
    globalShortlistSize: number;
    globalMaxHighlightsFormula: (pages: number) => number;
    globalMaxPerPage: number;
    shortlistPerPageCap: number;
}

const DENSITY_CONFIGS: Record<DensityLevel, DensityConfig> = {
    sparse: {
        quickMinChars: 16,
        quickMaxChars: 140,
        quickMaxWords: 24,
        quickMaxHighlights: 2,
        globalMinChars: 20,
        globalMaxChars: 220,
        globalMaxWords: 36,
        globalShortlistSize: 60,
        globalMaxHighlightsFormula: (pages) => Math.min(50, Math.max(10, Math.ceil(pages * 3))),
        globalMaxPerPage: 5,
        shortlistPerPageCap: 6,
    },
    balanced: {
        quickMinChars: 16,
        quickMaxChars: 160,
        quickMaxWords: 28,
        quickMaxHighlights: 3,
        globalMinChars: 18,
        globalMaxChars: 240,
        globalMaxWords: 40,
        globalShortlistSize: 100,
        globalMaxHighlightsFormula: (pages) => Math.min(100, Math.max(20, Math.ceil(pages * 6))),
        globalMaxPerPage: 10,
        shortlistPerPageCap: 12,
    },
    dense: {
        quickMinChars: 14,
        quickMaxChars: 180,
        quickMaxWords: 32,
        quickMaxHighlights: 5,
        globalMinChars: 16,
        globalMaxChars: 260,
        globalMaxWords: 44,
        globalShortlistSize: 150,
        globalMaxHighlightsFormula: (pages) => Math.min(150, Math.max(30, Math.ceil(pages * 10))),
        globalMaxPerPage: 15,
        shortlistPerPageCap: 18,
    },
};

export function getDensityConfig(density: string): DensityConfig {
    return DENSITY_CONFIGS[density as DensityLevel] ?? DENSITY_CONFIGS.balanced;
}

// ── Focus-mode section weights ───────────────────────────────────────

const FOCUS_SECTION_WEIGHTS: Record<FocusMode, Record<ReadingSectionKind, number>> = {
    balanced: {
        abstract: 4, introduction: 3, 'related-work': 1, methods: 2,
        results: 5, discussion: 4, conclusion: 3, other: 2,
    },
    'results-first': {
        abstract: 3, introduction: 2, 'related-work': 1, methods: 1,
        results: 6, discussion: 5, conclusion: 3, other: 2,
    },
    'methods-first': {
        abstract: 4, introduction: 3, 'related-work': 1, methods: 5,
        results: 3, discussion: 2, conclusion: 2, other: 2,
    },
    'caveats-first': {
        abstract: 3, introduction: 3, 'related-work': 1, methods: 1,
        results: 3, discussion: 6, conclusion: 5, other: 2,
    },
};

export function getSectionWeights(focusMode: string): Record<ReadingSectionKind, number> {
    return FOCUS_SECTION_WEIGHTS[focusMode as FocusMode] ?? FOCUS_SECTION_WEIGHTS.balanced;
}

// ── Pattern scoring ──────────────────────────────────────────────────

const POSITIVE_PATTERNS: Array<[RegExp, number]> = [
    [/\b(we (propose|present|introduce|show|find|demonstrate|observe|report))\b/i, 4],
    [/\b(outperform|improv(?:e|es|ed)|better than|state-of-the-art|sota|significant(?:ly)?)\b/i, 4],
    [/\b(result|results|finding|findings|evidence|achiev(?:e|es|ed)|yield(?:s|ed)?)\b/i, 3],
    [/\b(limit(?:ation|ations)?|caveat|however|fails?|failure|underperform|boundary|scope)\b/i, 3],
    [/\b(problem|challenge|gap|remains|unclear|little is known|motivat(?:e|es|ion))\b/i, 2],
    [/\b(method|architecture|training|dataset|evaluation|ablat(?:ion|e))\b/i, 1],
    [/\b(precision|recall|f1|accuracy|auc|bleu|rouge|percent|%)\b/i, 2],
];

const NEGATIVE_PATTERNS: Array<[RegExp, number]> = [
    [/\b(Fig\.?|Figure|Table|Eq\.?|Equation|Appendix|appendix)\b/i, -5],
    [/\bet al\./i, -2],
    [/\b(this|these|it|they|such)\b/i, -1],
    [/\b(related work|in this section|the rest of the paper|as shown in)\b/i, -4],
    [/\[[0-9,\-\s]+\]/, -2],
    [/\([^)]*\d{4}[^)]*\)/, -2],
];

// ── Public API ───────────────────────────────────────────────────────

export function getQuickHighlightDefaults(density: string = 'balanced'): QuickHighlightDefaults {
    const config = getDensityConfig(density);
    return {
        minChars: config.quickMinChars,
        maxChars: config.quickMaxChars,
        maxWords: config.quickMaxWords,
        maxHighlights: config.quickMaxHighlights,
    };
}

export function getGlobalHighlightDefaults(totalPages: number, density: string = 'balanced'): GlobalHighlightDefaults {
    const config = getDensityConfig(density);
    const safePageCount = Math.max(1, totalPages);
    return {
        minChars: config.globalMinChars,
        maxChars: config.globalMaxChars,
        maxWords: config.globalMaxWords,
        shortlistSize: config.globalShortlistSize,
        maxHighlights: config.globalMaxHighlightsFormula(safePageCount),
        maxPerPage: config.globalMaxPerPage,
    };
}

export function inferSectionTitle(text: string, offset: number): string | null {
    const headings = extractSectionHeadings(text);
    let sectionTitle: string | null = null;
    for (const heading of headings) {
        if (heading.start > offset) break;
        sectionTitle = heading.title;
    }
    return sectionTitle;
}

export function validateQuickHighlightSpans(spans: ReadingHighlightSpan[], selectionText: string, density: string = 'balanced'): ReadingHighlightSpan[] {
    return validateHighlightSpans(spans, selectionText, getQuickHighlightDefaults(density));
}

export function prepareGlobalHighlightSelection(
    pages: PaperPageText[],
    density: string = 'balanced',
    focusMode: string = 'balanced'
): PreparedGlobalHighlightSelection {
    const defaults = getGlobalHighlightDefaults(pages.length, density);
    const config = getDensityConfig(density);
    const candidates = pages.flatMap(page => extractPageHighlightCandidates(page, defaults, focusMode));
    const shortlist = buildShortlist(candidates, defaults.shortlistSize, config.shortlistPerPageCap);

    return {
        candidates,
        shortlist,
        maxHighlights: defaults.maxHighlights,
        maxPerPage: defaults.maxPerPage,
    };
}

export function finalizeGlobalHighlightSelection(
    prepared: PreparedGlobalHighlightSelection,
    selectedIds: string[],
    minConfidence: number = 0
): ReadingHighlightCandidate[] {
    const lookup = new Map(prepared.shortlist.map(candidate => [candidate.id, candidate]));
    const seenIds = new Set<string>();
    const seenTexts = new Set<string>();
    const perPageCount = new Map<number, number>();
    const perSectionCount = new Map<ReadingSectionKind, number>();
    const ordered: ReadingHighlightCandidate[] = [];
    // Map minConfidence (0-1) to a minimum heuristic score threshold.
    // Default 0.5 -> minScore 5 (filters candidates below section-weight-level quality).
    // The formula: ceil(2 + confidence x 6) gives range [3, 8] for confidence in (0, 1].
    const minScore = minConfidence > 0 ? Math.ceil(2 + minConfidence * 6) : 0;

    for (const candidateId of selectedIds) {
        if (seenIds.has(candidateId)) continue;
        seenIds.add(candidateId);

        const candidate = lookup.get(candidateId);
        if (!candidate) continue;

        if (minScore > 0 && candidate.heuristicScore < minScore) continue;

        const normalizedText = normalizeForDedup(candidate.text);
        if (!normalizedText || seenTexts.has(normalizedText)) continue;

        const pageCount = perPageCount.get(candidate.pageIndex) ?? 0;
        if (pageCount >= prepared.maxPerPage) continue;

        const sectionCap = getSectionCap(candidate.sectionKind, prepared.maxHighlights);
        const sectionCount = perSectionCount.get(candidate.sectionKind) ?? 0;
        if (sectionCount >= sectionCap) continue;

        seenTexts.add(normalizedText);
        perPageCount.set(candidate.pageIndex, pageCount + 1);
        perSectionCount.set(candidate.sectionKind, sectionCount + 1);
        ordered.push(candidate);

        if (ordered.length >= prepared.maxHighlights) break;
    }

    return ordered.sort((left, right) => {
        if (left.pageIndex !== right.pageIndex) return left.pageIndex - right.pageIndex;
        return left.start - right.start;
    });
}

// ── Internal helpers ─────────────────────────────────────────────────

function validateHighlightSpans(
    spans: ReadingHighlightSpan[],
    sourceText: string,
    limits: QuickHighlightDefaults | GlobalHighlightDefaults
): ReadingHighlightSpan[] {
    const validated: ReadingHighlightSpan[] = [];
    const seenTexts = new Set<string>();

    for (const span of spans) {
        const repaired = repairSpan(span, sourceText);
        if (!repaired) continue;

        const trimmed = trimSpanRange(sourceText, repaired.start, repaired.end);
        if (!trimmed) continue;

        const text = sourceText.slice(trimmed.start, trimmed.end);
        if (!isReadableHighlight(text, limits.minChars, limits.maxChars, limits.maxWords)) continue;

        const dedupeKey = normalizeForDedup(text);
        if (!dedupeKey || seenTexts.has(dedupeKey)) continue;

        seenTexts.add(dedupeKey);
        validated.push({
            text,
            start: trimmed.start,
            end: trimmed.end,
            reason: typeof span.reason === 'string' ? span.reason.trim() : undefined,
            confidence: typeof span.confidence === 'number' ? span.confidence : undefined,
        });

        if (validated.length >= limits.maxHighlights) break;
    }

    return validated;
}

function buildShortlist(
    candidates: ReadingHighlightCandidate[],
    shortlistSize: number,
    perPageCap: number = 12
): ReadingHighlightCandidate[] {
    const sorted = [...candidates].sort((left, right) => {
        if (right.heuristicScore !== left.heuristicScore) return right.heuristicScore - left.heuristicScore;
        if (left.pageIndex !== right.pageIndex) return left.pageIndex - right.pageIndex;
        return left.start - right.start;
    });

    const shortlist: ReadingHighlightCandidate[] = [];
    const perPageCount = new Map<number, number>();
    const seenTexts = new Set<string>();

    for (const candidate of sorted) {
        const pageCount = perPageCount.get(candidate.pageIndex) ?? 0;
        if (pageCount >= perPageCap) continue;

        const normalizedText = normalizeForDedup(candidate.text);
        if (!normalizedText || seenTexts.has(normalizedText)) continue;

        seenTexts.add(normalizedText);
        perPageCount.set(candidate.pageIndex, pageCount + 1);
        shortlist.push(candidate);

        if (shortlist.length >= shortlistSize) break;
    }

    return shortlist;
}

function extractPageHighlightCandidates(
    page: PaperPageText,
    defaults: GlobalHighlightDefaults,
    focusMode: string = 'balanced'
): ReadingHighlightCandidate[] {
    const headings = extractSectionHeadings(page.text);
    const sentenceRanges = splitSentenceLikeRanges(page.text, defaults.maxChars);
    const candidates: ReadingHighlightCandidate[] = [];
    let candidateIndex = 0;

    for (const range of sentenceRanges) {
        const trimmed = trimSpanRange(page.text, range.start, range.end);
        if (!trimmed) continue;

        const text = page.text.slice(trimmed.start, trimmed.end);
        if (!isReadableHighlight(text, defaults.minChars, defaults.maxChars, defaults.maxWords)) continue;

        const section = findSectionForOffset(headings, trimmed.start);
        const heuristicScore = scoreCandidate(text, section.kind, focusMode);
        if (heuristicScore < 2) continue;

        candidates.push({
            id: `P${page.pageIndex + 1}-C${++candidateIndex}`,
            pageIndex: page.pageIndex,
            start: trimmed.start,
            end: trimmed.end,
            text,
            sectionTitle: section.title,
            sectionKind: section.kind,
            heuristicScore,
        });
    }

    return candidates;
}

function splitSentenceLikeRanges(text: string, maxChars: number = 240): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    let start = 0;

    for (let index = 0; index < text.length; index++) {
        const current = text[index];
        const next = text[index + 1] ?? '';
        const nextNext = text[index + 2] ?? '';
        const boundaryFromPunctuation = /[.!?]/.test(current) && /\s/.test(next) && /[A-Z0-9(\[]/.test(nextNext || '');
        const boundaryFromBreak = current === '\n' && next === '\n';
        const boundaryFromBulletBreak = current === '\n' && /[-*0-9]/.test(next);

        if (!boundaryFromPunctuation && !boundaryFromBreak && !boundaryFromBulletBreak) {
            continue;
        }

        ranges.push({ start, end: boundaryFromBreak ? index : index + 1 });
        start = index + 1;
    }

    if (start < text.length) {
        ranges.push({ start, end: text.length });
    }

    return ranges.flatMap(range => splitLongRange(text, range, maxChars));
}

function splitLongRange(
    text: string,
    range: { start: number; end: number },
    maxChars: number = 240
): Array<{ start: number; end: number }> {
    const raw = text.slice(range.start, range.end);
    if (raw.length <= maxChars) return [range];

    const breakpoints = Array.from(raw.matchAll(/(;|:|, but |, while |, whereas )/gi));
    if (!breakpoints.length) return [range];

    const ranges: Array<{ start: number; end: number }> = [];
    let localStart = 0;
    const minChars = 16;

    for (const breakpoint of breakpoints) {
        const matchIndex = breakpoint.index ?? -1;
        if (matchIndex <= localStart) continue;

        const localEnd = matchIndex + breakpoint[0].length;
        if (localEnd - localStart < minChars) continue;

        ranges.push({
            start: range.start + localStart,
            end: range.start + localEnd,
        });
        localStart = localEnd;
    }

    if (range.end - (range.start + localStart) >= minChars) {
        ranges.push({ start: range.start + localStart, end: range.end });
    }

    return ranges.length ? ranges : [range];
}

function extractSectionHeadings(text: string): Array<{ start: number; end: number; title: string; kind: ReadingSectionKind }> {
    const headings: Array<{ start: number; end: number; title: string; kind: ReadingSectionKind }> = [];
    let lineStart = 0;

    for (let index = 0; index <= text.length; index++) {
        if (index !== text.length && text[index] !== '\n') continue;

        const line = text.slice(lineStart, index).trim();
        if (looksLikeSectionHeading(line)) {
            headings.push({
                start: lineStart,
                end: index,
                title: line,
                kind: classifySectionKind(line),
            });
        }

        lineStart = index + 1;
    }

    return headings;
}

function looksLikeSectionHeading(line: string): boolean {
    if (!line) return false;
    if (line.length > 90) return false;
    if (/[.!?]$/.test(line)) return false;

    const words = line.split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 12) return false;

    const containsLetters = /[A-Za-z]/.test(line);
    if (!containsLetters) return false;

    const normalized = line.replace(/^[0-9.\s]+/, '');
    if (/^(abstract|introduction|background|related work|method|methods|approach|model|experiment|experiments|results|evaluation|discussion|conclusion|limitations?)$/i.test(normalized)) {
        return true;
    }

    const titleCaseLike = words.every(word => /^[A-Z0-9][A-Za-z0-9-]*$/.test(word));
    const uppercaseLike = line === line.toUpperCase();
    return titleCaseLike || uppercaseLike;
}

function classifySectionKind(sectionTitle: string): ReadingSectionKind {
    const normalized = sectionTitle.toLowerCase();
    if (normalized.includes('abstract')) return 'abstract';
    if (normalized.includes('introduction') || normalized.includes('background')) return 'introduction';
    if (normalized.includes('related work') || normalized.includes('prior work')) return 'related-work';
    if (normalized.includes('method') || normalized.includes('approach') || normalized.includes('model') || normalized.includes('setup')) return 'methods';
    if (normalized.includes('result') || normalized.includes('evaluation') || normalized.includes('experiment')) return 'results';
    if (normalized.includes('discussion') || normalized.includes('analysis') || normalized.includes('limitation')) return 'discussion';
    if (normalized.includes('conclusion')) return 'conclusion';
    return 'other';
}

function findSectionForOffset(
    headings: Array<{ start: number; end: number; title: string; kind: ReadingSectionKind }>,
    offset: number
): { title: string | null; kind: ReadingSectionKind } {
    let activeSection: { title: string | null; kind: ReadingSectionKind } = { title: null, kind: 'other' };

    for (const heading of headings) {
        if (heading.start > offset) break;
        activeSection = { title: heading.title, kind: heading.kind };
    }

    return activeSection;
}

function scoreCandidate(text: string, sectionKind: ReadingSectionKind, focusMode: string = 'balanced'): number {
    const weights = getSectionWeights(focusMode);
    let score = weights[sectionKind];

    for (const [pattern, delta] of POSITIVE_PATTERNS) {
        if (pattern.test(text)) score += delta;
    }

    for (const [pattern, delta] of NEGATIVE_PATTERNS) {
        if (pattern.test(text)) score += delta;
    }

    const words = getWordCount(text);
    if (words > 30) score -= 3;
    if (words > 22) score -= 1;
    if (/^\s*(we|our)\b/i.test(text)) score += 1;
    if (!/[A-Za-z]/.test(text)) score -= 3;
    if (countCitationMarkers(text) >= 2) score -= 3;

    return score;
}

function repairSpan(span: ReadingHighlightSpan, sourceText: string): ReadingHighlightSpan | null {
    if (typeof span.start === 'number' && typeof span.end === 'number') {
        const safeStart = Math.max(0, Math.min(span.start, sourceText.length));
        const safeEnd = Math.max(safeStart, Math.min(span.end, sourceText.length));
        const slicedText = sourceText.slice(safeStart, safeEnd);
        if (safeEnd > safeStart && (!span.text || slicedText === span.text)) {
            return { ...span, text: slicedText, start: safeStart, end: safeEnd };
        }

        if (span.text) {
            const nearbyStart = Math.max(0, safeStart - 24);
            const nearbyEnd = Math.min(sourceText.length, safeEnd + 24);
            const nearbyIndex = sourceText.slice(nearbyStart, nearbyEnd).indexOf(span.text);
            if (nearbyIndex >= 0) {
                const repairedStart = nearbyStart + nearbyIndex;
                return {
                    ...span,
                    start: repairedStart,
                    end: repairedStart + span.text.length,
                };
            }
        }
    }

    if (!span.text) return null;
    const firstIndex = sourceText.indexOf(span.text);
    if (firstIndex < 0) return null;

    return {
        ...span,
        start: firstIndex,
        end: firstIndex + span.text.length,
    };
}

function trimSpanRange(text: string, start: number, end: number): { start: number; end: number } | null {
    let safeStart = Math.max(0, Math.min(start, text.length));
    let safeEnd = Math.max(safeStart, Math.min(end, text.length));

    while (safeStart < safeEnd && /[\s"'([{]/.test(text[safeStart])) {
        safeStart++;
    }
    while (safeEnd > safeStart && /[\s"')\]}]/.test(text[safeEnd - 1])) {
        safeEnd--;
    }

    if (safeEnd <= safeStart) return null;
    return { start: safeStart, end: safeEnd };
}

function isReadableHighlight(text: string, minChars: number, maxChars: number, maxWords: number): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (trimmed.length < minChars || trimmed.length > maxChars) return false;
    if (getWordCount(trimmed) > maxWords) return false;
    if (/^[^A-Za-z0-9]+$/.test(trimmed)) return false;
    if (/^(figure|table|equation|appendix)\b/i.test(trimmed)) return false;
    if (countCitationMarkers(trimmed) >= 2) return false;
    if (!/[a-z]/i.test(trimmed)) return false;
    return true;
}

function countCitationMarkers(text: string): number {
    const square = text.match(/\[[0-9,\-\s]+\]/g)?.length ?? 0;
    const year = text.match(/\([^)]*\d{4}[^)]*\)/g)?.length ?? 0;
    return square + year;
}

function getWordCount(text: string): number {
    return text.trim().split(/\s+/).filter(Boolean).length;
}

function normalizeForDedup(text: string): string {
    return text.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9% ]/g, '').trim();
}

function getSectionCap(sectionKind: ReadingSectionKind, maxHighlights: number): number {
    switch (sectionKind) {
        case 'results':
            return Math.max(2, Math.ceil(maxHighlights * 0.35));
        case 'methods':
            return Math.max(1, Math.ceil(maxHighlights * 0.25));
        case 'discussion':
        case 'abstract':
            return Math.max(1, Math.ceil(maxHighlights * 0.2));
        default:
            return Math.max(1, Math.ceil(maxHighlights * 0.15));
    }
}
