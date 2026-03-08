# Preference Prefix Migration 手动测试说明

## 这份文档是干什么的

这份文档用来手动验证当前的 preference prefix migration 是否按现在的实现正常工作。

你会在开发用的 Zotero profile 里直接改 `.scaffold/profile/prefs.js`，然后启动 Zotero，确认这几件事：

- 旧前缀 `extensions.zotero.extensions.zotero-pdf-highlighter.` 下的值会不会迁移到新前缀。
- canonical 和 legacy 同时存在时，冲突处理是不是符合当前规则。
- prompt override 的“默认等价”语义是不是正确。
- migration marker 写入后，迁移是不是不会重复跑。

## 先记住这几个关键点

- 改 `.scaffold/profile/prefs.js` 之前，一定先完全退出 Zotero。
- 每轮开始前，先备份 `.scaffold/profile/prefs.js`。
- 只用 `.scaffold/profile` 这个开发 profile，不要拿你日常使用的 Zotero profile 做测试。
- 除了专门测试 marker 的场景 F，其他场景开始前都要先删掉 migration marker。
- 真正的非默认值冲突里，`legacy` 胜出，这是当前实现的预期行为。
- 对 prompt 来说，空字符串、纯空白、以及“和内置默认 prompt 完全一致的文本”都算默认等价，不应作为有效 override 保留下来。

## 关键信息速查

| 项目 | 值 | 说明 |
| --- | --- | --- |
| 开发 profile 路径 | `.scaffold/profile` | 只在这里做测试 |
| 要编辑的文件 | `.scaffold/profile/prefs.js` | 所有场景都只改这个文件 |
| canonical 前缀 | `extensions.zotero-pdf-highlighter.` | 当前正式前缀 |
| legacy duplicated 前缀 | `extensions.zotero.extensions.zotero-pdf-highlighter.` | 旧的重复前缀 |
| migration marker key / version | `extensions.zotero-pdf-highlighter.prefPrefixMigrationVersion` / `1` | marker 存在且值为 `1` 时，不再重复迁移 |

## 每轮测试的通用步骤

- [ ] 完全退出 Zotero。
- [ ] 备份 `.scaffold/profile/prefs.js`。
- [ ] 确认你改的是 `.scaffold/profile/prefs.js`，不是别的 profile。
- [ ] 清掉上一个场景留下的相关 `user_pref(...)` 行。
- [ ] 如果这轮不是场景 F，删除这行 marker：

```js
user_pref("extensions.zotero-pdf-highlighter.prefPrefixMigrationVersion", "1");
```

- [ ] 按当前场景要求，把指定的 `user_pref(...)` 行加进 `.scaffold/profile/prefs.js`。
- [ ] 启动开发环境，让 Zotero 正常启动并完成插件初始化。
- [ ] 打开插件的 Preferences 面板，看 UI 显示的值。
- [ ] 再回到 `.scaffold/profile/prefs.js`，确认迁移后的实际落盘结果。

## 场景 A：只有 canonical key

这项测试要确认：如果配置本来就在 canonical 前缀下，启动后它应该保持不变，只额外写入 migration marker。

### 准备：添加这些行

```js
user_pref("extensions.zotero-pdf-highlighter.model", "openai/gpt-4.1");
user_pref("extensions.zotero-pdf-highlighter.focusMode", "methods-first");
```

### 准备：删除这些行

```js
user_pref("extensions.zotero-pdf-highlighter.prefPrefixMigrationVersion", "1");
user_pref("extensions.zotero.extensions.zotero-pdf-highlighter.model", "anthropic/claude-3.7-sonnet");
user_pref("extensions.zotero.extensions.zotero-pdf-highlighter.focusMode", "results-first");
```

### 操作步骤

1. 完全退出 Zotero。
2. 编辑 `.scaffold/profile/prefs.js`，按上面要求增删对应行。
3. 启动开发环境并打开 Zotero。
4. 打开插件 Preferences。
5. 关闭 Zotero 或保持打开状态都可以，但要重新检查 `.scaffold/profile/prefs.js`。

### 预期结果

UI 里要看到：

- `model` 仍然是 `openai/gpt-4.1`。
- `focusMode` 仍然是 `methods-first`。

`.scaffold/profile/prefs.js` 里要看到：

- 仍然存在：

```js
user_pref("extensions.zotero-pdf-highlighter.model", "openai/gpt-4.1");
user_pref("extensions.zotero-pdf-highlighter.focusMode", "methods-first");
```

- 新增了 marker：

```js
user_pref("extensions.zotero-pdf-highlighter.prefPrefixMigrationVersion", "1");
```

- 不应新增对应的 legacy duplicated key。

## 场景 B：只有 legacy key

这项测试要确认：如果旧值只存在于 legacy 前缀下，启动后会迁移到 canonical 前缀。

### 准备：添加这些行

