# Reading Assistant Highlighting Plan

## Objective

Shift the plugin from named-entity highlighting toward a paper reading assistant that highlights text worth reading. The goal is not to mark every potentially relevant phrase, but to spend the reader's limited attention budget on a small number of high-value spans.

Core product principle:

- limited attention budget
- short, self-contained spans
- high precision over recall

In practice, this means the default system should prefer missing some good highlights over flooding the page with low-value ones.

## Product Direction

The plugin should evolve from an extraction-style NER tool into a reading-support tool with two distinct operating modes:

1. a fast, selection-scoped mode for immediate interaction
2. a slower, background mode for paper-wide reading guidance

Both modes should use the same core highlighting philosophy, but they should not share the same prompt shape or pipeline complexity.

## Agreed Product Modes

### Mode 1 - Selection-Only Quick Highlight

This mode runs when the user selects text and asks for reading assistance on that selection.

Requirements:

- Highlight strictly inside the selected text only.
- The model may use the paper title, section title, and nearby local context to understand the selection.
- Returned spans must remain inside the selection even if the surrounding context influences interpretation.
- The pipeline should favor low latency, compact prompting, and minimal orchestration.
- The model must be allowed to return no highlight when the selected text does not contain a strong standalone span.

This mode should feel like a precision tool, not a fallback highlighter.

### Mode 2 - Global / Background Paper Highlighting

This mode runs across the whole paper and can take longer.

Requirements:

- Run in the background with a slower, more deliberate pipeline.
- Highlight worth-reading sentences or short spans across the whole paper.
- Use a more sophisticated multi-stage process than Mode 1.
- Produce a balanced set of highlights rather than a dense salience map.

This mode should help a reader skim a paper intelligently, not simply mark locally important phrases without global coordination.

## Non-Goals and Guardrails

- No paragraph-sized highlights.
- Avoid over-highlighting.
- Avoid fragments that depend heavily on surrounding text and become unclear when highlighted alone.
- Do not keep the old NER fallback behavior of highlighting the whole selection on failure.
- Do not optimize for recall at the cost of readability.
- Do not treat every statistically salient sentence as worth a highlight.

These guardrails matter because highlight overload makes the reading experience worse even when individual selections are technically relevant.

## Research-Informed Rubric for Worth-Reading Highlights

The highlighting rubric should be optimized for what helps a human decide whether a paper, section, or result deserves attention.

### Positive Signals

#### 1. Core Contribution or Claim

Prioritize spans that express the main contribution, central claim, or takeaway of the paper or section.

#### 2. Key Results or Evidence

Prioritize strong findings, quantitative results, qualitative evidence, or comparisons that materially support a claim.

#### 3. Decision-Critical Method Details

Prioritize method details when they matter for judging validity, applicability, novelty, or reproducibility.

#### 4. Caveats, Limitations, or Boundaries

Prioritize statements about failure modes, assumptions, scope limits, data constraints, or conditions under which results should not be overgeneralized.

#### 5. Problem Framing or Research Gap

Prioritize concise spans that explain why the paper exists, what gap it addresses, or what tension in prior work it resolves.

### Penalties

Penalize candidates that are:

- redundant with already selected highlights
- boilerplate or generic academic framing
- mostly citations without substantive claim content
- dependent on a figure, table, or equation to make sense
- pronoun-heavy or built on unresolved references
- too long, too diffuse, or composed of multiple loosely related ideas

### Section-Aware Priorities

The rubric should be section-aware rather than uniform across the document.

- Abstract / Introduction: contribution, problem framing, high-level findings
- Related Work: only highlight comparison or positioning statements that matter for the paper's novelty or decision-making
- Methods: focus on design decisions, unusual setup details, or validity-critical assumptions
- Results / Evaluation: prioritize outcome statements, comparisons, and evidence-bearing claims
- Discussion / Conclusion: prioritize interpretation, limitations, and implications

## Proposed Architecture Direction for This Repo

The current repository already has two important building blocks that should be reused:

- `src/llm.ts` for model transport, request handling, and structured-response cleanup
- `src/bootstrap.ts` for the offset-to-annotation and Reader integration pipeline

The main architectural change is to replace NER extraction with two reading-highlight flows.

Likely module directions:

- sentence segmentation and text normalization helpers
- candidate extraction with stable text offsets
- local heuristic scoring and filtering
- reading-highlight orchestration for Mode 1 and Mode 2
- ranking / selection output validation

Likely settings and UI touchpoints:

- `src/preferences.ts`
- `addon/content/preferences.xhtml`

The implementation should preserve the existing Zotero integration surface where possible and swap the selection logic behind it.

## Detailed Plan by Mode

### Mode 1 Pipeline

1. Capture the selection text plus stable selection offsets.
2. Gather lightweight context such as paper title, section title, and small nearby context windows.
3. Send a compact prompt that asks for short worth-reading spans within the selection only.
4. Require structured JSON output with explicit character offsets or exact matched substrings inside the selection.
5. Validate that every returned span is strictly in-selection.
6. Enforce short-span constraints before highlight rendering.
7. Allow a no-highlight result when no high-value span passes validation.

