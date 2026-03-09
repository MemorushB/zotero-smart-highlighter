# Phase 3 测试计划：Neural Reranker

## 1. 测试目标与范围

### 1.1 测试目标

- 验证 Phase 3 的 sidecar 生命周期、设置界面、非 LLM 排序管道集成与回退行为符合预期。
- 验证在 Apple Silicon macOS 上可以安全启用 Neural Reranker，并在异常情况下静默回退到既有排序逻辑。
- 验证设置界面、状态徽章、下载按钮与深色模式样式在 Zotero 8 中可正常工作。

### 1.2 覆盖范围

- Phase 3a：Swift sidecar 项目、loopback HTTP 服务、端口绑定、健康检查、鉴权令牌、空闲关闭。
- Phase 3b：插件侧 `neural-reranker.ts` 生命周期管理、sidecar 启停、健康检查、重启与回退。
- Phase 3c：偏好设置中的神经网络重排序区块、复选框、状态徽章、下载按钮、深色模式样式。
- Phase 3d：选区模式与全局模式中的 neural rerank 分数接入、权重融合与 fallback 权重验证。

### 1.3 不在本轮范围内

- 模型下载按钮的真实下载链路与进度展示。
- 非 macOS 平台的 sidecar 运行能力。
- 英文之外语种的模型效果评估。

## 2. 环境准备

### 2.1 设备与系统要求

- 设备：macOS Apple Silicon（M1 / M2 / M3 / M4）。
- 建议系统：近期稳定版 macOS，并已允许本地开发签名或未签名二进制运行。
- 建议准备一台非 Apple Silicon Mac 或通过日志模拟非支持环境，用于验证“不支持”分支。

### 2.2 Zotero 8 安装

1. 安装 Zotero 8。
2. 首次启动后确认 Zotero 可正常打开 PDF 阅读器。
3. 打开 `Help -> Debug Output Logging -> View Output`，确认可以查看 debug 日志。

### 2.3 插件 XPI 安装

1. 打开 Zotero。
2. 进入 `Tools -> Plugins`。
3. 通过齿轮菜单选择 `Install Plugin From File...`。
4. 安装当前构建出的 XPI。
5. 安装完成后重启 Zotero。

### 2.4 sidecar 二进制确认

1. 在仓库中确认存在文件：`addon/bin/darwin-arm64/zph-reranker`。
2. 确认该文件具备可执行权限。
3. 如仓库内仅有 `sidecar/` 源码而无最终二进制，先完成单独编译与拷贝，再继续执行本计划。

建议使用以下命令做静态检查：

```bash
ls -l addon/bin/darwin-arm64/zph-reranker
file addon/bin/darwin-arm64/zph-reranker
```

### 2.5 测试样本准备

- 准备 1 篇中小型英文 PDF（10-30 页），用于快速验证选区模式与全局模式。
- 准备 1 篇大型英文 PDF（大于 100 页），用于性能观察。
- 准备 1 篇结构清晰、带 `Abstract`、`Methods`、`Results`、`Discussion` 的论文，便于观察 reason 与 section 行为。

## 3. 设置界面测试（Phase 3c）

### 3.1 打开高级设置

1. 打开 Zotero。
2. 进入插件偏好设置页面。
3. 点击“高级设置”展开区块。
4. 确认展开后可以看到“神经网络重排序（Apple Silicon）”区块。

预期结果：

- 高级设置可以正常展开与收起。
- 神经网络重排序区块在高级设置中可见。
- 区块内至少包含启用复选框、状态徽章、下载按钮区域。

### 3.2 状态徽章与复选框

#### 3.2.1 Apple Silicon 设备

步骤：

1. 在 Apple Silicon 设备上打开偏好设置。
2. 观察状态徽章文字。
3. 勾选与取消勾选“启用神经网络重排序”。
4. 关闭并重新打开偏好设置，验证状态是否持久化。

预期结果：

- 复选框可点击。
- 初始状态徽章应显示“模型未下载”或“就绪”。
- 用户禁用后，状态徽章显示“已禁用”。
- 重新打开偏好设置后，复选框状态与上次操作一致。

#### 3.2.2 非 Apple Silicon 设备

步骤：

1. 在非 Apple Silicon Mac 上打开偏好设置。
2. 观察状态徽章与复选框。

预期结果：

