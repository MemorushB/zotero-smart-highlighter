# 非 LLM 高亮排序方案

## 目标

为科学论文中的“值得读”的文本增加一条快速、本地运行、无需 LLM 的选取路径。当前目标不是追求完美的语义理解，而是先做出一条实用的排序流水线：运行成本低、在 Zotero 内响应快，并且足够可靠，能够在不调用远程模型的前提下，把有价值的论点、结果、方法和限制条件优先呈现出来。

本文档对应分支 `non-llm-highlight-ranking` 的后续工作规划。

## 为什么值得加入非 LLM 路线

- 它能提升选区交互时的响应速度，也让整篇论文的排序流程更轻量。
- 它去掉了核心阅读助手流程对 API 成本和网络连接的依赖。
- 它支持完全本地执行，适合隐私敏感论文以及离线使用场景。
- 当 LLM 输出过慢、不可用或结果不稳定时，它能提供一条稳健的兜底路径。
- 从工程角度看，这条路线更容易调试、可复现、可解释，也更便于通过阈值和特征权重持续调参。

## 推荐架构

推荐的高层设计是一个混合式流水线：

1. 将文本解析为候选片段，并保留 offset 与章节元数据
2. 使用带章节感知的启发式规则对候选片段打分
3. 使用轻量级词法相关性特征进行排序
4. 做过滤、去重，以及每页 / 每节的预算控制
5. 通过现有 annotation 流水线返回已经验证过的片段

这一方案应复用当前仓库中已有的职责拆分：

- `src/bootstrap.ts` 负责 reader 集成、选区捕获、页面文本提取和 annotation 渲染
- `src/reading-highlights.ts` 负责候选提取、span 校验、章节推断和最终选择规则
- `src/preferences.ts` 负责开关、阈值以及未来的模式选择

现有 LLM 路线应保持不变。非 LLM 路线应作为另一套排序后端接入，而不是重写 reader 集成层。

在产品层面，后端选择策略需要写清楚：

- 如果用户没有填写 API key，则默认走非 LLM 后端
- 如果存在 API key，则允许使用 LLM 后端
- 如果 LLM 后端在运行时抛错，则自动回退到非 LLM 后端

这意味着非 LLM 不只是一个“可选后端”，它同时也是无 key 场景下的默认路径，以及保障可用性的兜底路径。

## Phase 1 默认方案

Phase 1 建议采用 `章节感知启发式 + 词法排序` 的混合方案。

推荐默认公式：

`final_score = heuristic_score + lexical_score + small_optional_graph_bonus - penalties`

其中：

- `heuristic_score` 用来表达章节先验、提示短语、claim/result/method/caveat 标记，以及可读性检查
- `lexical_score` 来自基于伪查询的 BM25 或 TF-IDF
- `small_optional_graph_bonus` 预留给 TextRank / LexRank 这类显著性信号；如果后续证明有帮助，可以加进来，但不应成为唯一排序依据
- `penalties` 用来压低引用、参考文献、模板化文本和低可读性片段

这与产品约束是一致的：优先追求速度、实用性和本地优先。

## 评分特征

### 章节先验

先根据推断出的章节类型给一个基础先验分。

- 高先验：`abstract`、`results`、`discussion`、`conclusion`
- 中先验：`introduction`、`methods`
- 低先验：`related-work`、`other`
- 接近零分或直接过滤：`references`、类似 bibliography 的文本、类似 acknowledgments 的模板化内容

仓库里已经在 `src/reading-highlights.ts` 中实现了章节推断和章节权重逻辑，因此 Phase 1 应该扩展现有逻辑，而不是再引入一套单独的章节分类器。

### 提示短语信号

对包含学术写作中常见提示短语的片段给予加分，例如：

- contribution cues：`we propose`、`we present`、`our approach`、`this paper`
- result cues：`we find`、`results show`、`significantly`、`outperforms`
- method cues：`we use`、`trained on`、`dataset`、`architecture`、`ablation`
- caveat cues：`however`、`limitation`、`fails when`、`we caution`

实现上应采用透明、可解释的 regex 或 token 级特征分组，并为每组设置独立权重。

### Result / Method / Claim / Caveat 标记

保留现有的 reason taxonomy，并在非 LLM 打分中把它显式化。

- `claim`：贡献、创新点、核心 framing
- `result`：实验结果、对比结论、定量发现
- `method`：关键设计选择、数据设置、重要实现细节
- `caveat`：局限性、前提假设、失败案例、适用边界

Phase 1 不需要完整的话语结构解析。简单的标记词家族加章节先验，就已经足够支撑第一版。

### 与标题 / 摘要 / 标题层级的重叠度

如果片段与论文标题、摘要词项、章节标题词项以及作者关键词有重叠，应给予加分。

在整篇论文模式下，伪查询建议构造为：

`title + abstract + section headings + author keywords`

这将作为 BM25 或 TF-IDF 排序时的主查询表示。

### 引用 / 参考文献惩罚

对那些大概率不是高价值阅读目标的片段施加惩罚。

