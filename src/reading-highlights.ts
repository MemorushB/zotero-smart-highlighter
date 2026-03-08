import { type DensityLevel, type FocusMode, type NonLlmLexicalMethod } from './preferences';

export type ReadingHighlightReason = 'claim' | 'result' | 'method' | 'caveat' | 'background';

export interface ReadingHighlightSpan {
    text: string;
    start: number;
    end: number;
    reason?: string;
    confidence?: number;
}

export type ReadingSectionKind = 'abstract' | 'introduction' | 'related-work' | 'methods' | 'results' | 'discussion' | 'conclusion' | 'references' | 'other';

export interface ReadingHighlightCandidate extends ReadingHighlightSpan {
    id: string;
    pageIndex: number;
    sectionTitle: string | null;
    sectionKind: ReadingSectionKind;
    heuristicScore: number;
    lexicalScore?: number;
    finalScore?: number;
}

export interface RankedHighlightSelection {
    id: string;
    reason?: string;
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
    pseudoQuery: string;
}

export interface NonLlmSelectionInput {
    selectionText: string;
    paperTitle?: string | null;
    sectionTitle?: string | null;
    beforeContext?: string;
    afterContext?: string;
}

export interface NonLlmSelectionOptions {
    density?: string;
    lexicalMethod?: string;
}

export interface NonLlmGlobalSelectionOptions {
    lexicalMethod?: string;
}

interface RankedSpanCandidate extends ReadingHighlightSpan {
    heuristicScore: number;
    lexicalScore: number;
    finalScore: number;
}

interface DensityConfig {
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

interface HeadingInfo {
    start: number;
    end: number;
    title: string;
    kind: ReadingSectionKind;
}

interface LexicalDocument {
    tokens: string[];
    termCounts: Map<string, number>;
    length: number;
}

type NoSpaceScriptKind = 'cjk' | 'southeast-asian';

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

const FOCUS_SECTION_WEIGHTS: Record<FocusMode, Record<ReadingSectionKind, number>> = {
    balanced: {
        abstract: 4,
        introduction: 3,
        'related-work': 1,
        methods: 2,
        results: 5,
        discussion: 4,
        conclusion: 3,
        references: -8,
        other: 2,
    },
    'results-first': {
        abstract: 3,
        introduction: 2,
        'related-work': 1,
        methods: 1,
        results: 6,
        discussion: 5,
        conclusion: 3,
        references: -8,
        other: 2,
    },
    'methods-first': {
        abstract: 4,
        introduction: 3,
        'related-work': 1,
        methods: 5,
        results: 3,
        discussion: 2,
        conclusion: 2,
        references: -8,
        other: 2,
    },
    'caveats-first': {
        abstract: 3,
        introduction: 3,
        'related-work': 1,
        methods: 1,
        results: 3,
        discussion: 6,
        conclusion: 5,
        references: -8,
        other: 2,
    },
};

const POSITIVE_PATTERNS: Array<[RegExp, number]> = [
    [/\b(we (propose|present|introduce|show|find|demonstrate|observe|report))\b/i, 4],
    [/\b(outperform|improv(?:e|es|ed)|better than|state-of-the-art|sota|significant(?:ly)?)\b/i, 4],
    [/\b(result|results|finding|findings|evidence|achiev(?:e|es|ed)|yield(?:s|ed)?)\b/i, 3],
    [/\b(limit(?:ation|ations)?|caveat|however|fails?|failure|underperform|boundary|scope|trade-?off)\b/i, 3],
    [/\b(problem|challenge|gap|remains|unclear|little is known|motivat(?:e|es|ion))\b/i, 2],
    [/\b(method|architecture|training|dataset|evaluation|ablat(?:ion|e)|benchmark|protocol|pipeline)\b/i, 2],
    [/\b(precision|recall|f1|accuracy|auc|bleu|rouge|percent|%)\b/i, 2],
    [/\b(novel|contribution|contributions|first to|we argue|we claim|our work)\b/i, 2],
];

const NEGATIVE_PATTERNS: Array<[RegExp, number]> = [
    [/\b(Fig\.?|Figure|Table|Eq\.?|Equation|Appendix|appendix)\b/i, -5],
    [/\bet al\./i, -2],
    [/\b(this|these|it|they|such)\b/i, -1],
    [/\b(related work|in this section|the rest of the paper|as shown in)\b/i, -4],
    [/\[[0-9,\-\s]+\]/, -2],
    [/\([^)]*\d{4}[^)]*\)/, -2],
    [/\bdoi\b|https?:\/\//i, -4],
];