- 状态徽章显示“不支持”。
- 复选框为禁用状态，不可点击。
- 下载按钮区域不应误导性显示为可用功能。

### 3.3 下载按钮

#### 3.3.1 模型未下载

步骤：

1. 确保本地模型文件不存在。
2. 打开偏好设置并展开高级设置。
3. 观察下载按钮是否可见。

预期结果：

- 当模型未下载时，下载按钮可见。
- 状态徽章显示“模型未下载”。

#### 3.3.2 模型已下载

步骤：

1. 将模型文件放置到插件运行时使用的位置。
2. 重新打开偏好设置。
3. 观察下载按钮区域。

预期结果：

- 当模型已下载时，下载按钮隐藏。
- 状态徽章显示“就绪”。

#### 3.3.3 点击下载按钮

步骤：

1. 在“模型未下载”状态下点击下载按钮。
2. 观察按钮与状态徽章变化。
3. 打开 Zotero debug 日志。

预期结果：

- 按钮点击后立即切换为“正在下载…”。
- 状态徽章切换为“正在下载模型…”。
- 当前实现为占位逻辑，不会真正下载模型。
- 日志中应出现占位实现相关记录。
- 操作结束后按钮恢复为“下载模型”。

### 3.4 深色模式样式验证

步骤：

1. 将 macOS 切换到深色模式。
2. 重启 Zotero 或重新打开偏好设置页面。
3. 检查神经网络重排序区块。

预期结果：

- 区块标题、提示文字、按钮、状态徽章在深色背景上可读。
- `ready`、`not-supported`、`downloading` 状态颜色与浅色模式一致表达语义。
- 无文字过暗、边框不可见、按钮 hover 不明显等问题。

## 4. Sidecar 生命周期测试（Phase 3a / 3b）

### 4.1 启动前检查

1. 在 Apple Silicon 设备上，确保复选框已启用。
2. 确保模型文件已放置到运行时读取位置。
3. 清理旧的 sidecar 进程与旧的 `sidecar.json`。

建议命令：

```bash
ps aux | grep zph-reranker
```

### 4.2 启用后触发高亮并检查 sidecar 启动

步骤：

1. 打开一篇英文 PDF。
2. 选择一段正文文本，触发非 LLM 高亮。
3. 立即在终端检查进程、监听端口与 `sidecar.json`。

建议命令：

```bash
ps aux | grep zph-reranker
lsof -nP -iTCP:23516 -sTCP:LISTEN
curl -s http://127.0.0.1:23516/health
```

预期结果：

- 出现 `zph-reranker` 进程。
- sidecar 仅绑定 `127.0.0.1`，不应绑定 `0.0.0.0` 或外网地址。
- 生成 `sidecar.json`，且内容包含 `port` 与 `token`。
- 若 `23516` 被占用，应自动尝试 `23517-23520`。

建议同时检查运行时数据目录中的 `sidecar.json`。如主路径未找到，可额外检查模型目录下是否生成，以便识别路径相关问题。

### 4.3 健康检查端点

步骤：

1. 根据 `sidecar.json` 中记录的端口发起请求。
2. 调用 `GET /health`。

建议命令：

```bash
curl -i http://127.0.0.1:23516/health
```

预期结果：

- 返回 `HTTP 200`。
- 响应体包含 `status: ok`。
- 在模型已加载时，`model_loaded` 应为 `true`；模型未加载时也应保持服务可用。

### 4.4 空闲超时自动关闭

步骤：

1. 成功触发一次 neural rerank。
2. 不再触发任何高亮请求。
3. 等待空闲超时。
4. 再次检查 sidecar 进程。

预期结果：

- 超时后 sidecar 自动关闭。
- 日志中应出现空闲超时停止的记录。
- `sidecar.json` 应被清理或不再代表活跃服务。

### 4.5 插件关闭时进程清理

步骤：

1. 保持 Zotero 已打开且 sidecar 正在运行。
2. 退出 Zotero，或通过禁用/卸载插件触发插件关闭。
3. 检查 sidecar 进程是否残留。

预期结果：

- 插件关闭后调用 `destroySidecarManager`。
- sidecar 进程被清理，不残留僵尸进程。
- 下次启动 Zotero 后可重新正常拉起 sidecar。

### 4.6 端口冲突回退行为

步骤：

