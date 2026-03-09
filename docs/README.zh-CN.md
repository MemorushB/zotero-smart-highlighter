<div align="center">
  <img src="./logo.png" alt="Zotero Smart Highlighter logo" width="112" />

  # 🖍️ Zotero Smart Highlighter

  面向 Zotero 8 的智能 PDF 高亮插件，帮助你在阅读时快速标出最值得回看的观点、结果、方法与局限。

  [Read in English](../README.md)
</div>

## ✨ 功能概览

- 选区模式：对当前选中的文本做重点筛选，只保留更值得高亮的短片段。
- 全文模式：面向整篇 PDF 生成适合快速浏览的高亮结果。
- 双后端：配置 API Key 后可使用 LLM 后端，也可以直接使用内置的非 LLM 排序后端。
- 自动回退：`Auto` 模式下，如果没有配置 API Key，插件会直接使用本地非 LLM 后端；如果 LLM 请求失败，也会自动回退到本地方案。
- 多语言兜底：非 LLM 流程对英文以及中文、日文、韩文这类无空格文本都提供分词和排序支持。

## 📦 安装

1. 从仓库的 [Releases 页面](https://github.com/MemorushB/zotero-smart-highlighter/releases) 下载最新的 `.xpi` 安装包。
2. 在 Zotero 中打开 `Tools` -> `Plugins`。
3. 点击右上角齿轮，选择 `Install Add-on From File...`，然后选中下载好的 `.xpi`。
4. 如果 Zotero 提示重启，按提示完成即可。

## 🚀 快速开始

1. 在 Zotero 阅读器中打开 PDF。
2. 选中文本后，通过阅读器弹出的菜单运行选区模式高亮。
3. 通过阅读器工具栏按钮运行全文高亮。
4. 在插件设置里调整高亮密度和阅读重点，使输出更符合你的阅读习惯。

## ⚙️ 设置说明

- `Highlight Backend`：推荐使用 `Auto`。未配置 API Key 时会走非 LLM 本地后端；LLM 请求失败时也会自动回退。
- `API Key`、`Base URL`、`Model`：只有在你希望使用 LLM 高亮时才需要配置。
- `Non-LLM Ranking`：可在 `BM25` 与 `TF-IDF` 之间切换本地排序方法。
- `Prompt Overrides`：高级选项，可分别覆盖选区模式和全文模式使用的提示词。
- `Min Confidence`、`Highlight Density`、`Reading Focus`：分别控制筛选阈值、高亮数量和优先关注的论文内容。


## 🛠️ 项目状态

项目仍在持续迭代中，阅读辅助与高亮相关的交互和配置项后续还可能继续调整。