- 引用密度过高：相对于词数，方括号或括号引用过多
- 参考文献列表结构：作者-年份模式、DOI 密集行、会议 / 期刊串、页码范围
- 图表指代型叙述：`Figure 2`、`Table 1`、`Eq. (3)`，且整句基本只是指向说明
- 纯 related work 式比较句，几乎没有本文特有信息

插件目前已经在 `src/reading-highlights.ts` 中使用了 citation-style penalties；这里建议继续扩展，并拆成更清晰的特征名称。

### 可读性 / Boilerplate 过滤

拒绝或降权那些不适合作为独立高亮的片段。

- 太短、太长，或词数过多
- 代词过多，脱离上下文后难以理解
- 章节标题、过渡句、模板化 boilerplate
- 以符号、公式或参考文献为主的片段
- 信息量很低的学术套话，例如 `the rest of the paper is organized as follows`

这与当前阅读高亮已有的校验思路是一致的。

## 两种产品模式下如何工作

### 选区模式

选区模式应继续保持本地、快速。

1. 将用户选中的文本拆成近似句子或分句级候选片段
2. 如果能从当前页周边文本中拿到上下文，则推断局部章节标题
3. 使用纯启发式特征打分，或者使用 `selection heading + nearby context` 作为轻量本地 TF-IDF 查询
4. 经过现有校验与去重后，只返回选区内部的 span
5. 如果没有片段达到阈值，允许返回“不高亮”结果

默认建议：对于很小的选区，不要专门引入完整 BM25 基础设施，除非相关代码本来就能复用。这个模式大多数情况下靠启发式规则就够了。

### 整篇论文模式

整篇论文模式应启用完整的混合栈。

1. 提取整篇论文的页面文本与候选片段
2. 为每个候选片段推断章节类型和章节标题
3. 用标题、摘要、标题层级和作者关键词构建伪查询
4. 使用 BM25 或 TF-IDF 计算词法排序分数
5. 将词法分数与启发式特征融合
6. 应用惩罚项、去重、每页上限和每节上限
7. 将排名靠前的候选片段送入现有 annotation 流水线

当启用非 LLM 模式时，这一模式应替代当前由 LLM 负责的 candidate-ID 选择步骤。

从产品行为上看，整篇论文模式也应遵循同一套后端选择策略：没有 API key 时默认走非 LLM；有 API key 时可以走 LLM；一旦 LLM 在运行时失败，则无感回退到非 LLM 排序路径。

## 在当前代码库中的落点

### `src/reading-highlights.ts`

Phase 1 的排序逻辑最适合落在这里。

建议新增：

- 候选片段分词 / 归一化辅助函数
- 面向单个候选片段的显式特征提取
- 启发式打分表和权重常量
- BM25 或 TF-IDF 的词法排序辅助函数
- 分数融合、阈值过滤和 shortlist 构建
- 方便后续调参的 score breakdown 调试输出

API 方向上大致可以这样推进：

- 保持 `prepareGlobalHighlightSelection(...)` 作为主入口
- 增加一条直接返回排序后候选片段的非 LLM 准备路径
- 可选新增 `scoreSelectionCandidates(...)` 和 `rankPaperCandidates(...)`
- 让排序接口尽量共享，使 LLM 与非 LLM 后端都能接到同一条下游校验与 annotation 流程上

### `src/bootstrap.ts`

这里应继续承担编排职责。

- 实现一层清晰的后端选择闸门：缺少 API key -> `non-llm`，存在 API key -> 允许 `llm`，LLM 运行时失败 -> 自动回退 `non-llm`
- 尽量保持选区捕获、页面文本提取和 annotation 渲染逻辑不变
- 在整篇论文模式下，将流程路由到 `selectGlobalHighlightCandidateIds` 或本地排序辅助函数
- 在选区模式下，将流程路由到 `extractSelectionHighlights` 或本地 span 打分辅助函数
- 回退发生时保持日志清晰，同时保证用户可见行为一致，让整个高亮能力仍然表现为同一个功能而不是两套割裂模式

### `src/preferences.ts`

只有在第一版实现切片之后确实需要时，再补充偏好设置。

比较可能的选项包括：

- 排序后端：`llm`、`non-llm`、`auto`
- 非 LLM 词法方法：`bm25`、`tfidf`
- 最低分阈值
- 用于实验的可选特征开关

## 排序策略选项

### BM25 / TF-IDF 伪查询

这应作为默认的词法组件。

- 当把句子候选视作小文档时，`BM25` 是很强的默认方案。
- `TF-IDF + cosine similarity` 更容易实现，Phase 1 很可能已经够用。
- 与本地神经 reranker 相比，这两者都更便宜，也更容易落地发布。

建议顺序：

1. 如果实现速度最重要，先上 TF-IDF
2. 如果排序质量有明显收益，再切到 BM25
3. 打分接口保持通用，让两者共享同一套候选特征

### 可选的 TextRank / LexRank 特征融合

TextRank 或 LexRank 适合作为额外特征，尤其是在识别某个章节或整篇文档中的中心句时。

