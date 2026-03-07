# Zotero 插件开发：PDF 精确字符高亮指南

> **调研日期**：2026-03-06  
> **适用版本**：Zotero 8.x（基于本地 gitlink 引用仓库与上游源码分析）  
> **源码参考**：
> - [zotero/zotero `chrome/content/zotero/xpcom/reader.js`](https://github.com/zotero/zotero/blob/ce11d5295c461ed7e5ef4dacb00d06c4c2bc107f/chrome/content/zotero/xpcom/reader.js)
> - [zotero/reader `src/pdf/selection.js`](https://github.com/zotero/reader/blob/87e5c7f5972da43b35939d3585f9585bfe7e132d/src/pdf/selection.js)
> - [zotero/reader `src/pdf/lib/utilities.js`](https://github.com/zotero/reader/blob/87e5c7f5972da43b35939d3585f9585bfe7e132d/src/pdf/lib/utilities.js)
> - 本地 gitlink 引用仓库 `zotero/reader` commit `fae5ba4`（reader 内部实现校验）
>
> **注意**：本文档已基于 Zotero 8 reader 源码（`zotero/reader` commit `fae5ba4`）校验更新

---

## 目录

1. [背景与问题](#1-背景与问题)
2. [Zotero 高亮注释的数据格式](#2-zotero-高亮注释的数据格式)
3. [Zotero 内置高亮的工作原理](#3-zotero-内置高亮的工作原理)
4. [chars 对象详解](#4-chars-对象详解)
5. [核心算法：从 chars 到 rects](#5-核心算法从-chars-到-rects)
6. [在插件中访问这些数据](#6-在插件中访问这些数据)
7. [完整实现代码](#7-完整实现代码)
8. [推荐实现策略（三层降级）](#8-推荐实现策略三层降级)
9. [注意事项与风险](#9-注意事项与风险)
10. [常见问题](#10-常见问题)

---

## 1. 背景与问题

### Zotero 主仓库没有字符级坐标 API

`zotero/zotero` 主仓库的 `Zotero.PDFWorker` 只提供以下接口，均不含字符级坐标：

| 方法 | 功能 |
|------|------|
| `getFullText(itemID, maxPages)` | 提取纯文本，无位置信息 |
| `getRecognizerData(itemID)` | 页面级文字块，用于文档识别 |
| `import/export` | 注释导入/导出 |

### 真正的字符坐标在 `zotero/reader`

Zotero 的 PDF 阅读器是独立子项目 [`zotero/reader`](https://github.com/zotero/reader)，基于 PDF.js 构建。它在内部维护了一个**逐字符**的 `chars` 数组，每个字符都有精确的 PDF 坐标。内置的划选高亮功能正是基于此实现的。

---

## 2. Zotero 高亮注释的数据格式

高亮注释存储在 `Zotero.Item`（`annotationType = 'highlight'`）中，其核心位置字段为：

```json
{
  "type": "highlight",
  "color": "#ffd400",
  "pageLabel": "15",
  "sortIndex": "00014|003210|00283",
  "position": {
    "pageIndex": 1,
    "rects": [
      [231.284, 402.126, 293.107, 410.142],
      [54.222, 392.164, 293.107, 400.180]
    ]
  },
  "text": "高亮的文字内容"
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `position.pageIndex` | `number` | 页面索引，**0-based** |
| `position.rects` | `number[][]` | 每行一个矩形，格式 `[x1, y1, x2, y2]` |
| `sortIndex` | `string` | 格式 `页码(5位)\|字符偏移(6位)\|距页顶(5位)` |

### 坐标系说明

Zotero 使用 **PDF 原生坐标系**：
- 原点在页面**左下角**
- Y 轴**向上**为正（与屏幕坐标相反）
- 单位为 **points（pt）**，1 pt = 1/72 英寸

---

## 3. Zotero 内置高亮的工作原理

### 整体架构

```
PDF 文件
  │
  ▼ PDF.js 解析
textContent（item 块级，每 item 包含一段文字）
  │
  ▼ zotero/reader 自定义处理
chars[] 数组（逐字符，每个字符含精确 PDF 坐标）
  │
  ├─ 用户拖拽 → getRangeBySelection()
  ├─ Ctrl+F 搜索 → _charMapping + getRangeRects()
  └─ 已有高亮 → getRangeByHighlight()
        │
        ▼ getRectsFromChars() / getRangeRects()
     rects[]（每行一个矩形）
        │
        ▼
  annotation.position.rects → 保存到 Zotero 数据库
```

### 关键代码路径

| 场景 | 调用链 |
|------|--------|
| 用户手动划选 | `pointerdown/up` → `getSelectionRanges()` → `getRange()` → `getRectsFromChars()` |
| Ctrl+F 搜索结果高亮 | `PDFFindController` → `_charMapping` → `getRangeRects()` |
| 已有 rects 恢复选区 | `getSelectionRangesByPosition()` → `getRangeByHighlight()` |

---

## 4. chars 对象详解

`zotero/reader` 内部将每一页的文字拆解为 `chars` 数组，每个元素是一个字符对象：

```typescript
interface Char {
  // --- Zotero 7 已有字段（Zotero 8 继续保留） ---
  c: string;              // 显示字符（可能是连字等多字符）
  u: string;              // Unicode 规范化字符（用于搜索匹配）
  rect: [number, number, number, number];        // 单字符精确 PDF 坐标 [x1,y1,x2,y2]
  inlineRect: [number, number, number, number];  // 所在行的完整行框（高度统一）
  rotation: 0 | 90 | 180 | 270;                 // 文字旋转角度
  lineBreakAfter: boolean;      // 是否是行末字符
  spaceAfter: boolean;          // 字符后是否跟空格
  paragraphBreakAfter: boolean; // 是否是段末字符
  wordBreakAfter: boolean;      // 是否是词末字符
  ignorable: boolean;           // 是否应忽略（如连字符等）
  fontName: string;             // 字体名称
  bold: boolean;
  italic: boolean;

  // --- Zotero 8 新增字段 ---
  fontSize: number;        // 计算后的字体大小
  glyphWidth: number;      // 字形宽度（来自字体度量）
  baseline: number;        // 基线坐标值
  diagonal: boolean;       // rotation % 90 !== 0（非正交旋转标记）
  offset: number;          // 在结构化 chars 数组中的全局索引（structure.js 添加）
  pageIndex: number;       // 所属页面索引（module.js 添加）
  isolated?: boolean;      // 字符不在页面 contentRect 内（仅批量预加载路径设置）
}
```

### `rect` vs `inlineRect` 的区别

| 属性 | 含义 | 用途 |
|------|------|------|
| `rect` | **单个字符**的精确包围盒 | 确定高亮的水平起止位置（X 轴） |
| `inlineRect` | 该字符**所在行**的完整高度框 | 确保同一行所有高亮等高（Y 轴） |

> **核心设计**：高亮的 X 坐标来自首末字符的 `rect`（精确到字符边界），Y 坐标来自 `inlineRect`（整行高度，视觉上更美观）。

---

## 5. 核心算法：从 chars 到 rects

### `getRangeRects`（最终使用版本）

来源：[`src/pdf/lib/utilities.js`](https://github.com/zotero/reader/blob/87e5c7f5972da43b35939d3585f9585bfe7e132d/src/pdf/lib/utilities.js#L592-L641)

> **Zotero 8 确认**：此函数在 Zotero 8（commit `fae5ba4`）中签名和核心逻辑不变，仍位于 `utilities.js:591`。`norm()` 辅助函数和 rotation 90/270 竖排文字支持均已包含。

```javascript
function getRangeRects(chars, offsetStart, offsetEnd) {
  let rects = [];
  let start = offsetStart;

  // 规范化矩形坐标（确保 x1<x2, y1<y2）
  const norm = (r) => {
    let [x1, y1, x2, y2] = r;
    return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  };

  for (let i = start; i <= offsetEnd; i++) {
    let char = chars[i];
    // 遇到行末或最后一个字符时，输出本行的 rect
    let isBreak = char.lineBreakAfter || i === offsetEnd;
    if (!isBreak) continue;

    let firstChar   = chars[start];
    let lastChar    = char;
    let firstRect   = norm(firstChar.rect);       // 行首字符精确坐标
    let lastRect    = norm(lastChar.rect);        // 行尾字符精确坐标
    let firstInline = norm(firstChar.inlineRect); // 行框（提供统一行高）

    let rot = firstChar?.rotation ?? 0;
    let isVertical = rot === 90 || rot === 270;

    let rect;
    if (isVertical) {
      // 竖排文字：X 轴用行框，Y 轴用字符坐标
      rect = [firstInline[0], firstRect[1], firstInline[2], lastRect[3]];
    } else {
      // 横排文字（常见情况）：
      //   X: 首字符左边 ~ 末字符右边（精确到字符边界）
      //   Y: 行框顶部 ~ 行框底部（整行统一高度）
      rect = [firstRect[0], firstInline[1], lastRect[2], firstInline[3]];
    }

    rects.push(rect.map(v => parseFloat(v.toFixed(3))));
    start = i + 1; // 移到下一行起点
  }

  return rects;
}
```

### 算法可视化（横排文字）

```
行框 inlineRect:  |←────────── 整行宽度 ──────────→|
                  ┌──────────────────────────────────┐  ← firstInline[3] (行顶 Y)
                  │  H  e  l  l  o  ·  W  o  r  l  d │
                  └──────────────────────────────────┘  ← firstInline[1] (行底 Y)
                  ↑                              ↑
            firstRect[0]                   lastRect[2]
            (首字符左边 X)                 (末字符右边 X)

高亮 rect = [firstRect[0], firstInline[1], lastRect[2], firstInline[3]]
```

---

## 6. 在插件中访问这些数据

### 访问权限说明

Zotero 插件运行在 **Mozilla chrome 特权层**，不受 X-ray 安全沙箱的限制，可以直接访问带 `_` 前缀的内部属性。

`_primaryView` 及其下属的 `_findController`、`_pdfPages` 等对象已处于 chrome 特权的 Zotero 层，**不需要** `wrappedJSObject` 穿透。`wrappedJSObject` 仅在直接访问 iframe 内的 PDF.js 原生对象（如 `PDFViewerApplication`）时才需要。

### 完整访问链路

```javascript
// ① Zotero 主层（chrome 特权，无需 wrappedJSObject）
const reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
await reader._initPromise;

// ② reader 内部的 PDF 视图对象
const primaryView = reader._internalReader._primaryView;

// ③ pdfPages 包含每页的 chars 数组（按需加载，见下方说明）
// 注意：_pdfPages 是 Object（非 Array），条目以 pageIndex 为 key
await primaryView._ensureBasicPageData(pageIndex);
const chars = primaryView._pdfPages[pageIndex].chars;

// ④ findController 是 Zotero 自定义的 PDFFindController
//    位于 Zotero reader 层，不是 PDF.js 原生的 findController
const findController = primaryView._findController;

// ⑤ findController 内置了文本→字符索引映射（与 Ctrl+F 同一套）
//    注意：_pageContents 是 NFD normalized 文本，_charMapping 映射的是原始文本偏移
const pageText    = findController._pageContents[pageIndex];   // NFD normalized 文本
const charMapping = findController._charMapping[pageIndex];    // 原始文本偏移 → chars 索引
const pageDiffs   = findController._pageDiffs[pageIndex];      // normalized↔原始偏移转换表
```

> **关键区分**：`PDFViewerApplication.findController` 是 PDF.js 原生的查找控制器；`_primaryView._findController` 是 Zotero 自定义的 `PDFFindController`，包含 `_charMapping`、`_pageDiffs` 等额外功能。插件开发应使用后者。

### `_pdfPages` 是 Object，不是 Array

`_pdfPages` 在 `pdf-view.js:126` 中声明为 `{}`（普通对象），不是数组。条目以 `pageIndex` 的字符串形式为 key。条目是**临时存在**的——当页面 DOM 被销毁时（`pdf-view.js:644`），对应条目会被 `delete` 清除，需要时再按需重新加载。

因此访问 `_pdfPages[pageIndex]` 前应始终检查条目是否存在，或使用 `_ensureBasicPageData` 确保加载。

### 各关键路径速查

| 目标 | 访问路径 |
|------|----------|
| `chars` 数组 | `reader._internalReader._primaryView._pdfPages[pageIndex].chars` |
| 确保页面数据加载 | `reader._internalReader._primaryView._ensureBasicPageData(pageIndex)` |
| findController | `reader._internalReader._primaryView._findController` |
| 页面文本（原始） | 需从 chars 重建，或通过 `_findController._extractText()` 触发后读 `_findController._pageContents[pageIndex]`（注意是 normalized 文本） |
| 文本→chars 映射 | `reader._internalReader._primaryView._findController._charMapping[pageIndex]`（注意映射的是原始文本偏移，非 normalized 偏移） |
| normalized→原始偏移 | `reader._internalReader._primaryView._findController._pageDiffs[pageIndex]` + `getOriginalIndex()` |
| 创建注释 | `reader._internalReader._annotationManager.addAnnotation(...)` |
| 计算 sortIndex | `import { getSortIndex } from selection.js`（或自行实现） |

---

## 7. 完整实现代码

### 7.1 工具函数

```javascript
/**
 * 根据 chars 起止索引计算每行的高亮矩形
 * 移植自 zotero/reader src/pdf/lib/utilities.js getRangeRects
 *
 * @param {Array}  chars       - 页面的 chars 数组
 * @param {number} offsetStart - 起始字符索引（含）
 * @param {number} offsetEnd   - 结束字符索引（含）
 * @returns {number[][]}       - rects 数组，每行一个 [x1, y1, x2, y2]
 */
function getRangeRects(chars, offsetStart, offsetEnd) {
  const rects = [];
  let start = offsetStart;

  const norm = (r) => {
    const [x1, y1, x2, y2] = r;
    return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  };

  for (let i = start; i <= offsetEnd; i++) {
    const char = chars[i];
    const isBreak = char.lineBreakAfter || i === offsetEnd;
    if (!isBreak) continue;

    const firstChar   = chars[start];
    const lastChar    = char;
    const firstRect   = norm(firstChar.rect);
    const lastRect    = norm(lastChar.rect);
    const firstInline = norm(firstChar.inlineRect);
    const rot         = firstChar?.rotation ?? 0;
    const isVertical  = rot === 90 || rot === 270;

    const rect = isVertical
      ? [firstInline[0], firstRect[1],  firstInline[2], lastRect[3]]
      : [firstRect[0],   firstInline[1], lastRect[2],   firstInline[3]];

    rects.push(rect.map(v => parseFloat(v.toFixed(3))));
    start = i + 1;
  }

  return rects;
}

/**
 * 计算注释的 sortIndex
 * 格式：页码(5位)|字符偏移(6位)|距页顶距离(5位)
 *
 * 注意：Zotero 8 reader 在 selection.js:399 导出了官方的 getSortIndex 函数。
 * 以下是简化实现，适用于无法直接引用 reader 模块的插件场景。
 */
function computeSortIndex(pageIndex, charOffset, rects) {
  const top = rects.length ? Math.floor(rects[0][1]) : 0;
  return [
    String(pageIndex).padStart(5, '0'),
    String(charOffset).padStart(6, '0'),
    String(top).padStart(5, '0'),
  ].join('|');
}

/**
 * 确保页面的 chars 数据已加载（Zotero 8 推荐方式）
 *
 * @param {Object} reader    - Zotero reader 实例
 * @param {number} pageIndex - 目标页面索引（0-based）
 * @returns {Promise<Array>} - 解析为 chars 数组
 */
async function ensurePageChars(reader, pageIndex) {
  const primaryView = reader._internalReader._primaryView;

  // Zotero 8 提供的官方按需加载方法
  await primaryView._ensureBasicPageData(pageIndex);

  const pageData = primaryView._pdfPages[pageIndex];
  if (!pageData?.chars?.length) {
    throw new Error(`Page ${pageIndex}: chars not available after _ensureBasicPageData`);
  }
  return pageData.chars;
}

/**
 * 降级方案：轮询等待 chars 加载（当 _ensureBasicPageData 不可用时）
 *
 * @param {Object} reader    - Zotero reader 实例
 * @param {number} pageIndex - 目标页面索引（0-based）
 * @param {number} timeout   - 超时毫秒数，默认 10000
 * @returns {Promise<Array>} - 解析为 chars 数组
 */
async function waitForPageChars(reader, pageIndex, timeout = 10000) {
  const pdfPages = reader._internalReader._primaryView._pdfPages;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (pdfPages[pageIndex]?.chars?.length) {
      return pdfPages[pageIndex].chars;
    }
    // 导航到目标页面以触发渲染
    reader._internalReader.navigate(
      Components.utils.cloneInto(
        { position: { pageIndex } },
        reader._iframeWindow
      )
    );
    await Zotero.Promise.delay(200);
  }

  throw new Error(`Timeout: page ${pageIndex} chars not loaded after ${timeout}ms`);
}

/**
 * 从 normalized 文本偏移转换为原始文本偏移
 *
 * _pageContents 存储的是 NFD normalized 文本，而 _charMapping 映射的是原始文本偏移。
 * 因此搜索 _pageContents 得到的偏移必须先经过此函数转换，才能用于 _charMapping 查找。
 *
 * 实际的 Zotero 实现（pdf-find-controller.js）使用 binarySearchFirstItem 进行二分查找，
 * 此处为简化的线性版本。
 *
 * @param {Array}  diffs    - findController._pageDiffs[pageIndex]，格式 [[pos, shift], ...]
 * @param {number} pos      - normalized 文本中的偏移
 * @param {number} len      - normalized 文本中的匹配长度
 * @returns {[number, number]} - [原始文本偏移, 原始文本长度]
 */
function getOriginalIndex(diffs, pos, len) {
  if (!diffs || diffs.length === 0) return [pos, len];

  let shift = 0;
  for (let i = 0; i < diffs.length; i++) {
    if (diffs[i][0] > pos) break;
    shift = diffs[i][1];
  }

  let shiftEnd = 0;
  let endPos = pos + len;
  for (let i = 0; i < diffs.length; i++) {
    if (diffs[i][0] > endPos) break;
    shiftEnd = diffs[i][1];
  }

  return [pos - shift, len - shiftEnd + shift];
}
```

### 7.2 核心高亮函数

```javascript
/**
 * 在 Zotero PDF 阅读器中搜索并高亮指定文字
 *
 * @param {string} searchText  - 要高亮的文字
 * @param {number} pageIndex   - 目标页面（0-based），-1 表示搜索所有页
 * @param {string} color       - 高亮颜色，默认黄色
 * @returns {Promise<Object|null>} - 创建的注释对象，未找到返回 null
 */
async function highlightTextInReader(searchText, pageIndex = 0, color = '#ffd400') {
  // ① 获取当前 reader
  const mainWin = Zotero.getMainWindow();
  const reader = Zotero.Reader.getByTabID(mainWin.Zotero_Tabs.selectedID);
  if (!reader || reader._type !== 'pdf') {
    Zotero.debug('[highlight] No PDF reader open');
    return null;
  }

  await reader._initPromise;
  const primaryView = reader._internalReader._primaryView;

  // ② 确保页面数据已加载（Zotero 8 推荐方式）
  let chars;
  try {
    chars = await ensurePageChars(reader, pageIndex);
  } catch (e) {
    Zotero.logError(e);
    return null;
  }

  // ③ 获取 findController（Zotero 自定义版，位于 reader 层，无需 wrappedJSObject）
  const findController = primaryView._findController;

  if (!findController._pageContents?.[pageIndex]) {
    Zotero.debug('[highlight] findController not ready, triggering _extractText...');
    // 触发文本索引建立
    try {
      await findController._extractText();
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!findController._pageContents?.[pageIndex]) {
      Zotero.debug('[highlight] findController still not ready');
      return null;
    }
  }

  const pageText    = findController._pageContents[pageIndex];  // NFD normalized 文本
  const charMapping = findController._charMapping[pageIndex];
  const pageDiffs   = findController._pageDiffs[pageIndex];

  // ④ 在 normalized 文本中搜索
  const normalizedStart = pageText.indexOf(searchText);
  if (normalizedStart === -1) {
    Zotero.debug(`[highlight] Text not found on page ${pageIndex}: "${searchText}"`);
    return null;
  }

  // ⑤ 将 normalized 偏移转换为原始文本偏移
  //    _pageContents 是 NFD normalized 文本，但 _charMapping 映射的是原始文本偏移
  const [originalStart, originalLen] = getOriginalIndex(
    pageDiffs, normalizedStart, searchText.length
  );
  const originalEnd = originalStart + originalLen - 1;

  // ⑥ 映射到 chars 数组索引
  const charStart = charMapping[originalStart];
  const charEnd   = charMapping[originalEnd];

  if (charStart === undefined || charEnd === undefined) {
    Zotero.debug('[highlight] charMapping lookup failed');
    return null;
  }

  // ⑦ 计算精确 rects
  const rects = getRangeRects(chars, charStart, charEnd);
  if (!rects.length) {
    Zotero.debug('[highlight] getRangeRects returned empty');
    return null;
  }

  Zotero.debug(`[highlight] rects: ${JSON.stringify(rects)}`);

  // ⑧ 创建高亮注释
  const annotationManager = reader._internalReader._annotationManager;
  const annotation = annotationManager.addAnnotation(
    Components.utils.cloneInto({
      type: 'highlight',
      color,
      pageLabel: String(pageIndex + 1),
      sortIndex: computeSortIndex(pageIndex, charStart, rects),
      position: { pageIndex, rects },
      text: searchText,
    }, reader._iframeWindow)
  );

  return annotation;
}
```

### 7.3 批量高亮（跨页搜索）

```javascript
/**
 * 在整个 PDF 中搜索并高亮所有匹配项
 *
 * @param {string} searchText - 要高亮的文字
 * @param {string} color      - 高亮颜色
 * @returns {Promise<number>} - 创建的高亮数量
 */
async function highlightAllOccurrences(searchText, color = '#ffd400') {
  const mainWin = Zotero.getMainWindow();
  const reader = Zotero.Reader.getByTabID(mainWin.Zotero_Tabs.selectedID);
  if (!reader || reader._type !== 'pdf') return 0;

  await reader._initPromise;

  const primaryView    = reader._internalReader._primaryView;
  const findController = primaryView._findController;
  const pdfPages       = primaryView._pdfPages;

  // 等待 findController 建立全文索引
  // 触发文本提取
  try {
    await findController._extractText();
  } catch {
    // 降级：等待自动填充
    let tries = 0;
    while (Object.keys(findController._pageContents || {}).length === 0 && tries < 50) {
      await Zotero.Promise.delay(200);
      tries++;
    }
  }

  const annotationManager = reader._internalReader._annotationManager;
  let count = 0;

  const pageIndices = Object.keys(findController._pageContents || {}).map(Number).sort((a, b) => a - b);

  for (const pageIndex of pageIndices) {
    const pageText    = findController._pageContents?.[pageIndex];
    const charMapping = findController._charMapping?.[pageIndex];
    const pageDiffs   = findController._pageDiffs?.[pageIndex];
    if (!pageText || !charMapping) continue;

    // 确保该页 chars 已加载（Zotero 8 推荐方式）
    if (!pdfPages[pageIndex]?.chars) {
      try {
        await primaryView._ensureBasicPageData(pageIndex);
      } catch {
        // 降级：轮询等待
        try {
          await waitForPageChars(reader, pageIndex, 5000);
        } catch {
          continue;
        }
      }
    }
    const chars = pdfPages[pageIndex]?.chars;
    if (!chars) continue;

    // 搜索所有匹配项
    let searchFrom = 0;
    while (true) {
      const normalizedStart = pageText.indexOf(searchText, searchFrom);
      if (normalizedStart === -1) break;

      // normalized 偏移 → 原始文本偏移
      const [originalStart, originalLen] = getOriginalIndex(
        pageDiffs, normalizedStart, searchText.length
      );
      const originalEnd = originalStart + originalLen - 1;

      const charStart = charMapping[originalStart];
      const charEnd   = charMapping[originalEnd];

      if (charStart !== undefined && charEnd !== undefined) {
        const rects = getRangeRects(chars, charStart, charEnd);
        if (rects.length) {
          annotationManager.addAnnotation(
            Components.utils.cloneInto({
              type: 'highlight',
              color,
              pageLabel: String(pageIndex + 1),
              sortIndex: computeSortIndex(pageIndex, charStart, rects),
              position: { pageIndex, rects },
              text: searchText,
            }, reader._iframeWindow)
          );
          count++;
        }
      }

      searchFrom = normalizedStart + 1;
    }
  }

  return count;
}
```

### 7.4 使用示例

```javascript
// 高亮当前第 0 页的某段文字
await highlightTextInReader('machine learning', 0, '#ff6666');

// 高亮全文所有匹配
const n = await highlightAllOccurrences('deep learning');
Zotero.debug(`Created ${n} highlights`);
```

---

## 8. 推荐实现策略（三层降级）

在插件中实现 PDF 字符级高亮时，建议采用三层降级策略，按优先级逐层尝试：

### Layer 1（首选）：Zotero 8 reader internal chars

直接使用 reader 内部维护的字符数据，精度最高且与 Zotero 内置行为一致：

| 功能 | 接口 |
|------|------|
| 页面字符数据 | `_primaryView._pdfPages[pageIndex].chars` |
| 按需加载页面 | `_primaryView._ensureBasicPageData(pageIndex)` |
| 文本搜索映射 | `_primaryView._findController._pageContents` / `_charMapping` / `_pageDiffs` |
| 矩形计算 | `getRangeRects()` from `utilities.js` |
| 排序索引 | `getSortIndex()` from `selection.js:399` |

**优点**：精度最高，与 Zotero 内置高亮完全一致。
**风险**：依赖未文档化内部 API。

### Layer 2（次选）：PDF.js getTextContent

当 Layer 1 的访问路径不可用时（例如 reader 内部结构变更），降级到 PDF.js 原生接口：

```javascript
// 通过 PDF.js 获取字符几何信息
const pdfPage = await pdfDocument.getPage(pageIndex + 1);  // PDF.js 页码 1-based
const textContent = await pdfPage.getTextContent({ includeCharsGeometry: true });

for (const item of textContent.items) {
  // item.chars 包含字符几何信息（当 includeCharsGeometry: true 时）
  if (item.chars) {
    // 每个 char 有 r: [x, y, w, h, angle] 等几何数据
  }
  // 如果 item.chars 不可用，使用 estimateCharacterWidths() 作为子降级
}
```

**优点**：直接基于 PDF.js 公开 API，不依赖 Zotero reader 内部结构。
**风险**：`includeCharsGeometry` 是 PDF.js 较新功能，精度可能不如 Layer 1。

### Layer 3（兜底）：比例切分

当前两层都不可用时，基于选区 rects 按文本长度比例切分：

```javascript
// 已知整行 rect 和行内文本，按字符数比例切分 X 坐标
function estimateCharRects(lineRect, lineText, targetStart, targetEnd) {
  const [x1, y1, x2, y2] = lineRect;
  const charWidth = (x2 - x1) / lineText.length;
  return [
    x1 + charWidth * targetStart,
    y1,
    x1 + charWidth * (targetEnd + 1),
    y2,
  ];
}
```

**优点**：最少的 API 依赖，几乎不可能因版本升级而失效。
**风险**：精度最低，等宽假设对非等宽字体不准确。

### 运行时检测逻辑

```javascript
async function getCharsForPage(reader, pageIndex) {
  const primaryView = reader?._internalReader?._primaryView;

  // Layer 1：Zotero 8 internal chars
  if (primaryView?._ensureBasicPageData) {
    try {
      await primaryView._ensureBasicPageData(pageIndex);
      const chars = primaryView._pdfPages?.[pageIndex]?.chars;
      if (chars?.length) return { layer: 1, chars };
    } catch { /* fall through */ }
  }

  // Layer 2：PDF.js getTextContent
  try {
    const iframeWin = primaryView?._iframeWindow;
    const pdfDoc = iframeWin?.wrappedJSObject?.PDFViewerApplication?.pdfDocument;
    if (pdfDoc) {
      const pdfPage = await pdfDoc.getPage(pageIndex + 1);
      const content = await pdfPage.getTextContent({ includeCharsGeometry: true });
      if (content?.items?.length) return { layer: 2, textContent: content };
    }
  } catch { /* fall through */ }

  // Layer 3：需要调用方提供基础 rects 信息
  return { layer: 3, chars: null };
}
```

---

## 9. 注意事项与风险

### 9.1 `_pdfPages` 的加载时机

`chars` 只在页面数据被加载后才存在。`_pdfPages` 是一个 Object（非 Array），条目以 `pageIndex` 为 key，且是临时存在的——页面 DOM 被销毁时条目会被清除。

```javascript
// ❌ 危险：直接访问可能是 undefined（条目可能未加载或已被清理）
const chars = reader._internalReader._primaryView._pdfPages[50]?.chars;

// ✅ 安全：使用 _ensureBasicPageData 确保加载（Zotero 8 推荐）
await reader._internalReader._primaryView._ensureBasicPageData(50);
const chars = reader._internalReader._primaryView._pdfPages[50].chars;

// ✅ 降级：使用轮询等待（当 _ensureBasicPageData 不可用时）
const chars = await waitForPageChars(reader, 50);
```

### 9.2 `wrappedJSObject` 的使用

`wrappedJSObject` 仅在直接访问 iframe 内的 PDF.js 原生对象时才需要。Zotero reader 层的对象（`_primaryView`、`_findController`、`_pdfPages` 等）已处于 chrome 特权层，不需要穿透。

```javascript
const primaryView = reader._internalReader._primaryView;

// ✅ findController 在 Zotero reader 层，直接访问即可
const findController = primaryView._findController;
const charMapping    = findController._charMapping[pageIndex];

// ⚠️ 仅在访问 iframe 内的 PDF.js 原生对象时才需要 wrappedJSObject
const iframeWin = primaryView._iframeWindow;
const pdfDoc = iframeWin.wrappedJSObject.PDFViewerApplication.pdfDocument;
```

### 9.3 跨 iframe 传递数据

向 reader iframe 传入 JS 对象时，必须使用 `Components.utils.cloneInto`：

```javascript
// ❌ 直接传入会因内存隔离报错
annotationManager.addAnnotation({ type: 'highlight', ... });

// ✅ 必须 cloneInto
annotationManager.addAnnotation(
  Components.utils.cloneInto({ type: 'highlight', ... }, reader._iframeWindow)
);
```

### 9.4 内部 API 的稳定性风险

以下属性/方法均为**未文档化的内部 API**，Zotero 版本升级时可能发生变化：

| API | 风险等级 | Zotero 8 备注 |
|-----|---------|------|
| `_internalReader` | 🟡 中 | Proxy 透传，Zotero 自身大量使用 |
| `_primaryView._pdfPages` | 🟡 中→高 | 是 Object 不是 Array，条目临时存在，会被 delete |
| `_primaryView._findController` | 🟡 中 | Zotero 自定义 PDFFindController，非 PDF.js 原生 |
| `_findController._charMapping` | 🔴 高 | 映射原始文本偏移（非 normalized），语义微妙 |
| `_findController._pageDiffs` | 🔴 高 | 必须配合 `_charMapping` 使用，做 normalized→原始偏移转换 |
| `_annotationManager.addAnnotation` | 🟡 中 | 测试代码中有使用，较稳定 |
| `_ensureBasicPageData` | 🟢 低 | Zotero 自己的按需加载方法，内部多处使用 |

**建议：** 所有对内部 API 的访问都加 `try/catch` 和 `?.` 可选链：

```javascript
function safeGetChars(reader, pageIndex) {
  try {
    return reader?._internalReader?._primaryView?._pdfPages?.[pageIndex]?.chars ?? null;
  } catch (e) {
    Zotero.logError(e);
    return null;
  }
}
```

### 9.5 性能注意

- 不要在循环中频繁调用 `waitForPageChars`，应批量处理
- `getRangeRects` 遍历 chars 数组，对于长文本性能良好，但 chars 数组本身可能有数千元素
- 建议对页面 chars 缓存处理结果，避免重复计算

---

## 10. 常见问题

### Q1：`findController._pageContents` 为空？

**原因**：Zotero 8 的 `_findController._extractText()` 在初始化时会被调用，但 `_pageContents` 的填充依赖于页面数据是否可用。如果页面尚未加载，`_extractText` 会被延迟执行。

**解决**：主动触发文本提取：

```javascript
const findController = reader._internalReader._primaryView._findController;

// Zotero 8 推荐方式：直接调用 _extractText
await findController._extractText();

// 然后检查 _pageContents 是否已填充
if (findController._pageContents?.[pageIndex]) {
  // 可用
}
```

如果 `_extractText` 不可用，可降级为等待自动填充：

```javascript
let tries = 0;
while (!findController._pageContents?.[pageIndex] && tries < 50) {
  await Zotero.Promise.delay(200);
  tries++;
}
```

### Q2：`charMapping[matchStart]` 返回 `undefined`？

**原因**：`_pageContents` 中的文本经过 NFD Unicode 规范化处理，与原始字符串的索引不一致。`_charMapping` 映射的是**原始文本**的偏移，而非 normalized 文本的偏移。如果直接用在 `_pageContents` 中搜索得到的偏移去查 `_charMapping`，会出现错位。

**解决**：必须使用 `_pageDiffs` 将 normalized 偏移转换为原始文本偏移后再查 `_charMapping`：

```javascript
const pageText  = findController._pageContents[pageIndex];   // normalized 文本
const pageDiffs = findController._pageDiffs[pageIndex];

// 在 normalized 文本中搜索
const normalizedStart = pageText.indexOf(searchText);

// 转换为原始文本偏移
const [originalStart, originalLen] = getOriginalIndex(pageDiffs, normalizedStart, searchText.length);

// 用原始偏移查 _charMapping
const charStart = findController._charMapping[pageIndex][originalStart];
```

### Q3：`_charMapping` 和 `_pageContents` 的偏移不一致？

**原因**：这是 Zotero 搜索系统设计的结果。`_pageContents` 存储 NFD normalized 文本（用于 diacritics-insensitive 搜索），而 `_charMapping` 建立的是原始文本偏移到 chars 数组索引的映射。两者的偏移空间不同。

**理解方式**：

```
原始文本:     "caf\u00E9"  (长度 4，\u00E9 是 e 带 accent 的单字符)
normalized:   "cafe\u0301"  (长度 5，e + combining accent 分成两个码点)

_pageContents 存的是 normalized 版本（长度 5）
_charMapping 映射的是原始版本（长度 4）的偏移

搜索 "cafe" 在 normalized 中得到偏移 0，
但 _charMapping 需要原始偏移 0（恰好一样），
搜索 "e" 在 normalized 中得到偏移 3，
但在原始文本中也是偏移 3（也一样），
差异在偏移 4 开始：normalized[4] 是 combining accent，原始文本没有对应位置。
```

**建议**：始终通过 `getOriginalIndex()` + `_pageDiffs` 做偏移转换，不要假设 normalized 和原始偏移相等。对纯 ASCII 文本两者恰好相同，但对含 diacritics、ligatures 的文本会不一致。

### Q4：高亮位置偏移？

**原因**：PDF 坐标原点在左下角（Y 轴向上），而屏幕坐标 Y 轴向下，如果手动计算了坐标变换可能弄反。

**解决**：始终使用 `getRangeRects` 从 `chars` 计算，不要手动变换坐标。`chars[i].rect` 已经是 PDF 原生坐标，可以直接存入 `annotation.position.rects`。

### Q5：高亮了但注释没有保存到 Zotero 数据库？

**原因**：`_annotationManager.addAnnotation` 会触发 Zotero 的保存流程，但有防抖延迟。

**解决**：跳过防抖（仅用于测试/调试）：

```javascript
reader._internalReader._annotationManager._skipAnnotationSavingDebounce = true;
```

正常情况下无需操作，注释会自动保存。

---

## 参考资料

| 资源 | 链接 |
|------|------|
| zotero/reader 选区核心逻辑 | [src/pdf/selection.js](https://github.com/zotero/reader/blob/87e5c7f5972da43b35939d3585f9585bfe7e132d/src/pdf/selection.js) |
| getRangeRects 实现 | [src/pdf/lib/utilities.js#L592](https://github.com/zotero/reader/blob/87e5c7f5972da43b35939d3585f9585bfe7e132d/src/pdf/lib/utilities.js#L592) |
| Zotero reader 管理器 | [xpcom/reader.js](https://github.com/zotero/zotero/blob/ce11d5295c461ed7e5ef4dacb00d06c4c2bc107f/chrome/content/zotero/xpcom/reader.js) |
| 注释数据结构测试 | [test/tests/annotationsTest.js](https://github.com/zotero/zotero/blob/ce11d5295c461ed7e5ef4dacb00d06c4c2bc107f/test/tests/annotationsTest.js) |
| reader 单元测试（API 参考） | [test/tests/readerTest.js](https://github.com/zotero/zotero/blob/ce11d5295c461ed7e5ef4dacb00d06c4c2bc107f/test/tests/readerTest.js) |
| zotero-better-notes（插件参考） | [github.com/windingwind/zotero-better-notes](https://github.com/windingwind/zotero-better-notes) |
