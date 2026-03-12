import { defineConfig } from "zotero-plugin-scaffold";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: "Zotero Smart Highlighter",
  xpiName: "zotero-smart-highlighter",
  id: "zotero-pdf-highlighter@memorushb.com",
  namespace: "zotero-pdf-highlighter",
  updateURL:
    "https://raw.githubusercontent.com/MemorushB/zotero-smart-highlighter/master/update.json",
  build: {
    assets: ["addon/**/*.*", "addon/bin/**/*"],
    fluent: {
      prefixLocaleFiles: false,
      prefixFluentMessages: false,
      ignore: [],
      dts: false,
    },
    prefs: {
      prefixPrefKeys: false,
      prefix: "extensions.zotero-pdf-highlighter",
      dts: false,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        bundle: true,
        target: "firefox115",
        format: "iife",
        globalName: "ZoteroPlugin",
        footer: {
          js: "var startup = ZoteroPlugin.startup; var shutdown = ZoteroPlugin.shutdown; var install = ZoteroPlugin.install; var uninstall = ZoteroPlugin.uninstall;",
        },
        outfile:
          ".scaffold/build/addon/content/scripts/zotero-pdf-highlighter.js",
      },
    ],
  },
});