```js
user_pref("extensions.zotero.extensions.zotero-pdf-highlighter.baseURL", "https://llm-gateway.example/v1");
user_pref("extensions.zotero.extensions.zotero-pdf-highlighter.model", "anthropic/claude-3.7-sonnet");
user_pref("extensions.zotero.extensions.zotero-pdf-highlighter.focusMode", "results-first");
```

### 准备：删除这些行

```js
user_pref("extensions.zotero-pdf-highlighter.baseURL", "https://openrouter.ai/api/v1");
user_pref("extensions.zotero-pdf-highlighter.model", "z-ai/glm-4.5-air:free");
user_pref("extensions.zotero-pdf-highlighter.focusMode", "balanced");
user_pref("extensions.zotero-pdf-highlighter.prefPrefixMigrationVersion", "1");
```

### 操作步骤

1. 完全退出 Zotero。
2. 编辑 `.scaffold/profile/prefs.js`，确保只保留上面的 legacy 设置，不保留对应 canonical 设置。
3. 启动开发环境并打开 Zotero。
4. 打开插件 Preferences。
5. 回到 `.scaffold/profile/prefs.js` 检查落盘结果。

### 预期结果

UI 里要看到：

- `baseURL` 显示为 `https://llm-gateway.example/v1`。
- `model` 显示为 `anthropic/claude-3.7-sonnet`。
- `focusMode` 显示为 `results-first`。

`.scaffold/profile/prefs.js` 里要看到：

- canonical 分支已经有这些值：

```js
user_pref("extensions.zotero-pdf-highlighter.baseURL", "https://llm-gateway.example/v1");
user_pref("extensions.zotero-pdf-highlighter.model", "anthropic/claude-3.7-sonnet");
user_pref("extensions.zotero-pdf-highlighter.focusMode", "results-first");
```

- 已写入 marker：

```js
user_pref("extensions.zotero-pdf-highlighter.prefPrefixMigrationVersion", "1");
```

- legacy duplicated key 不应再以“非默认 override”的形式残留；它们要么被清掉，要么只剩默认等价值，两种都算正确。

## 场景 C：canonical 与 legacy 冲突，legacy 胜出

这项测试要确认：当 canonical 和 legacy 都是非默认值且彼此冲突时，当前实现会让 legacy 胜出。

### 准备：添加这些行

```js
user_pref("extensions.zotero-pdf-highlighter.model", "openai/gpt-4.1");
user_pref("extensions.zotero-pdf-highlighter.focusMode", "methods-first");
user_pref("extensions.zotero.extensions.zotero-pdf-highlighter.model", "anthropic/claude-3.7-sonnet");
user_pref("extensions.zotero.extensions.zotero-pdf-highlighter.focusMode", "results-first");
```

### 准备：删除这些行

```js
user_pref("extensions.zotero-pdf-highlighter.prefPrefixMigrationVersion", "1");
```

### 操作步骤

1. 完全退出 Zotero。
2. 把 canonical 和 legacy 两组冲突值都写进 `.scaffold/profile/prefs.js`。
3. 启动开发环境并打开 Zotero。
4. 打开插件 Preferences。
5. 回到 `.scaffold/profile/prefs.js` 检查最终保留下来的值。

### 预期结果

UI 里要看到：

- `model` 最终显示为 `anthropic/claude-3.7-sonnet`。
- `focusMode` 最终显示为 `results-first`。

`.scaffold/profile/prefs.js` 里要看到：

- canonical 值已经被 legacy 覆盖为：

```js
user_pref("extensions.zotero-pdf-highlighter.model", "anthropic/claude-3.7-sonnet");
user_pref("extensions.zotero-pdf-highlighter.focusMode", "results-first");
```

- 原先的 canonical 冲突值不应继续保留为有效结果。
- legacy duplicated key 不应继续以非默认 override 的形式残留。
- marker 应该被写入为 `1`。

## 场景 D：prompt override 语义（空白 / 默认 prompt / 自定义 prompt）

这项测试要确认：prompt override 不是“有字符串就算 override”，而是要按默认等价语义处理。

### D1：legacy prompt 是空字符串或纯空白

这项子测试要确认：空字符串和纯空白都应被当成默认等价，不应迁移成有效 override。

#### 准备：添加这些行

```js
user_pref("extensions.zotero.extensions.zotero-pdf-highlighter.systemPrompt", "   ");
user_pref("extensions.zotero.extensions.zotero-pdf-highlighter.globalSystemPrompt", "");
```

#### 准备：删除这些行

```js
user_pref("extensions.zotero-pdf-highlighter.systemPrompt", "Return only claim-worthy spans.");
user_pref("extensions.zotero-pdf-highlighter.globalSystemPrompt", "Select at most two highlights per paper.");
user_pref("extensions.zotero-pdf-highlighter.prefPrefixMigrationVersion", "1");
```

