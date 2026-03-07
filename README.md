# Zotero PDF Highlighter

A Zotero 8 plugin for VS Code-like semantic PDF highlighting.

## Development (Template-style)

This project is wired to `zotero-plugin-scaffold` for template-style development.

1. Install dependencies:
```bash
npm install
```
2. Create local env config:
```bash
cp .env.example .env
```
3. Fill `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` in `.env` (and optionally profile/data paths).
4. Start hot reload dev server:
```bash
npm start
```

`npm start` will watch `src/**` and `addon/**`, rebuild, and reload the plugin automatically.

## Build

- Template/scaffold build:
```bash
npm run build
```
- Legacy build script (kept for compatibility):
```bash
npm run build:legacy
```
