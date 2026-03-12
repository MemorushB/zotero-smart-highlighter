<div align="center">
  <img src="./docs/logo.png" alt="Zotero Smart Highlighter logo" width="112" />

  # 🖍️ Zotero Smart Highlighter

  [![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

  Smart PDF highlighting for Zotero 8, designed to surface the most useful claims, results, methods, and caveats while you read.

  [Read in Chinese](docs/README.zh-CN.md)
</div>

## What it does

Zotero Smart Highlighter helps you mark the most useful parts of a paper without manually painting every sentence yourself. In v0.2.3, it supports three ranking paths: a built-in local non-LLM ranker, an optional on-device neural reranker for supported Apple Silicon Macs, and an optional LLM-backed mode for users who want model-based highlighting from a configured API endpoint.

You can use it in two reading flows:

- Selection mode: highlight the highest-value spans inside the text you currently select.
- Full-paper mode: generate skim-friendly highlights across the whole PDF for rapid review.

## Key features

- Local-first workflow: works without an API key through the built-in non-LLM ranking pipeline.
- Optional neural reranking: adds a stronger on-device reranker on supported Apple Silicon Macs.
- Optional LLM highlighting: uses your configured API endpoint when you want model-backed highlighting.
- Safe fallback behavior: `Auto` stays local when no API key is configured and falls back to non-LLM ranking if an LLM request fails.
- Multilingual local ranking: the non-LLM pipeline supports English and no-space scripts such as Chinese, Japanese, and Korean.
- Reader-integrated UX: available from the text selection popup and the reader toolbar inside Zotero 8.

## Ranking pipeline

The plugin currently offers three ranking paths, depending on your settings and machine:

1. Local non-LLM ranking
   - Always available.
   - Uses lexical ranking with `BM25` or `TF-IDF`.
   - Best when you want a fully local workflow with no external API dependency.
2. Optional local neural reranking
   - Available only on supported Apple Silicon Macs.
   - Reranks local candidates with an on-device neural model after the initial non-LLM shortlist.
   - Managed entirely in Settings with `Download`, `Compile`, `Recompile`, and `Delete` actions.
3. Optional LLM-backed highlighting
   - Available when you configure `API Key`, `Base URL`, and `Model`.
   - Used when you prefer generative model judgment over local-only ranking.

`Highlight Backend` controls how these paths are used:

- `Auto`: recommended default; prefers local behavior when no API key is configured and falls back safely if LLM requests fail.
- `LLM Preferred`: uses the configured LLM path first.
- `Non-LLM Only`: keeps highlighting on the local ranking pipeline only.

## 📦 Install

1. Download the latest `.xpi` package from the repository's [Releases page](https://github.com/MemorushB/zotero-smart-highlighter/releases).
2. In Zotero, open `Tools` -> `Plugins`.
3. Click the gear icon, choose `Install Add-on From File...`, and select the downloaded `.xpi`.
4. Restart Zotero if prompted.

## 🚀 Quick start

1. Open a PDF in Zotero's reader.
2. Select text to run selection-mode highlighting from the reader popup.
3. Use the reader toolbar action to run full-paper highlighting.
4. Open the plugin settings and choose your preferred backend, ranking method, and highlight behavior.
5. If you use a supported Apple Silicon Mac, optionally download and compile the local neural reranker.

## ⚙️ Settings overview

- `Highlight Backend`: choose `Auto`, `LLM Preferred`, or `Non-LLM Only`.
- `API Key`, `Base URL`, and `Model`: only needed for LLM-backed highlighting.
- `Non-LLM Ranking`: choose `BM25` or `TF-IDF` for the local lexical ranking stage.
- `Prompt Overrides`: optional advanced overrides for selection mode and full-paper prompts.
- `Min Confidence`: controls how strict the plugin is before keeping a highlight.
- `Highlight Density`: controls how many highlights are kept.
- `Reading Focus`: shifts prioritization between balanced reading, results-first, methods-first, and caveats-first behavior.
- `Neural Reranker`: includes an enable toggle, runtime status, and model management actions for `Download`, `Compile`, `Recompile`, and `Delete`.

## Privacy and platform notes

- The built-in non-LLM ranking path runs locally and does not require an API key.
- The neural reranker is also local, but available only on supported Apple Silicon Macs.
- Neural model management happens on-device through Settings; after download and compilation, the model stays reusable across plugin upgrades.
- LLM-backed highlighting is optional and only used when you configure an external endpoint.
- This plugin targets Zotero 8.

## Development setup and commands

For local development:

1. Run `npm install`.
2. Create local config with `cp .env.example .env`.
3. Set the required environment variable `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` in `.env`.
4. Start the development workflow with `npm start`.

Useful root commands:

- `npm start`: start the scaffold development server.
- `npm run build`: build the plugin and run the project type-check.
- `npx tsc --noEmit`: run the TypeScript type-check only.

## Model attribution and license

The optional neural reranker model is repackaged from an open-source model hosted on Hugging Face.

- Original model: `cross-encoder/ms-marco-MiniLM-L6-v2`
- Original model URL: [https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2)
- Upstream organization: SentenceTransformers / `cross-encoder`
- Local packaging purpose: on-device inference and plugin-managed download for the optional neural reranker workflow

The original model weights are not modified. Model files remain subject to the upstream **Apache License 2.0** terms. Please also review this repository's own license before redistribution or reuse.

## 🛠️ Project status

Current release: `v0.2.3`.

The plugin is under active iteration. The current product state focuses on practical PDF highlighting for Zotero 8 with three configurable ranking paths: local non-LLM ranking, optional on-device neural reranking, and optional LLM-backed highlighting.
