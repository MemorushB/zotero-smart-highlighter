/**
 * Computes sub-rects for a span's character range within a full text selection.
 *
 * MVP approach: proportional interpolation based on character position ratios.
 * - Single-line (1 rect): linearly interpolate x-coords by char ratio.
 * - Multi-line (N rects): distribute chars across rects by width proportion,
 *   then cut start/end rects.
 */

// ── Types ────────────────────────────────────────────────────────────

interface LineAllocation {
  rectIndex: number;
  charStart: number;  // inclusive char offset for this line
  charEnd: number;    // exclusive char offset for this line
  rect: number[];     // [x1, y1, x2, y2]
}

// ── Character width estimation ──────────────────────────────────────

// Relative width weights for different character classes
// Based on typical proportional font metrics (normalized to average width = 1.0)
export const CHAR_WIDTH_WEIGHTS: Record<string, number> = {
  // Narrow characters (~0.3-0.4 relative width)
  narrow: 0.35,
  // Medium-narrow characters (~0.5-0.6)
  mediumNarrow: 0.55,
  // Average width characters (~1.0)
  average: 1.0,
  // Wide characters (~1.2-1.5)
  wide: 1.3,
  // Extra wide characters (~1.5-2.0)
  extraWide: 1.7,
};

export function getCharWidthClass(char: string): number {
  const code = char.charCodeAt(0);

  // Narrow: i, l, 1, |, ', !, ., :, ;, ,
  if ('il1|\'!.:;,'.includes(char)) return CHAR_WIDTH_WEIGHTS.narrow;

  // Medium-narrow: f, t, j, r, I, J, (, ), [, ], {, }
  if ('ftjrIJ()[]{}/-'.includes(char)) return CHAR_WIDTH_WEIGHTS.mediumNarrow;

  // Wide: m, w, M, W, @, &
  if ('mwMW@&'.includes(char)) return CHAR_WIDTH_WEIGHTS.wide;

  // Extra wide: full-width characters (CJK), em-dash
  if (code >= 0x3000 && code <= 0x9FFF) return CHAR_WIDTH_WEIGHTS.extraWide; // CJK
  if (code >= 0xFF00 && code <= 0xFFEF) return CHAR_WIDTH_WEIGHTS.extraWide; // Fullwidth forms
  if (char === '—' || char === '…') return CHAR_WIDTH_WEIGHTS.wide;

  // Spaces: slightly narrower than average
  if (char === ' ') return 0.5;

  // Digits: slightly narrower than average
  if (code >= 0x30 && code <= 0x39) return 0.85;

  // Uppercase letters (except I, J, M, W which are handled above): wider than average
  if (code >= 0x41 && code <= 0x5A) return 1.1;

  // Default: average width
  return CHAR_WIDTH_WEIGHTS.average;
}

/**
 * Estimate individual character widths for a string based on character classes.
 * The sum of returned widths equals the total width.
 */
export function estimateCharacterWidths(str: string, totalWidth: number): number[] {
  if (str.length === 0) return [];
  if (str.length === 1) return [totalWidth];

  // Calculate relative weights for each character
  const weights = str.split('').map(getCharWidthClass);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  // Avoid division by zero
  if (totalWeight === 0) {
    const uniform = totalWidth / str.length;
    return new Array(str.length).fill(uniform);
  }

  // Scale weights to match total width
  return weights.map(w => (w / totalWeight) * totalWidth);
}

// ── Helpers ──────────────────────────────────────────────────────────

function clampRect(rect: number[]): number[] {
  const [x1, y1, x2, y2] = rect;
  // Ensure x1 <= x2 (degenerate rects from rounding)
  if (x1 > x2) return [x2, y1, x1, y2];
  return [x1, y1, x2, y2];
}

