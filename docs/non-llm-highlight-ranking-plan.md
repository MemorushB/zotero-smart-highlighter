# Non-LLM Highlight Ranking Plan

## Objective

Add a fast, local, non-LLM path for selecting text worth reading in scientific papers. The immediate goal is not perfect semantic understanding. It is a practical ranking pipeline that is cheap to run, responsive inside Zotero, and good enough to surface useful claims, results, methods, and caveats without calling a remote model.

This plan is for future work on branch `non-llm-highlight-ranking`.

## Why a Non-LLM Path Is Worth Adding

- It improves speed for selection-time interaction and makes full-paper ranking feel more lightweight.
- It removes API cost and network dependency for a core reading-assistant workflow.
- It enables fully local execution, which is useful for privacy-sensitive papers and offline use.
- It gives the plugin a robust fallback when LLM output is slow, unavailable, or inconsistent.
- It is engineering-friendly: deterministic, debuggable, and easy to tune with thresholds and feature weights.

## Recommended Architecture

The recommended high-level design is a hybrid:

1. parse text into candidate spans with offsets and section metadata
2. score candidates with section-aware heuristics
3. rank candidates with lightweight lexical relevance features
4. apply filtering, deduplication, and per-page / per-section budgets
5. return validated spans through the existing annotation pipeline

This should reuse the current repo split between:

- `src/bootstrap.ts` for reader integration, selection capture, page text extraction, and annotation rendering
- `src/reading-highlights.ts` for candidate extraction, span validation, section inference, and final selection rules
- `src/preferences.ts` for toggles, thresholds, and future mode selection

The existing LLM path should remain intact. The non-LLM path should be an alternative ranking backend, not a rewrite of the reader integration layer.

Backend selection should be explicit at the product level:

- if the user has not filled in an API key, default to the non-LLM backend
- if an API key is present, the LLM backend can be used
- if the LLM backend throws an error at runtime, automatically fall back to the non-LLM backend

This means non-LLM is not only an optional backend. It is also the default no-key path and the resilience fallback path.

## Phase 1 Default Approach: Heuristic + Lexical Hybrid

Phase 1 should use `section-aware heuristics + lexical ranking`.

Recommended default formula:

`final_score = heuristic_score + lexical_score + small_optional_graph_bonus - penalties`

Where:

- `heuristic_score` captures section priors, cue phrases, claim/result/method/caveat markers, and readability checks
- `lexical_score` comes from BM25 or TF-IDF against a pseudo-query
- `small_optional_graph_bonus` is reserved for TextRank/LexRank style salience if it helps, but it should not be the only ranking signal
- `penalties` suppress citations, references, boilerplate, and low-readability spans

This matches the product constraint: fast, practical, and local-first.

## Proposed Scoring Features

### Section Prior

Assign a base prior from inferred section kind.

- High prior: `abstract`, `results`, `discussion`, `conclusion`
- Medium prior: `introduction`, `methods`
- Low prior: `related-work`, `other`
- Near-zero or hard filter: `references`, bibliography-like text, acknowledgments-like boilerplate

The repo already has section inference and section weighting in `src/reading-highlights.ts`, so Phase 1 should extend that logic rather than introduce a separate section classifier.

### Cue Phrase Signals

Boost spans containing short academic cue phrases such as:

- contribution cues: `we propose`, `we present`, `our approach`, `this paper`
- result cues: `we find`, `results show`, `significantly`, `outperforms`
- method cues: `we use`, `trained on`, `dataset`, `architecture`, `ablation`
- caveat cues: `however`, `limitation`, `fails when`, `we caution`

These should be implemented as transparent regex- or token-based feature groups with separate weights.

### Result / Method / Claim / Caveat Markers

Keep the existing reason taxonomy and make it explicit in non-LLM scoring.

- `claim`: contribution, novelty, central framing
- `result`: empirical outcome, comparison, quantitative finding
- `method`: design choice, data setup, implementation detail that matters
- `caveat`: limitation, assumption, failure case, scope boundary

Phase 1 does not need full discourse parsing. Simple marker families plus section priors are sufficient.

### Title / Abstract / Heading Overlap

Boost spans that overlap with the paper title, abstract terms, section heading terms, and author keywords when available.

For full-paper mode, the pseudo-query should be:

`title + abstract + section headings + author keywords`

This is the main query representation for BM25 or TF-IDF ranking.

### Citation / Reference Penalties

Apply penalties to spans that are likely to be low-value reading targets.