#### 操作步骤

1. 完全退出 Zotero。
2. 在 `.scaffold/profile/prefs.js` 中加入上面的 legacy prompt 行。
3. 确保没有对应的 canonical prompt override，也没有 marker。
4. 启动开发环境并打开 Zotero。
5. 打开插件 Preferences 里的 prompt 覆盖区域。
6. 回到 `.scaffold/profile/prefs.js` 检查结果。

#### 预期结果

UI 里要看到：

- 两个 prompt 都表现为“使用内置默认行为”，而不是显示成有意义的自定义 override。

`.scaffold/profile/prefs.js` 里要看到：

- canonical 的 `systemPrompt` 和 `globalSystemPrompt` 不应保留为有效非默认 override。
- legacy prompt 不应继续以有效 override 的形式残留。
- marker 已写入。

### D2：legacy prompt 恰好等于默认 prompt 文本

这项子测试要确认：如果保存的文本和内置默认 prompt 完全一致，也要视为默认等价，而不是视为自定义 override。

#### 准备：添加这些行

把 `src/preferences.ts` 中的 `DEFAULT_SYSTEM_PROMPT` 和 `DEFAULT_GLOBAL_SYSTEM_PROMPT` 原文完整复制出来，写成下面两行：

```js
user_pref("extensions.zotero.extensions.zotero-pdf-highlighter.systemPrompt", "<把 src/preferences.ts 里的 DEFAULT_SYSTEM_PROMPT 原文完整粘贴到这里>");
user_pref("extensions.zotero.extensions.zotero-pdf-highlighter.globalSystemPrompt", "<把 src/preferences.ts 里的 DEFAULT_GLOBAL_SYSTEM_PROMPT 原文完整粘贴到这里>");
```

#### 准备：删除这些行

```js
user_pref("extensions.zotero-pdf-highlighter.systemPrompt", "Return only claim-worthy spans.");
user_pref("extensions.zotero-pdf-highlighter.globalSystemPrompt", "Select at most two highlights per paper.");
user_pref("extensions.zotero-pdf-highlighter.prefPrefixMigrationVersion", "1");
```

#### 操作步骤

1. 完全退出 Zotero。
2. 从 `src/preferences.ts` 复制当前实现里的默认 prompt 原文。
3. 写入 `.scaffold/profile/prefs.js` 的 legacy key。
4. 启动开发环境并打开 Zotero。
5. 打开插件 Preferences 里的 prompt 覆盖区域。
6. 回到 `.scaffold/profile/prefs.js` 检查结果。

#### 预期结果

UI 里要看到：

- 两个 prompt 都仍然表现为“使用默认 prompt”，不是“用户自定义 prompt”。

`.scaffold/profile/prefs.js` 里要看到：

- canonical 分支不应把这两个值保留成有效非默认 override。
- legacy 分支也不应继续保留成有效非默认 override。
- marker 已写入。

### D3：legacy prompt 是真正的自定义文本

这项子测试要确认：只有真正的自定义 prompt 文本，才会作为有效 override 迁移到 canonical。

#### 准备：添加这些行

```js
user_pref("extensions.zotero.extensions.zotero-pdf-highlighter.systemPrompt", "Return only claim-worthy spans.");
user_pref("extensions.zotero.extensions.zotero-pdf-highlighter.globalSystemPrompt", "Select at most two highlights per paper.");
```

#### 准备：删除这些行

```js
user_pref("extensions.zotero-pdf-highlighter.systemPrompt", "");
user_pref("extensions.zotero-pdf-highlighter.globalSystemPrompt", "");
user_pref("extensions.zotero-pdf-highlighter.prefPrefixMigrationVersion", "1");
```

#### 操作步骤

1. 完全退出 Zotero。
2. 在 `.scaffold/profile/prefs.js` 中加入上面的两行 legacy 自定义 prompt。
3. 确保对应 canonical prompt 没有残留旧值，marker 也已删除。
4. 启动开发环境并打开 Zotero。
5. 打开插件 Preferences 里的 prompt 覆盖区域。
6. 回到 `.scaffold/profile/prefs.js` 检查结果。

#### 预期结果

UI 里要看到：

- `Selection Highlight Prompt Override` 对应位置显示 `Return only claim-worthy spans.`。
- `Full-Paper Highlight Prompt Override` 对应位置显示 `Select at most two highlights per paper.`。

`.scaffold/profile/prefs.js` 里要看到：

- canonical 分支已写入：

```js
user_pref("extensions.zotero-pdf-highlighter.systemPrompt", "Return only claim-worthy spans.");
user_pref("extensions.zotero-pdf-highlighter.globalSystemPrompt", "Select at most two highlights per paper.");
```

- legacy prompt key 不应继续以有效 override 的形式残留。
- marker 已写入。

