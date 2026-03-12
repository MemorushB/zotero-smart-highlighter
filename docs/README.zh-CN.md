<div align="center">
  <img src="./logo.png" alt="Zotero Smart Highlighter logo" width="112" />

  # 🖍️ Zotero Smart Highlighter

  面向 Zotero 8 的智能 PDF 高亮插件，帮助你在阅读时快速标出最值得回看的观点、结果、方法与局限。

  [Read in English](../README.md)
</div>

## 插件能做什么

Zotero Smart Highlighter 用来帮你在读论文时更快标出值得回看的内容，而不是手动一段段涂高亮。当前 `v0.2.3` 提供三条排序路径：内置的本地非 LLM 排序、在受支持 Apple 芯片 Mac 上可选启用的本地神经网络重排序，以及在你配置外部接口后可选使用的 LLM 高亮。

它支持两种主要阅读流程：

- 选区模式：对当前选中的文本做重点筛选，只保留更值得高亮的短片段。
- 全文模式：面向整篇 PDF 生成适合快速浏览的高亮结果。

## 主要特性

- 本地优先：不配置 API Key 也能直接使用内置的非 LLM 排序流程。
- 可选神经网络重排序：在受支持的 Apple 芯片 Mac 上，可进一步启用本地神经模型增强排序质量。
- 可选 LLM 高亮：配置 `API Key`、`Base URL` 和 `Model` 后，可使用外部模型进行高亮。
- 自动回退：`Auto` 模式下，未配置 API Key 时会保持本地工作流；若 LLM 请求失败，也会自动回退到非 LLM 流程。
- 多语言本地排序：非 LLM 流程支持英文，以及中文、日文、韩文这类无空格文本。
- 阅读器内集成：可直接从 Zotero 8 阅读器的选区弹出菜单和工具栏触发。

## 排序流程

当前插件提供三条排序路径，可根据设置和设备能力选择：

1. 本地非 LLM 排序
   - 始终可用。
   - 使用 `BM25` 或 `TF-IDF` 做词法排序。
   - 适合希望完全本地运行、不依赖外部 API 的场景。
2. 可选的本地神经网络重排序
   - 仅在受支持的 Apple 芯片 Mac 上可用。
   - 会先生成本地候选结果，再用端侧神经模型进一步重排。
   - 可在设置中通过 `Download`、`Compile`、`Recompile`、`Delete` 管理模型。
3. 可选的 LLM 高亮
   - 需要配置 `API Key`、`Base URL` 和 `Model`。
   - 适合希望优先使用大模型判断高亮内容的场景。

`Highlight Backend` 用来控制这些路径的使用方式：

- `Auto`：推荐默认值；未配置 API Key 时优先走本地流程，LLM 失败时也会安全回退。
- `LLM Preferred`：优先使用已配置的 LLM 路径。
- `Non-LLM Only`：仅使用本地排序流程。

## 📦 安装

1. 从仓库的 [Releases 页面](https://github.com/MemorushB/zotero-smart-highlighter/releases) 下载最新的 `.xpi` 安装包。
2. 在 Zotero 中打开 `Tools` -> `Plugins`。
3. 点击右上角齿轮，选择 `Install Add-on From File...`，然后选中下载好的 `.xpi`。
4. 如果 Zotero 提示重启，按提示完成即可。

## 🚀 快速开始

1. 在 Zotero 阅读器中打开 PDF。
2. 选中文本后，通过阅读器弹出的菜单运行选区模式高亮。
3. 通过阅读器工具栏按钮运行全文高亮。
4. 打开插件设置，选择合适的后端、排序方法和高亮策略。
5. 如果你使用的是受支持的 Apple 芯片 Mac，还可以额外下载并编译本地神经网络重排序模型。

## ⚙️ 设置说明

- `Highlight Backend`：可选 `Auto`、`LLM Preferred`、`Non-LLM Only`。
- `API Key`、`Base URL`、`Model`：仅在使用 LLM 高亮时需要配置。
- `Non-LLM Ranking`：可在 `BM25` 与 `TF-IDF` 之间切换本地词法排序方法。
- `Prompt Overrides`：高级选项，可分别覆盖选区模式和全文模式的提示词。
- `Min Confidence`：控制保留高亮时的严格程度。
- `Highlight Density`：控制高亮数量。
- `Reading Focus`：可在 balanced、results-first、methods-first、caveats-first 之间调整优先关注的内容。
- `Neural Reranker`：包含启用开关、运行状态，以及 `Download`、`Compile`、`Recompile`、`Delete` 等模型管理操作。

## 隐私与平台说明

- 内置的非 LLM 排序完全本地运行，不需要 API Key。
- 神经网络重排序同样在本地运行，但目前仅支持受支持的 Apple 芯片 Mac。
- 神经模型通过设置页在设备本地下载和编译，完成后可在插件升级后继续复用。
- LLM 高亮是可选能力，只有在你配置外部接口后才会启用。
- 本插件面向 Zotero 8。

## 开发环境与常用命令

本地开发步骤如下：

1. 运行 `npm install`。
2. 通过 `cp .env.example .env` 创建本地配置。
3. 在 `.env` 中设置必需环境变量 `ZOTERO_PLUGIN_ZOTERO_BIN_PATH`。
4. 使用 `npm start` 启动开发工作流。

仓库根目录常用命令：

- `npm start`：启动 scaffold 开发服务。
- `npm run build`：构建插件并执行类型检查。
- `npx tsc --noEmit`：仅执行 TypeScript 类型检查。

## 模型来源与许可

可选的神经网络重排序模型来自 Hugging Face 上的开源模型再打包。

- 原始模型：`cross-encoder/ms-marco-MiniLM-L6-v2`
- 原始地址：[https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2)
- 上游组织：SentenceTransformers / `cross-encoder`
- 本地打包用途：用于端侧推理，以及供插件管理可选神经网络重排序模型的下载流程

项目没有修改原始模型权重。相关模型文件继续遵循上游 **Apache License 2.0** 许可；如需再分发或复用，也请同时查看本仓库自身的许可证。


## 🛠️ 项目状态

当前版本：`v0.2.3`。

项目仍在持续迭代中。当前产品重点是为 Zotero 8 提供实用、可配置的 PDF 智能高亮能力，覆盖本地非 LLM 排序、可选端侧神经网络重排序，以及可选 LLM 高亮三条路径。