- heavy citation density: many bracketed or parenthetical citations relative to words
- reference-list structure: author-year patterns, DOI-heavy lines, venue strings, page ranges
- figure/table narration: `Figure 2`, `Table 1`, `Eq. (3)` when the sentence is mostly pointer text
- related-work-only comparison sentences with little paper-specific substance

The plugin already uses citation-style penalties in `src/reading-highlights.ts`; this should be expanded and separated into clearer feature names.

### Readability / Boilerplate Filters

Reject or downweight spans that are not good standalone highlights.

- too short, too long, or too many words
- pronoun-heavy and hard to interpret out of context
- section headers, transition sentences, or template boilerplate
- spans dominated by symbols, formulas, or references
- low-information academic filler such as `the rest of the paper is organized as follows`

This fits the current validation philosophy already implemented for reading highlights.

## How It Should Work in the Two Product Modes

### Selection Mode

Selection mode should stay local and fast.

1. Split the selected text into sentence-like or clause-like candidates.
2. Infer local section title from surrounding page text if available.
3. Score candidates with heuristic features only, or heuristic + lightweight local TF-IDF against `selection heading + nearby context`.
4. Return only in-selection spans after existing validation and deduplication.
5. Allow no-highlight output if nothing passes threshold.

Default recommendation: do not run full BM25 infrastructure for tiny selections unless it is already shared code. Heuristics should handle most of this mode.

### Full-Paper Mode

Full-paper mode should use the full hybrid stack.

1. Extract page text and candidate spans for the entire paper.
2. Infer section kind and section title per candidate.
3. Build the pseudo-query from title, abstract, headings, and author keywords.
4. Compute lexical rank with BM25 or TF-IDF.
5. Blend lexical rank with heuristic features.
6. Apply penalties, deduplication, per-page caps, and per-section caps.
7. Return the top candidates to the existing annotation pipeline.

This mode should replace the current LLM candidate-ID selection step when non-LLM mode is enabled.

In product terms, full-paper mode should follow the same backend-selection policy as the rest of the plugin: no API key means non-LLM by default, an available API key allows the LLM path, and any LLM runtime failure should transparently fall back to the non-LLM ranking path.

## Suggested Pipeline in This Codebase

### `src/reading-highlights.ts`

This is the best place for Phase 1 ranking logic.

Suggested additions:

- candidate tokenization / normalization helpers
- explicit feature extraction per candidate
- heuristic scoring table and weight constants
- lexical ranking helpers for BM25 or TF-IDF
- score blending, thresholding, and shortlist construction
- debug-friendly score breakdowns for future tuning

Likely API direction:

- keep `prepareGlobalHighlightSelection(...)` as the main entry point
- add a non-LLM preparation path that returns ranked candidates directly
- optionally add `scoreSelectionCandidates(...)` and `rankPaperCandidates(...)`
- keep the ranking interface shared enough that LLM and non-LLM backend selection can plug into the same downstream validation and annotation flow

### `src/bootstrap.ts`

This should keep orchestration responsibility.

- implement a clean backend-selection gate: missing API key -> `non-llm`, API key present -> `llm` allowed, LLM runtime error -> automatic `non-llm` fallback
- keep selection capture, page text extraction, and annotation rendering unchanged where possible
- route full-paper mode to either `selectGlobalHighlightCandidateIds` or local ranking helpers
- route selection mode to either `extractSelectionHighlights` or local span scoring helpers
- keep logging and user-visible behavior consistent when fallback happens, so the annotation result still feels like one coherent feature rather than two separate modes

### `src/preferences.ts`

Add future preferences only if needed after the first implementation slice.

Likely candidates:

- ranking backend: `llm`, `non-llm`, `auto`
- non-LLM lexical method: `bm25`, `tfidf`
- minimum score threshold
- optional feature toggles for experimentation

## Ranking Strategy Options

### BM25 / TF-IDF Pseudo-Query

This should be the default lexical component.

- `BM25` is a strong default when sentence candidates are treated as small documents.
- `TF-IDF + cosine similarity` is simpler to implement and may be enough for Phase 1.
- Both are much cheaper and easier to ship than a local neural reranker.

Recommendation:

1. start with TF-IDF if implementation speed matters most
2. move to BM25 if ranking quality clearly benefits
3. keep the scoring interface generic so both can share the same candidate features

### Optional TextRank / LexRank Feature Blending

TextRank or LexRank can be useful as extra features, especially for identifying central sentences in a section or document.