function allocateCharsToLines(fullText: string, fullRects: number[][]): LineAllocation[] {
  if (fullRects.length === 0) return [];

  const totalChars = fullText.length;
  if (totalChars === 0) return [];

  // Compute width of each rect
  const widths = fullRects.map(r => Math.abs(r[2] - r[0]));
  const totalRectWidth = widths.reduce((sum, w) => sum + w, 0);

  // Guard: zero total width — distribute evenly
  if (totalRectWidth <= 0) {
    const charsPerLine = Math.ceil(totalChars / fullRects.length);
    return fullRects.map((rect, i) => ({
      rectIndex: i,
      charStart: i * charsPerLine,
      charEnd: Math.min((i + 1) * charsPerLine, totalChars),
      rect,
    }));
  }

  const charWidths = estimateCharacterWidths(fullText, totalRectWidth);
  const allocations: LineAllocation[] = [];
  let charCursor = 0;
  let cumulativeTargetWidth = 0;
  let cumulativeCharWidth = 0;

  for (let i = 0; i < fullRects.length; i++) {
    const isLastLine = i === fullRects.length - 1;
    let charEnd = charCursor;
    cumulativeTargetWidth += widths[i];

    if (isLastLine) {
      charEnd = totalChars;
    } else {
      while (charEnd < totalChars) {
        const nextCharWidth = charWidths[charEnd];
        // Break if adding the next character makes us overshoot more than halfway
        if (cumulativeCharWidth + nextCharWidth / 2 > cumulativeTargetWidth && charEnd > charCursor) {
          break;
        }
        cumulativeCharWidth += nextCharWidth;
        charEnd++;
      }
    }

    allocations.push({
      rectIndex: i,
      charStart: charCursor,
      charEnd,
      rect: fullRects[i],
    });

    charCursor = charEnd;
  }

  return allocations;
}

function interpolateXInRect(
  rect: number[],
  fullText: string,
  lineCharStart: number,
  lineCharEnd: number,
  targetCharStart: number,
  targetCharEnd: number
): number[] {
  const [x1, y1, x2, y2] = rect;
  const lineText = fullText.substring(lineCharStart, lineCharEnd);
  const lineLen = lineText.length;

  if (lineLen <= 0) return [x1, y1, x2, y2];

  const rectWidth = x2 - x1;
  const charWidths = estimateCharacterWidths(lineText, rectWidth);

  let widthBefore = 0;
  for (let i = 0; i < targetCharStart - lineCharStart; i++) {
    widthBefore += charWidths[i];
  }

  let spanWidth = 0;
  for (let i = targetCharStart - lineCharStart; i < targetCharEnd - lineCharStart; i++) {
    spanWidth += charWidths[i];
  }

  const newX1 = x1 + widthBefore;
  const newX2 = newX1 + spanWidth;

  return clampRect([newX1, y1, newX2, y2]);
}

function applyVerticalInset(rect: number[]): number[] {
  const [x1, y1, x2, y2] = rect;
  const oldHeight = y2 - y1;
  const newHeight = oldHeight * 0.8;
  const newY1 = y1 + oldHeight * 0.15;
  const newY2 = newY1 + newHeight;
  return [x1, newY1, x2, newY2];
}

// ── Public API ───────────────────────────────────────────────────────

export function computeSpanRects(
  fullText: string,
  fullRects: number[][],
  spanStart: number,
  spanEnd: number
): number[][] {
  // Guard: invalid inputs
  if (fullRects.length === 0) return [];
  if (spanStart < 0 || spanEnd <= spanStart || spanStart >= fullText.length) return [];

  // Clamp span range to text bounds
  const clampedEnd = Math.min(spanEnd, fullText.length);

  // Fast path: single rect
  if (fullRects.length === 1) {
    return [applyVerticalInset(interpolateXInRect(fullRects[0], fullText, 0, fullText.length, spanStart, clampedEnd))];
  }

  // Multi-rect: allocate chars to lines, find overlapping rects
  const lines = allocateCharsToLines(fullText, fullRects);
  const spanRects: number[][] = [];

  for (const line of lines) {
    // Skip lines with no overlap
    if (line.charEnd <= spanStart || line.charStart >= clampedEnd) continue;

    // Compute the overlap range within this line
    const overlapStart = Math.max(spanStart, line.charStart);
    const overlapEnd = Math.min(clampedEnd, line.charEnd);

    // Does the span cover the entire line?
    const spansEntireLine = overlapStart === line.charStart && overlapEnd === line.charEnd;
    if (spansEntireLine) {
      spanRects.push(applyVerticalInset(line.rect));
      continue;
    }

    // Partial line — interpolate x coordinates
    spanRects.push(applyVerticalInset(interpolateXInRect(line.rect, fullText, line.charStart, line.charEnd, overlapStart, overlapEnd)));
  }

  return spanRects;
}