## 场景 E：legacy 中只有默认值，不应被当成有效 override

这项测试要确认：legacy 里如果存的是默认等价值，迁移后不应制造出“看起来像用户手动设置过”的 canonical override。

当前实现中的默认值包括：

- `density = balanced`
- `focusMode = balanced`
- `minConfidence = 0.5`
- prompt 为空白或等于默认 prompt 文本

### 准备：添加这些行

```js
user_pref("extensions.zotero.extensions.zotero-pdf-highlighter.density", "balanced");
user_pref("extensions.zotero.extensions.zotero-pdf-highlighter.focusMode", "balanced");
user_pref("extensions.zotero.extensions.zotero-pdf-highlighter.minConfidence", "0.5");
user_pref("extensions.zotero.extensions.zotero-pdf-highlighter.systemPrompt", "   ");
```

### 准备：删除这些行

```js
user_pref("extensions.zotero-pdf-highlighter.density", "dense");
user_pref("extensions.zotero-pdf-highlighter.focusMode", "results-first");
user_pref("extensions.zotero-pdf-highlighter.minConfidence", "0.7");
user_pref("extensions.zotero-pdf-highlighter.systemPrompt", "Return only claim-worthy spans.");
user_pref("extensions.zotero-pdf-highlighter.prefPrefixMigrationVersion", "1");
```

### 操作步骤

1. 完全退出 Zotero。
2. 把上面的 legacy 默认等价值写进 `.scaffold/profile/prefs.js`。
3. 确保没有对应的 canonical 非默认值，也没有 marker。
4. 启动开发环境并打开 Zotero。
5. 打开插件 Preferences。
6. 回到 `.scaffold/profile/prefs.js` 检查结果。

### 预期结果

UI 里要看到：

- `density` 显示默认值 `balanced`。
- `focusMode` 显示默认值 `balanced`。
- `minConfidence` 显示默认值 `0.5`。
- `systemPrompt` 表现为内置默认行为。

`.scaffold/profile/prefs.js` 里要看到：

- 这些值不应以“有效 canonical 非默认 override”的形式保留下来。
- legacy 分支也不应继续保留这些值作为有效 override。
- marker 已写入。

## 场景 F：migration marker 防止重复迁移

这项测试要确认：只要 marker 已经是版本 `1`，启动时就不会再次运行迁移。

### 准备：添加这些行

```js
user_pref("extensions.zotero-pdf-highlighter.model", "openai/gpt-4.1");
user_pref("extensions.zotero-pdf-highlighter.prefPrefixMigrationVersion", "1");
user_pref("extensions.zotero.extensions.zotero-pdf-highlighter.model", "anthropic/claude-3.7-sonnet");
```

### 准备：删除这些行

```js
user_pref("extensions.zotero-pdf-highlighter.model", "anthropic/claude-3.7-sonnet");
```

### 操作步骤

1. 完全退出 Zotero。
2. 在 `.scaffold/profile/prefs.js` 中同时写入 canonical 值、legacy 冲突值，以及 marker=`1`。
3. 注意：这个场景不要删除 marker。
4. 启动开发环境并打开 Zotero。
5. 打开插件 Preferences。
6. 回到 `.scaffold/profile/prefs.js` 检查结果。

### 预期结果

UI 里要看到：

- `model` 仍然是 `openai/gpt-4.1`，不会被 legacy 的 `anthropic/claude-3.7-sonnet` 覆盖。

`.scaffold/profile/prefs.js` 里要看到：

- 仍然存在：

```js
user_pref("extensions.zotero-pdf-highlighter.model", "openai/gpt-4.1");
user_pref("extensions.zotero-pdf-highlighter.prefPrefixMigrationVersion", "1");
```

- 不会因为这次启动再次执行迁移。
- 如果 legacy 行还在，这是符合预期的，因为 marker 已阻止迁移重新运行。

## 建议的执行顺序

建议按下面顺序跑，最省事，也最容易定位问题：

1. 场景 A：先确认 canonical-only 基线没问题。
2. 场景 B：确认 legacy-only 能正常迁移。
3. 场景 C：确认真正冲突时 legacy 胜出。
4. 场景 D：连续验证 prompt override 的三种关键语义。
5. 场景 E：确认默认等价值不会被误当成有效 override。
6. 场景 F：最后确认 marker 会阻止重复迁移。

## 测完怎么收尾

- 完全退出 Zotero。
- 用备份恢复 `.scaffold/profile/prefs.js`，或者手动删掉本轮测试加进去的 `user_pref(...)` 行。
- 只保留你自己真正想在开发 profile 里继续使用的配置。
- 如果你之后还想重跑迁移测试，记得先删掉：

```js
user_pref("extensions.zotero-pdf-highlighter.prefPrefixMigrationVersion", "1");
```

- 不要把这些测试数据留在你平时要长期使用的 profile 里。