However:

- they should not be the sole ranking method
- they can over-favor generic central sentences
- they work best as a small bonus signal blended with heuristics and lexical overlap

Recommended use in this repo: optional secondary feature for full-paper mode only.

## Phase 2 / Phase 3 Upgrades

### Phase 2

- add better sentence segmentation and local clause splitting for cleaner highlight spans
- add author-keyword extraction and stronger title/abstract/query construction
- add optional LexRank/TextRank bonus features
- add score breakdown logging and manual tuning fixtures
- add backend preference wiring in the settings UI, while preserving the default no-key non-LLM path and automatic LLM failure fallback

### Phase 3

- add a small local encoder reranker as an optional enhancement, such as MiniLM or a compact SBERT-style encoder
- evaluate a SciBERT-style encoder only if local footprint and startup cost stay acceptable
- keep SPECTER2 as a paper-level representation reference, not the first choice for sentence reranking in this product

Full argument mining and heavy discourse parsing are not recommended at the current product stage.

## Evaluation / Verification Plan

Phase 1 should be verified with lightweight, repo-appropriate checks.

### Functional Checks

- selection mode returns only spans inside the selection
- full-paper mode stays sparse and does not paint whole pages yellow
- results / claim / caveat coverage is better than naive first-sentence or position-based baselines
- references, citation-heavy text, and boilerplate are mostly suppressed

### Manual Paper Set

Use a small fixed set of papers with different structures:

- empirical ML paper
- methods-heavy systems paper
- biomedical abstract with structured sections
- paper with citation-dense related work

For each paper, inspect:

- top 10 to 20 ranked candidates
- section distribution
- precision of highlighted spans when read in isolation
- obvious misses in abstract, results, and limitations

### Engineering Verification

- keep build verification with `npm run build`
- use `npx tsc --noEmit` if needed during implementation
- add deterministic scoring fixtures later if the repo gains a lightweight test surface

## Risks and Tradeoffs

- Non-LLM ranking will miss deeper semantic matches and paraphrases.
- Cue phrases can overfit to common academic writing patterns.
- BM25 / TF-IDF can overvalue repeated terminology from methods sections.
- Section inference from raw PDF text is imperfect, especially on messy layouts.
- Reference filtering may accidentally suppress useful comparison sentences.
- A purely local model can be fast and cheap but will not match a strong LLM on nuanced judgment.

These tradeoffs are acceptable for this branch because the target is a practical fast path, not perfect scholarly understanding.

## Recommended Next Implementation Slice

Build the smallest useful full-paper non-LLM path first.

1. add a clean backend-selection gate so the product behavior is unambiguous: no API key defaults to non-LLM, API key allows LLM, and LLM errors trigger automatic fallback
2. extend `src/reading-highlights.ts` with explicit feature extraction and weighted heuristic scoring
3. add a simple TF-IDF pseudo-query ranker using `title + abstract + headings + keywords`
4. blend heuristic and lexical scores inside `prepareGlobalHighlightSelection(...)` behind a shared interface that both LLM and non-LLM selection paths can use
5. keep fallback logging and user-visible behavior consistent, and keep selection mode heuristic-only at first unless shared lexical code comes almost for free

This slice is small enough to ship incrementally and large enough to prove the architecture.

## References

- TextRank - Mihalcea and Tarau, 2004: [TextRank: Bringing Order into Text](https://aclanthology.org/W04-3252/)
- LexRank - Erkan and Radev, 2004: [LexRank: Graph-based Lexical Centrality as Salience in Text Summarization](https://aclanthology.org/J04-3002/)
- SciBERT - Beltagy, Lo, and Cohan, 2019: [SciBERT: A Pretrained Language Model for Scientific Text](https://aclanthology.org/D19-1371/)
- SPECTER2 - Cohan et al., 2024: [SPECTER2: Document-level Representation Learning using Citation-informed Transformers](https://allenai.org/blog/specter2-adapting-scientific-document-embeddings-to-multiple-fields-and-task-formats) - useful background, but not the first choice for Phase 1 local sentence ranking
- Sentence Transformers / SBERT efficiency docs: [Sentence Transformers - Speeding up Inference](https://www.sbert.net/docs/sentence_transformer/usage/efficiency.html)
- PubMed 200k RCT sentence classification: [PubMed 200k RCT: a Dataset for Sequential Sentence Classification in Medical Abstracts](https://aclanthology.org/I17-2052/)
