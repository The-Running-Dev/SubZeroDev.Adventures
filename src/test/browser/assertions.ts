/**
 * Real-browser assertion helpers (W65.3). Each reads a **computed** value
 * from a rendered element -- never the stylesheet's source text -- so a
 * passing assertion means the browser actually laid the element out that
 * way. See `assertions.browser.test.ts` for the self-test proving each one
 * fails when the condition it checks is violated.
 */

function toFixedPx(value: number): string {
  return `${value.toFixed(2)}px`;
}

/** Computed font size in rem, relative to the root element's computed font size. */
export function computedFontSizeRem(
  element: Element,
  root: Element = document.documentElement,
): number {
  const rootPx = Number.parseFloat(getComputedStyle(root).fontSize);
  const elementPx = Number.parseFloat(getComputedStyle(element).fontSize);
  return elementPx / rootPx;
}

export function assertMinFontSize(
  element: Element,
  minRem: number,
  root: Element = document.documentElement,
): void {
  const actual = computedFontSizeRem(element, root);
  if (actual < minRem - 0.001) {
    throw new Error(
      `expected computed font-size >= ${minRem}rem, got ${actual.toFixed(4)}rem`,
    );
  }
}

/** Computed line-height as a multiple of the element's own computed font size. */
export function computedLineHeightMultiple(element: Element): number {
  const style = getComputedStyle(element);
  const fontPx = Number.parseFloat(style.fontSize);
  const raw = style.lineHeight;
  const lineHeightPx = raw === "normal" ? fontPx * 1.2 : Number.parseFloat(raw);
  return lineHeightPx / fontPx;
}

export function assertMinLineHeight(
  element: Element,
  minMultiple: number,
): void {
  const actual = computedLineHeightMultiple(element);
  if (actual < minMultiple - 0.001) {
    throw new Error(
      `expected computed line-height >= ${minMultiple}x font size, got ${actual.toFixed(4)}x`,
    );
  }
}

/** Real hit area from `getBoundingClientRect`, produced by actual layout. */
export function hitArea(element: Element): { width: number; height: number } {
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

export function assertMinHitArea(element: Element, minPx = 44): void {
  const { width, height } = hitArea(element);
  if (width < minPx - 0.5 || height < minPx - 0.5) {
    throw new Error(
      `expected a hit area of at least ${minPx}x${minPx}px, got ${toFixedPx(width)}x${toFixedPx(height)}`,
    );
  }
}

export function assertMinGap(a: Element, b: Element, minPx = 8): void {
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  const verticalGap = rb.top - ra.bottom;
  const horizontalGap = rb.left - ra.right;
  const gap = Math.max(verticalGap, horizontalGap);
  if (gap < minPx - 0.5) {
    throw new Error(
      `expected at least ${minPx}px of non-actionable space between adjacent controls, got ${toFixedPx(gap)}`,
    );
  }
}

/**
 * Whether the document scrolls horizontally at its current viewport size.
 * A 1px tolerance absorbs subpixel rounding across browser engines.
 */
export function assertNoHorizontalOverflow(doc: Document = document): void {
  const root = doc.documentElement;
  if (root.scrollWidth > root.clientWidth + 1) {
    throw new Error(
      `document scrolls horizontally: scrollWidth ${root.scrollWidth}px > clientWidth ${root.clientWidth}px`,
    );
  }
}