Design notes:

- Keep the prompt compact to preserve responsiveness.
- Prefer direct selection over chain-heavy reasoning.
- Treat validation failure as no highlight, not whole-selection fallback.

### Mode 2 Pipeline

1. Parse the document into sections, paragraphs, and sentence-like units with offsets.
2. Generate sentence or short-span candidates with section metadata.
3. Apply local heuristic prescoring and filtering before the LLM stage.
4. Ask the LLM to rank or select candidates by candidate IDs rather than free-form spans.
5. Apply a global budget, deduplication, and section balancing pass.
6. Convert the final selected candidates into highlight annotations.
7. Render highlights through the existing annotation pipeline.

Design notes:

- Candidate-ID selection is safer than unconstrained text generation for paper-wide highlighting.
- Local heuristics should reduce cost and improve precision before model ranking.
- A global budget is necessary to prevent whole-page yellowing.

## Implementation Phases

### Phase 1 - Mode 1 MVP

Scope:

- Replace selection-time NER extraction with a compact worth-reading selection flow.
- Support structured output, strict in-selection validation, short-span enforcement, and no-highlight return.

Main code areas likely to change:

- `src/bootstrap.ts`
- `src/llm.ts`
- likely new reading-highlight selection helper modules under `src/`

Verification ideas:

- Manual checks on selections from abstract, methods, and results sections
- Confirm all returned highlights stay inside the selection
- Confirm low-value or noisy selections can return no highlight
- Confirm failure paths do not highlight the entire selection

### Phase 2 - Mode 2 MVP

Scope:

- Add paper-wide candidate generation, ranking, and budgeted highlight selection.
- Support section-aware balancing and final annotation rendering across the document.

Main code areas likely to change:

- `src/bootstrap.ts`
- `src/llm.ts`
- new modules for sentence segmentation, candidate generation, ranking orchestration, and deduplication

Verification ideas:

- Manual runs on several papers with different structures
- Compare selected highlights across abstract, methods, results, and discussion sections
- Check that the final set remains sparse and readable
- Check that duplicate or near-duplicate claims are not highlighted repeatedly

### Phase 3 - Settings, UI Polish, and Tuning

Scope:

- Expose mode-specific settings and user-facing controls.
- Tune prompts, budgets, thresholds, and section balancing behavior.
- Improve wording and expectations in the preferences UI.

Main code areas likely to change:

- `src/preferences.ts`
- `addon/content/preferences.xhtml`
- any preference-loading logic connected to reading-highlight mode selection

Verification ideas:

- Manual settings regression checks
- Confirm defaults feel useful without configuration
- Confirm Mode 1 remains fast after added settings
- Confirm Mode 2 remains understandable and controllable from the UI

## Suggested Settings and Model Knobs

- focus mode: `balanced`, `results-first`, `methods-first`, `caveats-first`
- density or max highlight budget
- separate prompts for selection mode and global mode if useful
- optional section-priority weighting for global mode
- optional minimum confidence or minimum score threshold

Mode 1 should keep its prompt compact even if Mode 2 grows into a richer orchestration pipeline.

## Success Criteria

- Highlights are short, useful, and not overwhelming.
- Default behavior does not paint whole pages yellow.
- Mode 1 reliably stays within the selected text and can return no highlight.
- Mode 2 covers claim, result, and caveat better than random or purely local salience.
- Highlighted spans are readable on their own and rarely depend on unresolved surrounding context.

Manual validation ideas:

- test several papers from different fields and writing styles
- compare abstract, methods, results, and discussion behavior separately
- inspect whether highlighted text still makes sense when read in isolation
- inspect whether the total highlight density remains acceptable for skim reading

## References

These references inform the product principles and rubric, especially around reading support, discourse-aware salience, decontextualization, and constrained selection.

- Semantic Reader: AI-assisted scholarly reading patterns and interaction model. Allen Institute for AI. <https://www.semanticscholar.org/product/semantic-reader>
- SCIM: an intelligent interface for machine-assisted scientific literature review. Ma et al., UIST 2024. <https://doi.org/10.1145/3654777.3676410>
- Argumentative zoning for scientific discourse classification. Teufel, Carletta, and Moens, 1999. <https://aclanthology.org/J99-4003/>
- Sentence decontextualization for standalone readability. Choi et al., TACL 2021. <https://aclanthology.org/2021.tacl-1.27/>
- Language models for extractive summarization and constrained content selection. Zhang et al., 2023. <https://aclanthology.org/2023.findings-emnlp.214/>
- Human highlighting as a learning / supervision signal for salience selection in documents. e.g. Miller et al., 2024 survey on highlight-based supervision and rationale extraction. <https://arxiv.org/abs/2406.10275>