但需要注意：

- 它们不应成为唯一排序方法
- 它们容易过度偏向“通用但居中”的句子
- 最适合的用法，是作为一个较小的 bonus 信号，与启发式和词法重叠度一起融合

在本仓库中的推荐方式：只作为整篇论文模式下的可选次级特征。

## Phase 2 / Phase 3 升级

### Phase 2

- 增强句子切分和局部分句能力，得到更干净的高亮 span
- 增加作者关键词提取，并强化标题 / 摘要 / 查询构建
- 增加可选的 LexRank / TextRank bonus 特征
- 增加 score breakdown 日志和手动调参用 fixtures
- 在设置 UI 中接入后端选择偏好，同时保留“无 key 默认非 LLM”和“LLM 失败自动回退”的产品规则

### Phase 3

- 增加一个小型本地 encoder reranker 作为可选增强，例如 MiniLM 或紧凑型 SBERT 风格编码器
- 只有在本地体积和启动成本可接受的前提下，才评估 SciBERT 风格编码器
- 将 SPECTER2 作为论文级表示的参考背景，而不是本产品里句子级 reranking 的首选

在当前产品阶段，不建议投入完整的 argument mining 或重量级 discourse parsing。

## 评估 / 验证方案

Phase 1 应采用轻量、贴合当前仓库实际情况的验证方式。

### 功能检查

- 选区模式只返回选区内部的 span
- 整篇论文模式保持稀疏，不会把整页都刷成黄色
- 对 results / claim / caveat 的覆盖优于“取首句”或“按位置排序”这类朴素基线
- 参考文献、引用密集文本和 boilerplate 大多能够被压下去

### 手动论文集合

使用一组结构各异、规模较小但固定的论文集合：

- 实证型机器学习论文
- 方法描述较重的 systems 论文
- 带结构化分节的 biomedical abstract
- related work 引用特别密集的论文

对每篇论文检查：

- 排名前 10 到 20 的候选片段
- 章节分布
- 高亮片段在脱离上下文单独阅读时的精度
- 在摘要、结果和局限性部分是否存在明显漏检

### 工程验证

- 按现有流程使用 `npm run build` 做构建验证
- 实现过程中如有需要，可用 `npx tsc --noEmit`
- 如果仓库后续具备轻量测试面，再补充确定性的 scoring fixtures

## 风险与权衡

- 非 LLM 排序会错过更深层的语义匹配和改写表达。
- 提示短语可能会对常见学术写作套路产生过拟合。
- BM25 / TF-IDF 可能会高估 methods 章节中反复出现的术语。
- 基于原始 PDF 文本的章节推断并不完美，版式复杂时尤其如此。
- 参考文献过滤可能误伤一些其实有价值的比较句。
- 纯本地模型在速度和成本上有优势，但在细腻判断上无法与强 LLM 对齐。

对于这个分支来说，这些权衡是可以接受的，因为目标是做出一条实用的快速路径，而不是完美理解学术内容。

## 推荐的下一步实现切片

先实现一个“最小但有用”的整篇论文非 LLM 路径。

1. 先加一层清晰的后端选择闸门，明确产品行为：无 API key 默认非 LLM，有 API key 才允许 LLM，LLM 报错则自动回退
2. 在 `src/reading-highlights.ts` 中补充显式特征提取和加权启发式打分
3. 基于 `title + abstract + headings + keywords` 增加一个简单的 TF-IDF 伪查询排序器
4. 在 `prepareGlobalHighlightSelection(...)` 内通过共享接口融合启发式分数与词法分数，让 LLM 与非 LLM 选择路径都能复用
5. 优先做好回退日志与用户可见行为一致性；选区模式第一版先保持“纯启发式”，除非共享词法代码几乎零成本

这个切片足够小，可以增量交付；同时也足够完整，能够验证整体架构方向。

## 参考资料

- TextRank - Mihalcea and Tarau, 2004: [TextRank: Bringing Order into Text](https://aclanthology.org/W04-3252/)
- LexRank - Erkan and Radev, 2004: [LexRank: Graph-based Lexical Centrality as Salience in Text Summarization](https://aclanthology.org/J04-3002/)
- SciBERT - Beltagy, Lo, and Cohan, 2019: [SciBERT: A Pretrained Language Model for Scientific Text](https://aclanthology.org/D19-1371/)
- SPECTER2 - Cohan et al., 2024: [SPECTER2: Document-level Representation Learning using Citation-informed Transformers](https://allenai.org/blog/specter2-adapting-scientific-document-embeddings-to-multiple-fields-and-task-formats) - 适合作为背景材料参考，但不是 Phase 1 本地句子排序的首选
- Sentence Transformers / SBERT efficiency docs: [Sentence Transformers - Speeding up Inference](https://www.sbert.net/docs/sentence_transformer/usage/efficiency.html)
- PubMed 200k RCT sentence classification: [PubMed 200k RCT: a Dataset for Sequential Sentence Classification in Medical Abstracts](https://aclanthology.org/I17-2052/)