1. 预先占用 `23516`。
2. 触发一次 neural rerank。
3. 检查 sidecar 最终监听端口。
4. 继续占用 `23516-23519`，再次验证是否回退到 `23520`。

预期结果：

- sidecar 会在 `23516-23520` 范围内选择可用端口。
- `sidecar.json` 中记录的 `port` 与实际监听端口一致。
- 插件后续请求会使用实际端口，不会写死在 `23516`。

## 5. 神经重排序管道测试（Phase 3d）

### 5.1 选区模式测试

步骤：

1. 在 Apple Silicon 设备上启用 neural reranker。
2. 打开 PDF 并选择一段较长正文文本。
3. 触发非 LLM 高亮。
4. 查看 Zotero debug 日志。

预期日志：

- 应出现 ``[Smart Highlighter] Neural rerank complete: N scores``。
- 选区排序日志中应包含 `neural=yes`。
- 候选日志应包含 `n=X.XX`。

权重验证：

- 有 neural 分数时：`heuristic*0.40 + lexical*0.10 + neural*0.50`。
- 无 neural 分数时：`heuristic*0.72 + lexical*0.28`。

验证方法：

1. 从日志中记录单个候选的 `h`、`l`、`n`、`score`。
2. 手工代入公式计算。
3. 确认结果与日志中的 `score` 近似一致。

### 5.2 全局模式测试

步骤：

1. 打开 PDF。
2. 触发全局高亮。
3. 查看 Zotero debug 日志。

预期日志：

- 应出现 neural rerank 完成日志。
- 全局排序日志中应包含 `neural=yes`。
- 候选日志应包含 `n=X.XX`、`reason=...`、`section=...`。

权重验证：

- 有 neural 分数时：`heuristic*0.35 + lexical*0.15 + neural*0.50 + reasonBonus`。
- 无 neural 分数时：`heuristic*0.68 + lexical*0.32 + reasonBonus`。

验证方法：

1. 从日志中抽取至少 3 个候选。
2. 对照 `score`、`h`、`l`、`n` 与 `reasonBonus` 规则进行手算。
3. 确认最终排序与日志顺序一致。

### 5.3 回退安全性

#### 5.3.1 禁用 neural reranker

步骤：

1. 在偏好设置中取消勾选神经网络重排序。
2. 分别触发选区模式和全局模式高亮。

预期结果：

- 高亮仍正常生成。
- 日志应显示 neural reranker 未就绪或被跳过。
- 排序走旧权重，不因 neural 关闭而报错。

#### 5.3.2 sidecar 未运行

步骤：

1. 手动终止 sidecar 进程。
2. 重新触发高亮。

预期结果：

- 不应向用户暴露错误弹窗。
- 若可重启则自动重启；若无法恢复，则静默回退。
- 高亮流程继续完成。

#### 5.3.3 模型未下载

步骤：

1. 移除模型文件。
2. 保持神经网络重排序开关为启用状态。
3. 触发高亮。

预期结果：

- 不报错。
- 日志应说明状态为 `model-not-downloaded` 或 neural 被跳过。
- 高亮使用 fallback 权重继续执行。

## 6. 错误处理与边界情况

### 6.1 sidecar 崩溃后自动恢复

步骤：

1. 触发一次 neural rerank，确认 sidecar 已运行。
2. 手动杀掉 `zph-reranker`。
3. 再次触发高亮。

预期结果：

- sidecar 退出后，日志记录异常退出。
- 再次触发高亮时应自动重启 sidecar，或在失败后静默回退。
- 不应导致 Zotero 卡死。

### 6.2 网络或 IPC 超时

步骤：

1. 通过调试方式让 `/rerank` 响应变慢，或让 sidecar 不响应。
2. 在 Zotero 中触发高亮。

预期结果：

- 请求超时后日志中有失败记录。
- Zotero 端不会持续等待到无响应。
- 排序流程静默回退，不抛出未捕获异常。

### 6.3 非 Apple Silicon Mac 全流程

步骤：

1. 在非 Apple Silicon Mac 上安装插件。
2. 打开设置界面并触发选区模式、全局模式高亮。

预期结果：

- 设置界面显示“不支持”。
- neural 被跳过。
- 高亮功能整体正常。

### 6.4 大文档性能观察

步骤：