const RESULT_REASON_PATTERNS = /\b(result|results|finding|findings|outperform|improv(?:e|es|ed)|accuracy|f1|precision|recall|auc|bleu|rouge|significant|increase|decrease|gain|achiev(?:e|es|ed)|yield(?:s|ed)?)\b/i;
const METHOD_REASON_PATTERNS = /\b(method|approach|architecture|model|dataset|training|fine-tun|pretrain|benchmark|pipeline|framework|protocol|setup|procedure|algorithm)\b/i;
const CAVEAT_REASON_PATTERNS = /\b(limit(?:ation|ations)?|caveat|however|although|despite|drawback|shortcoming|risk|bias|concern|fails?|failure|scope|boundary|trade-?off)\b/i;
const CLAIM_REASON_PATTERNS = /\b(we propose|we present|we introduce|we argue|we claim|our contribution|contribution|novel|first to|this paper|we show)\b/i;
const BACKGROUND_REASON_PATTERNS = /\b(problem|challenge|gap|motivat(?:e|es|ion)|prior work|previous work|related work|background|existing work|little is known)\b/i;

const REFERENCE_HEADING_PATTERN = /^(references|bibliography|works cited|参考文献|參考文獻|参考資料|參考資料|文献|文獻)$/iu;
const REFERENCE_ENTRY_PATTERN = /^\s*(\[[0-9]+\]|[\p{Lu}\p{L}][\p{L}'`-]+,\s+[\p{Lu}]\.|[\p{Lu}\p{L}][\p{L}'`-]+\s+et al\.)/u;
const HEAVY_PRONOUN_PATTERN = /\b(this|these|it|they|such|former|latter)\b/gi;
const NUMERIC_EVIDENCE_PATTERN = /\b\d+(?:\.\d+)?(?:\s?%|\s?(?:x|times|fold|ms|s|sec|seconds|minutes|hours|k|m|b))?\b/i;
const WORD_TOKEN_CHARACTER_PATTERN = /[\p{L}\p{N}]/u;
const WORD_TOKEN_CONNECTOR_PATTERN = /[-']/u;
const CJK_NO_SPACE_SCRIPT_CHARACTER_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const SOUTHEAST_ASIAN_NO_SPACE_SCRIPT_CHARACTER_PATTERN = /[\p{Script=Thai}\p{Script=Lao}\p{Script=Myanmar}\p{Script=Khmer}]/u;
const COMBINING_OR_JOINER_CHARACTER_PATTERN = /[\p{M}\u200c\u200d]/u;
const UNICODE_LETTER_OR_NUMBER_PATTERN = /[\p{L}\p{N}]/u;
const ASCII_SENTENCE_END_PATTERN = /[.!?]/;
const CJK_SENTENCE_END_PATTERN = /[。！？；：]/u;
const RANGE_SPLIT_PUNCTUATION_PATTERN = /[;:；：,，、]/u;
const RANGE_SPLIT_CONNECTOR_PATTERN = /(?:,\s+(?:but|while|whereas|however|therefore)|，(?:但|而|并且|同時|同时|然而|因此)|、(?:しかし|そして|また))/gu;
const HEADING_LINE_PATTERN = /^[\p{L}\p{N}\s()\-–—/:：&+,，、]+$/u;

const SECTION_KEYWORD_GROUPS: Array<{ kind: ReadingSectionKind; terms: string[] }> = [
    { kind: 'abstract', terms: ['abstract', 'summary', '摘要', '要旨', '초록', '요약'] },
    { kind: 'introduction', terms: ['introduction', 'background', '引言', '绪论', '緒論', '背景', '서론', '소개'] },
    { kind: 'related-work', terms: ['related work', 'prior work', 'related studies', '相关工作', '相關工作', '先行研究', '관련 연구'] },
    { kind: 'methods', terms: ['method', 'methods', 'approach', 'model', 'setup', '方法', '方法论', '方法論', '模型', '手法', '방법'] },
    { kind: 'results', terms: ['result', 'results', 'evaluation', 'experiment', 'experiments', '结果', '結果', '实验', '實驗', '評価', '실험', '결과'] },
    { kind: 'discussion', terms: ['discussion', 'analysis', 'limitation', 'limitations', '讨论', '討論', '分析', '局限', '局限性', '考察', '논의', '한계'] },
    { kind: 'conclusion', terms: ['conclusion', 'conclusions', '结论', '結論', 'まとめ', '결론'] },
    { kind: 'references', terms: ['reference', 'references', 'bibliography', 'works cited', '参考文献', '參考文獻', '参考資料', '參考資料', '文献', '文獻'] },
];

const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'by', 'for', 'from', 'had', 'has', 'have', 'in', 'into', 'is', 'it',
    'its', 'of', 'on', 'or', 'that', 'the', 'their', 'there', 'these', 'this', 'those', 'to', 'was', 'were', 'with', 'we', 'our', 'you',
    'your', 'they', 'them', 'he', 'she', 'his', 'her', 'than', 'then', 'which', 'while', 'where', 'when', 'what', 'how', 'can', 'could',
    'should', 'would', 'may', 'might', 'must', 'will', 'also', 'using', 'used', 'use', 'based', 'paper', 'study', 'results', 'method',
    'methods', 'approach', 'model', 'models', 'data', 'task', 'tasks', 'show', 'shows', 'shown', 'find', 'finds', 'found', 'propose',
    'present', 'introduce', 'new', 'via', 'over', 'under', 'between', 'within', 'across', 'after', 'before', 'during', 'through',
    'more', 'most', 'less', 'many', 'much', 'other', 'than', 'such', 'each', 'both', 'all', 'any', 'some', 'few', 'do', 'does', 'did',
    'not', 'no', 'yes', 'if', 'but', 'however', 'because', 'due', 'than', 'thus', 'therefore', 'toward', 'towards', 'per'
]);

export function getDensityConfig(density: string): DensityConfig {
    return DENSITY_CONFIGS[density as DensityLevel] ?? DENSITY_CONFIGS.balanced;
}

export function getSectionWeights(focusMode: string): Record<ReadingSectionKind, number> {
    return FOCUS_SECTION_WEIGHTS[focusMode as FocusMode] ?? FOCUS_SECTION_WEIGHTS.balanced;
}

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

export function inferHighlightReason(text: string, sectionKind: ReadingSectionKind = 'other'): ReadingHighlightReason {
    if (RESULT_REASON_PATTERNS.test(text)) return 'result';
    if (METHOD_REASON_PATTERNS.test(text)) return 'method';
    if (CAVEAT_REASON_PATTERNS.test(text)) return 'caveat';
    if (CLAIM_REASON_PATTERNS.test(text)) return 'claim';
    if (BACKGROUND_REASON_PATTERNS.test(text)) return 'background';

    switch (sectionKind) {
        case 'results':
            return 'result';
        case 'methods':
            return 'method';
        case 'discussion':
            return 'caveat';
        case 'abstract':
        case 'conclusion':
            return 'claim';
        default:
            return 'background';
    }
}

export function validateQuickHighlightSpans(spans: ReadingHighlightSpan[], selectionText: string, density: string = 'balanced'): ReadingHighlightSpan[] {
    return validateHighlightSpans(spans, selectionText, getQuickHighlightDefaults(density));
}

export function extractSelectionHighlightsNonLlm(
    input: NonLlmSelectionInput,
    options: NonLlmSelectionOptions = {}
): ReadingHighlightSpan[] {
    const selectionText = input.selectionText.trim();
    if (!selectionText) return [];

    const density = options.density ?? 'balanced';
    const lexicalMethod = resolveLexicalMethod(options.lexicalMethod);
    const defaults = getQuickHighlightDefaults(density);
    const sectionKind = input.sectionTitle ? classifySectionKind(input.sectionTitle) : 'other';
    const ranges = splitSentenceLikeRanges(input.selectionText, defaults.maxChars);
    const candidates: RankedSpanCandidate[] = [];

    for (const range of ranges) {
        const trimmed = trimSpanRange(input.selectionText, range.start, range.end);
        if (!trimmed) continue;

        const text = input.selectionText.slice(trimmed.start, trimmed.end);
        if (!isReadableHighlight(text, defaults.minChars, defaults.maxChars, defaults.maxWords)) continue;

        const heuristicScore = scoreCandidate(text, sectionKind, 'balanced');
        if (heuristicScore < 2) continue;

        candidates.push({
            text,
            start: trimmed.start,
            end: trimmed.end,
            reason: inferHighlightReason(text, sectionKind),
            heuristicScore,
            lexicalScore: 0,
            finalScore: 0,
        });
    }

    if (!candidates.length) return [];

    const pseudoQuery = buildSelectionPseudoQuery(input);
    const lexicalScores = scoreLexicalDocuments(candidates.map(candidate => candidate.text), pseudoQuery, lexicalMethod);
    const heuristicScores = normalizeScores(candidates.map(candidate => candidate.heuristicScore));

    const ranked = candidates
        .map((candidate, index) => {
            const lexicalScore = lexicalScores[index] ?? 0;
            const heuristicScore = heuristicScores[index] ?? 0;
            const finalScore = (heuristicScore * 0.72) + (lexicalScore * 0.28);
            return {
                ...candidate,
                lexicalScore,
                finalScore,
                confidence: clamp01(finalScore),
            };
        })
        .filter(candidate => candidate.finalScore >= 0.22)
        .sort((left, right) => {
            if (right.finalScore !== left.finalScore) return right.finalScore - left.finalScore;
            if (right.heuristicScore !== left.heuristicScore) return right.heuristicScore - left.heuristicScore;
            return left.start - right.start;
        });

    return validateQuickHighlightSpans(ranked, input.selectionText, density);
}

export function prepareGlobalHighlightSelection(
    pages: PaperPageText[],
    density: string = 'balanced',
    focusMode: string = 'balanced',
    paperTitle?: string | null
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
        pseudoQuery: buildGlobalPseudoQuery(pages, candidates, paperTitle),
    };
}

export function selectGlobalHighlightCandidateIdsNonLlm(
    prepared: PreparedGlobalHighlightSelection,
    options: NonLlmGlobalSelectionOptions = {}
): RankedHighlightSelection[] {
    if (!prepared.shortlist.length || prepared.maxHighlights <= 0) return [];

    const lexicalMethod = resolveLexicalMethod(options.lexicalMethod);
    const lexicalScores = scoreLexicalDocuments(
        prepared.shortlist.map(candidate => candidate.text),
        prepared.pseudoQuery,
        lexicalMethod
    );
    const heuristicScores = normalizeScores(prepared.shortlist.map(candidate => candidate.heuristicScore));

    const rankedCandidates = prepared.shortlist
        .map((candidate, index) => {
            const lexicalScore = lexicalScores[index] ?? 0;
            const heuristicScore = heuristicScores[index] ?? 0;
            const reason = candidate.reason ?? inferHighlightReason(candidate.text, candidate.sectionKind);
            const reasonBonus = getReasonSectionAlignmentBonus(reason, candidate.sectionKind);
            const finalScore = (heuristicScore * 0.68) + (lexicalScore * 0.32) + reasonBonus;

            return {
                ...candidate,
                reason,
                lexicalScore,
                finalScore,
            };
        })
        .filter(candidate => candidate.finalScore >= 0.2)
        .sort((left, right) => {
            if (right.finalScore !== left.finalScore) return right.finalScore - left.finalScore;
            if (right.heuristicScore !== left.heuristicScore) return right.heuristicScore - left.heuristicScore;
            if (right.lexicalScore !== left.lexicalScore) return right.lexicalScore - left.lexicalScore;
            if (left.pageIndex !== right.pageIndex) return left.pageIndex - right.pageIndex;
            return left.start - right.start;
        });

    return rankedCandidates.map(candidate => ({
        id: candidate.id,
        reason: candidate.reason,
    }));
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
    const minScore = minConfidence > 0 ? Math.ceil(2 + minConfidence * 6) : 0;

    for (const candidateId of selectedIds) {
        if (seenIds.has(candidateId)) continue;
        seenIds.add(candidateId);

        const candidate = lookup.get(candidateId);
        if (!candidate) continue;
        if (candidate.sectionKind === 'references') continue;
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
        if (candidate.sectionKind === 'references') continue;

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
        if (section.kind === 'references') continue;

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
            reason: inferHighlightReason(text, section.kind),
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
        const boundaryFromPunctuation = isSentenceBoundaryAt(text, index);
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

    const ranges: Array<{ start: number; end: number }> = [];
    let localStart = 0;
    const minChars = 16;
    const splitPoints = collectLongRangeSplitPoints(raw, minChars);

    if (!splitPoints.length) {
        return forceSplitLongRange(range, maxChars, minChars, text);
    }

    while ((raw.length - localStart) > maxChars) {
        let bestSplitPoint = -1;

        for (const splitPoint of splitPoints) {
            if (splitPoint <= localStart) continue;
            if ((splitPoint - localStart) < minChars) continue;
            if ((splitPoint - localStart) > maxChars) break;
            bestSplitPoint = splitPoint;
        }

        const localEnd = bestSplitPoint >= 0
            ? bestSplitPoint
            : findForcedSplitEnd(text, range.start + localStart, range.end, maxChars, minChars) - range.start;
        if (localEnd <= localStart) {
            break;
        }

        ranges.push({
            start: range.start + localStart,
            end: range.start + localEnd,
        });
        localStart = localEnd;
    }

    if ((raw.length - localStart) >= minChars) {
        ranges.push({ start: range.start + localStart, end: range.end });
    }

    return ranges.length ? ranges : forceSplitLongRange(range, maxChars, minChars, text);
}

function extractSectionHeadings(text: string): HeadingInfo[] {
    const headings: HeadingInfo[] = [];
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
    if (/[.!?。！？；：]$/u.test(line)) return false;

    const words = line.split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 12) return false;
    if (!UNICODE_LETTER_OR_NUMBER_PATTERN.test(line)) return false;
    if (!HEADING_LINE_PATTERN.test(line)) return false;

    const normalized = normalizeHeadingText(line);
    if (classifySectionKind(normalized) !== 'other') {
        return true;
    }

    const titleCaseLike = words.every(word => /^[\p{Lu}\p{N}][\p{L}\p{N}-]*$/u.test(word));
    const uppercaseLike = normalized === normalized.toUpperCase() && normalized !== normalized.toLowerCase();
    return titleCaseLike || uppercaseLike;
}

function classifySectionKind(sectionTitle: string): ReadingSectionKind {
    const normalized = normalizeHeadingText(sectionTitle);
    for (const group of SECTION_KEYWORD_GROUPS) {
        if (group.terms.some(term => normalized.includes(term))) {
            return group.kind;
        }
    }
    return 'other';
}

function isSentenceBoundaryAt(text: string, index: number): boolean {
    const current = text[index] ?? '';
    const isAsciiBoundary = ASCII_SENTENCE_END_PATTERN.test(current);
    const isCjkBoundary = CJK_SENTENCE_END_PATTERN.test(current);
    if (!isAsciiBoundary && !isCjkBoundary) return false;

    const nextContentIndex = findNextContentIndex(text, index + 1);
    if (nextContentIndex < 0) return true;

    const nextContent = text[nextContentIndex] ?? '';
    if (!looksLikeSentenceStart(nextContent)) return false;

    if (isCjkBoundary) return true;
    return nextContentIndex > index + 1;
}

function findNextContentIndex(text: string, start: number): number {
    for (let index = start; index < text.length; index++) {
        if (/\s/.test(text[index])) {
            continue;
        }
        return index;
    }
    return -1;
}

function looksLikeSentenceStart(character: string): boolean {
    if (!character) return false;
    return /[\p{L}\p{N}(\[{"'“”‘’「『（【《]/u.test(character);
}

function collectLongRangeSplitPoints(raw: string, minChars: number): number[] {
    const splitPoints = new Set<number>();

    for (const match of raw.matchAll(RANGE_SPLIT_CONNECTOR_PATTERN)) {
        const matchIndex = match.index ?? -1;
        const localEnd = matchIndex + match[0].length;
        if (matchIndex >= 0 && localEnd >= minChars) {
            splitPoints.add(localEnd);
        }
    }

    for (let index = 0; index < raw.length; index++) {
        if (!RANGE_SPLIT_PUNCTUATION_PATTERN.test(raw[index])) continue;
        const localEnd = index + 1;
        if (localEnd >= minChars) {
            splitPoints.add(localEnd);
        }
    }

    return [...splitPoints].sort((left, right) => left - right);
}

function forceSplitLongRange(
    range: { start: number; end: number },
    maxChars: number,
    minChars: number,
    text: string
): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    let chunkStart = range.start;

    while ((range.end - chunkStart) > maxChars) {
        const preferredEnd = findForcedSplitEnd(text, chunkStart, range.end, maxChars, minChars);
        if (preferredEnd <= chunkStart) {
            break;
        }
        ranges.push({ start: chunkStart, end: preferredEnd });
        chunkStart = preferredEnd;
    }

    if ((range.end - chunkStart) >= minChars) {
        ranges.push({ start: chunkStart, end: range.end });
    }

    return ranges.length ? ranges : [range];
}

function findForcedSplitEnd(text: string, start: number, end: number, maxChars: number, minChars: number): number {
    const preferred = Math.min(end, start + maxChars);
    const minEnd = Math.min(end, start + minChars);

    for (let index = preferred; index >= minEnd; index--) {
        const current = text[index - 1] ?? '';
        if (RANGE_SPLIT_PUNCTUATION_PATTERN.test(current) || /\s/u.test(current)) {
            return index;
        }
    }

    return preferred;
}

function normalizeHeadingText(sectionTitle: string): string {
    return sectionTitle
        .normalize('NFKC')
        .toLowerCase()
        .replace(/^[\p{N}\s.．、,，:：()（）\[\]【】-]+/u, '')
        .replace(/\s+/gu, ' ')
        .trim();
}

function findSectionForOffset(headings: HeadingInfo[], offset: number): { title: string | null; kind: ReadingSectionKind } {
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

    if (sectionKind === 'references' || isReferenceLikeText(text)) {
        score -= 12;
    }

    const words = getWordCount(text);
    if (words > 30) score -= 3;
    if (words > 22) score -= 1;
    if (/^\s*(we|our)\b/i.test(text)) score += 1;
    if (NUMERIC_EVIDENCE_PATTERN.test(text)) score += 1;
    if (!UNICODE_LETTER_OR_NUMBER_PATTERN.test(text)) score -= 3;
    if (countCitationMarkers(text) >= 2) score -= 3;
    if (countAmbiguousPronouns(text) >= 2) score -= 2;

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
    if (!UNICODE_LETTER_OR_NUMBER_PATTERN.test(trimmed)) return false;
    if (/^(figure|table|equation|appendix)\b/i.test(trimmed)) return false;
    if (countCitationMarkers(trimmed) >= 2) return false;
    if (isReferenceLikeText(trimmed)) return false;
    return true;
}

function countCitationMarkers(text: string): number {
    const square = text.match(/\[[0-9,\-\s]+\]/g)?.length ?? 0;
    const year = text.match(/\([^)]*\d{4}[^)]*\)/g)?.length ?? 0;
    return square + year;
}

function countAmbiguousPronouns(text: string): number {
    return text.match(HEAVY_PRONOUN_PATTERN)?.length ?? 0;
}

function getWordCount(text: string): number {
    const normalized = text.normalize('NFKC').trim();
    if (!normalized) return 0;

    let count = 0;
    let wordStart = -1;

    const flushWord = (end: number) => {
        if (wordStart < 0) return;
        if (end > wordStart) {
            count += 1;
        }
        wordStart = -1;
    };

    for (let index = 0; index < normalized.length; index++) {
        const character = normalized[index] ?? '';
        const noSpaceScriptKind = getNoSpaceScriptKind(character);

        if (noSpaceScriptKind) {
            flushWord(index);

            let runEnd = index + 1;
            while (runEnd < normalized.length && isNoSpaceScriptContinuation(normalized[runEnd] ?? '', noSpaceScriptKind)) {
                runEnd++;
            }

            count += estimateNoSpaceScriptWordCount(normalized.slice(index, runEnd), noSpaceScriptKind);
            index = runEnd - 1;
            continue;
        }

        if (WORD_TOKEN_CHARACTER_PATTERN.test(character)) {
            if (wordStart < 0) {
                wordStart = index;
            }
            continue;
        }

        const nextCharacter = normalized[index + 1] ?? '';
        const isInnerConnector = wordStart >= 0
            && WORD_TOKEN_CONNECTOR_PATTERN.test(character)
            && WORD_TOKEN_CHARACTER_PATTERN.test(nextCharacter);
        if (isInnerConnector) {
            continue;
        }

        flushWord(index);
    }

    flushWord(normalized.length);
    return count;
}

function normalizeForDedup(text: string): string {
    return text
        .normalize('NFKC')
        .toLowerCase()
        .replace(/\s+/gu, ' ')
        .replace(/[^\p{L}\p{N}% ]/gu, '')
        .trim();
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
        case 'references':
            return 0;
        default:
            return Math.max(1, Math.ceil(maxHighlights * 0.15));
    }
}

function resolveLexicalMethod(method: string | undefined): NonLlmLexicalMethod {
    return method === 'tfidf' ? 'tfidf' : 'bm25';
}

function buildSelectionPseudoQuery(input: NonLlmSelectionInput): string {
    const contextTerms = extractTopTerms(`${input.beforeContext ?? ''} ${input.afterContext ?? ''}`, 8);
    const titleTerms = extractTopTerms(`${input.paperTitle ?? ''} ${input.sectionTitle ?? ''}`, 8);
    const fallbackTerms = extractTopTerms(input.selectionText, 10);
    const queryParts = [
        input.paperTitle?.trim() || '',
        input.sectionTitle?.trim() || '',
        titleTerms.join(' '),
        contextTerms.join(' '),
    ].filter(Boolean);

    if (!queryParts.length) {
        queryParts.push(fallbackTerms.join(' '));
    }

    return queryParts.join(' ');
}

function buildGlobalPseudoQuery(
    pages: PaperPageText[],
    candidates: ReadingHighlightCandidate[],
    paperTitle?: string | null
): string {
    const headings = pages.flatMap(page => extractSectionHeadings(page.text))
        .filter(heading => heading.kind !== 'references')
        .map(heading => heading.title);
    const abstractSnippets = candidates
        .filter(candidate => candidate.sectionKind === 'abstract' || candidate.sectionKind === 'introduction')
        .sort((left, right) => right.heuristicScore - left.heuristicScore)
        .slice(0, 6)
        .map(candidate => candidate.text);
    const keywordPool = [
        paperTitle?.trim() || '',
        headings.slice(0, 12).join(' '),
        abstractSnippets.join(' '),
        extractTopTerms(candidates.map(candidate => candidate.text).join(' '), 24).join(' '),
    ].filter(Boolean);

    return keywordPool.join(' ');
}

function extractTopTerms(text: string, limit: number): string[] {
    const frequencies = new Map<string, number>();
    for (const token of tokenizeText(text)) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }

    return [...frequencies.entries()]
        .sort((left, right) => {
            if (right[1] !== left[1]) return right[1] - left[1];
            if (right[0].length !== left[0].length) return right[0].length - left[0].length;
            return left[0].localeCompare(right[0]);
        })
        .slice(0, limit)
        .map(([token]) => token);
}

function tokenizeText(text: string): string[] {
    const normalized = text.toLowerCase().normalize('NFKC');
    const tokens: string[] = [];
    let wordBuffer = '';

    const flushWordBuffer = () => {
        if (wordBuffer.length > 1 && !STOPWORDS.has(wordBuffer)) {
            tokens.push(wordBuffer);
        }
        wordBuffer = '';
    };

    for (let index = 0; index < normalized.length; index++) {
        const character = normalized[index] ?? '';
        const noSpaceScriptKind = getNoSpaceScriptKind(character);

        if (noSpaceScriptKind) {
            flushWordBuffer();

            let runEnd = index + 1;
            while (runEnd < normalized.length && isNoSpaceScriptContinuation(normalized[runEnd] ?? '', noSpaceScriptKind)) {
                runEnd++;
            }

            tokens.push(...tokenizeNoSpaceScriptRun(normalized.slice(index, runEnd), noSpaceScriptKind));
            index = runEnd - 1;
            continue;
        }

        if (WORD_TOKEN_CHARACTER_PATTERN.test(character)) {
            wordBuffer += character;
            continue;
        }

        const nextCharacter = normalized[index + 1] ?? '';
        const isInnerConnector = wordBuffer.length > 0
            && WORD_TOKEN_CONNECTOR_PATTERN.test(character)
            && WORD_TOKEN_CHARACTER_PATTERN.test(nextCharacter);
        if (isInnerConnector) {
            wordBuffer += character;
            continue;
        }

        flushWordBuffer();
    }

    flushWordBuffer();
    return tokens;
}

function getNoSpaceScriptKind(character: string): NoSpaceScriptKind | null {
    if (CJK_NO_SPACE_SCRIPT_CHARACTER_PATTERN.test(character)) return 'cjk';
    if (SOUTHEAST_ASIAN_NO_SPACE_SCRIPT_CHARACTER_PATTERN.test(character)) return 'southeast-asian';
    return null;
}

function isNoSpaceScriptContinuation(character: string, scriptKind: NoSpaceScriptKind): boolean {
    if (COMBINING_OR_JOINER_CHARACTER_PATTERN.test(character)) return true;
    return getNoSpaceScriptKind(character) === scriptKind;
}

function splitNoSpaceScriptUnits(text: string, scriptKind: NoSpaceScriptKind): string[] {
    const units: string[] = [];
    let currentUnit = '';

    for (const character of [...text]) {
        if (isNoSpaceScriptContinuation(character, scriptKind)) {
            currentUnit += character;
            continue;
        }

        if (currentUnit) {
            units.push(currentUnit);
        }
        currentUnit = character;
    }

    if (currentUnit) {
        units.push(currentUnit);
    }

    return units;
}

function estimateNoSpaceScriptWordCount(text: string, scriptKind: NoSpaceScriptKind): number {
    const units = splitNoSpaceScriptUnits(text, scriptKind);
    if (!units.length) return 0;

    const estimatedUnitsPerWord = scriptKind === 'cjk' ? 2 : 4;
    return Math.ceil(units.length / estimatedUnitsPerWord);
}

function tokenizeNoSpaceScriptRun(text: string, scriptKind: NoSpaceScriptKind): string[] {
    const units = splitNoSpaceScriptUnits(text, scriptKind);
    if (units.length === 0) return [];

    const tokens = [...units];
    for (let index = 0; index < units.length - 1; index++) {
        tokens.push(units[index] + units[index + 1]);
    }

    return tokens;
}

function buildLexicalDocument(text: string): LexicalDocument {
    const tokens = tokenizeText(text);
    const termCounts = new Map<string, number>();
    for (const token of tokens) {
        termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
    }
    return {
        tokens,
        termCounts,
        length: tokens.length,
    };
}

function scoreLexicalDocuments(documents: string[], query: string, method: NonLlmLexicalMethod): number[] {
    if (!documents.length) return [];

    const lexicalDocuments = documents.map(buildLexicalDocument);
    const queryDocument = buildLexicalDocument(query);
    if (!queryDocument.tokens.length) {
        return new Array(documents.length).fill(0);
    }

    const df = new Map<string, number>();
    for (const document of lexicalDocuments) {
        const seenTerms = new Set(document.tokens);
        for (const token of seenTerms) {
            df.set(token, (df.get(token) ?? 0) + 1);
        }
    }

    const rawScores = method === 'tfidf'
        ? scoreWithTfidf(lexicalDocuments, queryDocument, df)
        : scoreWithBm25(lexicalDocuments, queryDocument, df);

    return normalizeScores(rawScores);
}

function scoreWithTfidf(
    documents: LexicalDocument[],
    query: LexicalDocument,
    df: Map<string, number>
): number[] {
    const totalDocuments = documents.length;
    const queryWeights = new Map<string, number>();

    for (const [token, count] of query.termCounts) {
        const idf = Math.log((totalDocuments + 1) / ((df.get(token) ?? 0) + 1)) + 1;
        queryWeights.set(token, count * idf);
    }

    const queryNorm = Math.sqrt([...queryWeights.values()].reduce((sum, value) => sum + (value * value), 0));
    if (!queryNorm) return new Array(documents.length).fill(0);

    return documents.map(document => {
        let dotProduct = 0;
        let docNormSquared = 0;

        for (const [token, count] of document.termCounts) {
            const idf = Math.log((totalDocuments + 1) / ((df.get(token) ?? 0) + 1)) + 1;
            const weight = count * idf;
            docNormSquared += weight * weight;
            const queryWeight = queryWeights.get(token) ?? 0;
            if (queryWeight) {
                dotProduct += weight * queryWeight;
            }
        }

        const docNorm = Math.sqrt(docNormSquared);
        if (!docNorm) return 0;
        return dotProduct / (queryNorm * docNorm);
    });
}

function scoreWithBm25(
    documents: LexicalDocument[],
    query: LexicalDocument,
    df: Map<string, number>
): number[] {
    const totalDocuments = documents.length;
    const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / Math.max(totalDocuments, 1);
    const k1 = 1.2;
    const b = 0.75;

    return documents.map(document => {
        let score = 0;
        for (const token of query.tokens) {
            const frequency = document.termCounts.get(token) ?? 0;
            if (!frequency) continue;

            const documentFrequency = df.get(token) ?? 0;
            const idf = Math.log(1 + ((totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5)));
            const denominator = frequency + k1 * (1 - b + (b * document.length) / Math.max(averageLength, 1));
            score += idf * ((frequency * (k1 + 1)) / denominator);
        }
        return score;
    });
}

function normalizeScores(scores: number[]): number[] {
    const maxScore = Math.max(...scores, 0);
    if (maxScore <= 0) {
        return scores.map(() => 0);
    }

    return scores.map(score => clamp01(score / maxScore));
}

function getReasonSectionAlignmentBonus(reason: string | undefined, sectionKind: ReadingSectionKind): number {
    switch (reason) {
        case 'result':
            return sectionKind === 'results' || sectionKind === 'abstract' ? 0.06 : 0;
        case 'method':
            return sectionKind === 'methods' ? 0.06 : 0;
        case 'caveat':
            return sectionKind === 'discussion' || sectionKind === 'conclusion' ? 0.05 : 0;
        case 'claim':
            return sectionKind === 'abstract' || sectionKind === 'introduction' || sectionKind === 'conclusion' ? 0.04 : 0;
        case 'background':
            return sectionKind === 'introduction' ? 0.03 : 0;
        default:
            return 0;
    }
}

function isReferenceLikeText(text: string): boolean {
    if (REFERENCE_HEADING_PATTERN.test(text.trim())) return true;
    if (REFERENCE_ENTRY_PATTERN.test(text.trim()) && countCitationMarkers(text) >= 1) return true;
    return /\b(pp?\.?\s*\d+|vol\.?\s*\d+|no\.?\s*\d+)\b/i.test(text) && countCitationMarkers(text) >= 1;
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}
