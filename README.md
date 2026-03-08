# Zotero Smart Highlighter

Smart PDF highlighting for Zotero 8, designed to surface the most useful claims, results, methods, and caveats while you read.

Chinese README: [`docs/README.zh-CN.md`](docs/README.zh-CN.md)

## Feature overview

- Selection mode: highlight the most valuable spans inside the text you currently select.
- Full-paper mode: generate skim-friendly highlights across the whole PDF for fast review.
- Dual backend: use an LLM backend when an API key is configured, or switch to the built-in non-LLM ranking backend.
- Safe fallback: in `Auto` mode, the plugin stays local when no API key is set and falls back to non-LLM ranking if an LLM request fails.
- Multilingual support: the non-LLM pipeline includes tokenization and ranking heuristics for English and no-space scripts such as Chinese, Japanese, and Korean.

## Install

1. Download the latest `.xpi` package from the repository's [Releases page](https://github.com/MemorushB/zotero-pdf-highlighter/releases).
2. In Zotero, open `Tools` -> `Plugins`.
3. Click the gear icon, choose `Install Add-on From File...`, and select the downloaded `.xpi`.
4. Restart Zotero if prompted.

## Quick start

1. Open a PDF in Zotero's reader.
2. Select text to run selection-mode highlighting from the reader popup.
3. Use the reader toolbar action to run full-paper highlighting.
4. Adjust density and reading focus in the plugin preferences to match your workflow.

## Settings overview

- `Highlight Backend`: `Auto` is the recommended default. It uses the non-LLM backend when no API key is configured and falls back locally if the LLM request fails.
- `API Key`, `Base URL`, and `Model`: only needed when you want LLM-backed highlighting.
- `Non-LLM Ranking`: choose between `BM25` and `TF-IDF` for the local ranking pipeline.
- `Prompt Overrides`: optional advanced settings for custom selection-mode and full-paper prompts.
- `Min Confidence`, `Highlight Density`, and `Reading Focus`: control how aggressive the highlighting should be and which parts of a paper are prioritized.

## Development

```bash
npm install
cp .env.example .env
npm start
```

Set `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` in `.env` before starting the dev server. `npm start` watches `src/` and `addon/`, rebuilds automatically, and reloads the plugin during development.

Build the plugin and run the root type check with:

```bash
npm run build
```

## Project status

This repository is under active iteration. The highlighting workflow and preference surface may continue to evolve as the plugin's reading assistant features improve.