1. 打开大于 100 页的英文 PDF。
2. 记录从触发全局高亮到完成的时间。
3. 连续执行 3 次。

观察项：

- 首次启动 sidecar 的冷启动耗时。
- sidecar 已运行时的热启动耗时。
- UI 是否卡顿。
- debug 日志是否明显延迟或出现超时。

### 6.5 候选文本为空

步骤：

1. 选择非常短、只有空白、只有符号或无法形成候选句子的文本。
2. 触发选区模式高亮。

预期结果：

- 管道安全返回空结果或普通 fallback 结果。
- 不应发送非法请求给 sidecar。
- 不应出现未捕获异常。

## 7. 调试日志检查清单

### 7.1 Zotero 中查看 debug 日志的方法

1. 打开 Zotero。
2. 进入 `Help -> Debug Output Logging -> View Output`。
3. 保持日志窗口开启后复现操作。
4. 用关键字筛选 `Smart Highlighter`、`ZPH`、`neural`、`rerank`。

### 7.2 应重点关注的 `[Smart Highlighter]` 前缀日志

- ``[Smart Highlighter] Neural reranker not ready (status: ...)``
- ``[Smart Highlighter] Neural reranker returned null, skipping``
- ``[Smart Highlighter] Neural rerank complete: N scores``
- ``[Smart Highlighter] Neural rerank failed: ...``
- ``[Smart Highlighter selection] candidates=... threshold=0.22 neural=yes|no``
- ``[Smart Highlighter selection]   score=... h=... l=... n=...``
- ``[Smart Highlighter global] shortlist=... threshold=0.2 neural=yes|no``
- ``[Smart Highlighter global]   id=... score=... h=... l=... n=... reason=... section=...``
- ``[Smart Highlighter scoring] section=... score=... text="..."``

### 7.3 应重点关注的 `[Smart Highlighter neural]` 前缀日志

- ``[Smart Highlighter neural] Starting sidecar: ...``
- ``[Smart Highlighter neural] Model path: ...``
- ``[Smart Highlighter neural] Extracting sidecar binary from ...``
- ``[Smart Highlighter neural] Sidecar binary extracted and made executable``
- ``[Smart Highlighter neural] Sidecar ready``
- ``[Smart Highlighter neural] Reranked N candidates``
- ``[Smart Highlighter neural] Rerank request failed: HTTP ...``
- ``[Smart Highlighter neural] Invalid rerank response format``
- ``[Smart Highlighter neural] Rerank failed: ...``
- ``[Smart Highlighter neural] Idle timeout, stopping sidecar``
- ``[Smart Highlighter neural] Sidecar stopped``
- ``[Smart Highlighter neural] Sidecar process exited unexpectedly``
- ``[Smart Highlighter neural] Restarting sidecar (attempt X/Y)``
- ``[Smart Highlighter neural] Sidecar restart failed: ...``

### 7.4 应重点关注的 `[ZPH]` 前缀日志

- ``[ZPH] Neural reranker model download requested``
- ``[ZPH] Model download not yet implemented - placeholder``
- ``[ZPH] Model download failed: ...``

### 7.5 sidecar 标准错误输出应关注的文本

- `Model loaded from ...`
- `ZPH Reranker server listening on 127.0.0.1:PORT`
- `Sidecar info written to .../sidecar.json`
- `Server shut down`
- `Warning: Could not load model: ...`
- `Server will start but reranking will use fallback scoring`
- `Failed to start server: ...`

## 8. 已知限制

- 模型下载按钮当前为占位实现，点击后仅切换状态并输出日志，不会真正下载模型。
- sidecar 二进制需要单独编译并打包到 `addon/bin/darwin-arm64/zph-reranker`。
- 当前仅支持 Apple Silicon Mac。
- 当前模型为 `ms-marco-MiniLM-L6-v2`，主要针对英文优化。

## 9. 建议测试结论模板

每轮测试建议记录以下信息：

- 测试设备：芯片型号、macOS 版本、Zotero 版本。
- 插件构建版本或 commit hash。
- 模型是否存在。
- 设置界面结果：通过 / 失败。
- sidecar 生命周期结果：通过 / 失败。
- 选区模式结果：通过 / 失败。
- 全局模式结果：通过 / 失败。
- 回退与边界情况结果：通过 / 失败。
- 关键日志摘录。
- 已发现问题与复现步骤。
