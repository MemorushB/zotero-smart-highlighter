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

const QUICK_MIN_CHARS = 16;
const QUICK_MAX_CHARS = 140;
const QUICK_MAX_WORDS = 24;
const QUICK_MAX_HIGHLIGHTS = 2;

const GLOBAL_MIN_CHARS = 24;
const GLOBAL_MAX_CHARS = 220;
const GLOBAL_MAX_WORDS = 36;
const GLOBAL_SHORTLIST_SIZE = 36;

const SECTION_WEIGHT: Record<ReadingSectionKind, number> = {
    abstract: 4,
    introduction: 3,
    'related-work': 1,
    methods: 2,
    results: 5,
    discussion: 4,
    conclusion: 3,
    other: 2,
};

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

export function getQuickHighlightDefaults(): QuickHighlightDefaults {
    return {
        minChars: QUICK_MIN_CHARS,
        maxChars: QUICK_MAX_CHARS,
        maxWords: QUICK_MAX_WORDS,
        maxHighlights: QUICK_MAX_HIGHLIGHTS,
    };
}

export function getGlobalHighlightDefaults(totalPages: number): GlobalHighlightDefaults {
    const safePageCount = Math.max(1, totalPages);
    return {
        minChars: GLOBAL_MIN_CHARS,
        maxChars: GLOBAL_MAX_CHARS,
        maxWords: GLOBAL_MAX_WORDS,
        shortlistSize: GLOBAL_SHORTLIST_SIZE,
        maxHighlights: Math.min(18, Math.max(6, Math.ceil(safePageCount * 1.5))),
        maxPerPage: 2,
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

export function validateQuickHighlightSpans(spans: ReadingHighlightSpan[], selectionText: string): ReadingHighlightSpan[] {
    return validateHighlightSpans(spans, selectionText, getQuickHighlightDefaults());
}

export function prepareGlobalHighlightSelection(pages: PaperPageText[]): PreparedGlobalHighlightSelection {
    const defaults = getGlobalHighlightDefaults(pages.length);
    const candidates = pages.flatMap(page => extractPageHighlightCandidates(page, defaults));
    const shortlist = buildShortlist(candidates, defaults.shortlistSize);

    return {
        candidates,
        shortlist,
        maxHighlights: defaults.maxHighlights,
        maxPerPage: defaults.maxPerPage,
    };
}

export function finalizeGlobalHighlightSelection(
    prepared: PreparedGlobalHighlightSelection,
    selectedIds: string[]
): ReadingHighlightCandidate[] {
    const lookup = new Map(prepared.shortlist.map(candidate => [candidate.id, candidate]));
    const seenIds = new Set<string>();
    const seenTexts = new Set<string>();
    const perPageCount = new Map<number, number>();
    const perSectionCount = new Map<ReadingSectionKind, number>();
    const ordered: ReadingHighlightCandidate[] = [];

    for (const candidateId of selectedIds) {
        if (seenIds.has(candidateId)) continue;
        seenIds.add(candidateId);

        const candidate = lookup.get(candidateId);
        if (!candidate) continue;

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

function buildShortlist(candidates: ReadingHighlightCandidate[], shortlistSize: number): ReadingHighlightCandidate[] {
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
        if (pageCount >= 4) continue;

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
    defaults: GlobalHighlightDefaults
): ReadingHighlightCandidate[] {
    const headings = extractSectionHeadings(page.text);
    const sentenceRanges = splitSentenceLikeRanges(page.text);
    const candidates: ReadingHighlightCandidate[] = [];
    let candidateIndex = 0;

    for (const range of sentenceRanges) {
        const trimmed = trimSpanRange(page.text, range.start, range.end);
        if (!trimmed) continue;

        const text = page.text.slice(trimmed.start, trimmed.end);
        if (!isReadableHighlight(text, defaults.minChars, defaults.maxChars, defaults.maxWords)) continue;

        const section = findSectionForOffset(headings, trimmed.start);
        const heuristicScore = scoreCandidate(text, section.kind);
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

function splitSentenceLikeRanges(text: string): Array<{ start: number; end: number }> {
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

    return ranges.flatMap(range => splitLongRange(text, range));
}

function splitLongRange(text: string, range: { start: number; end: number }): Array<{ start: number; end: number }> {
    const raw = text.slice(range.start, range.end);
    if (raw.length <= GLOBAL_MAX_CHARS) return [range];

    const breakpoints = Array.from(raw.matchAll(/(;|:|, but |, while |, whereas )/gi));
    if (!breakpoints.length) return [range];

    const ranges: Array<{ start: number; end: number }> = [];
    let localStart = 0;

    for (const breakpoint of breakpoints) {
        const matchIndex = breakpoint.index ?? -1;
        if (matchIndex <= localStart) continue;

        const localEnd = matchIndex + breakpoint[0].length;
        if (localEnd - localStart < GLOBAL_MIN_CHARS) continue;

        ranges.push({
            start: range.start + localStart,
            end: range.start + localEnd,
        });
        localStart = localEnd;
    }

    if (range.end - (range.start + localStart) >= GLOBAL_MIN_CHARS) {
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

function scoreCandidate(text: string, sectionKind: ReadingSectionKind): number {
    let score = SECTION_WEIGHT[sectionKind];

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
