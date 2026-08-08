import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertMinFontSize,
  assertMinGap,
  assertMinHitArea,
  assertMinLineHeight,
  assertNoHorizontalOverflow,
} from "./assertions";

/**
 * W65.3 self-tests: each capability must demonstrably fail when the
 * condition it checks is violated, not just pass on compliant markup.
 * Proving that here, once, is what lets the specs under `../play/browser/`
 * trust a passing assertion instead of re-deriving it per spec.
 */

function mount(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  return container;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("assertMinFontSize", () => {
  it("fails for the right reason when computed size is below the floor", () => {
    const el = mount(
      '<p style="font-size: 12px">too small</p>',
    ).firstElementChild!;
    expect(() => assertMinFontSize(el, 1.125)).toThrow(/font-size/);
  });

  it("passes when the computed size meets the floor", () => {
    const el = mount('<p style="font-size: 18px">fine</p>').firstElementChild!;
    expect(() => assertMinFontSize(el, 1.125)).not.toThrow();
  });

  it("reads the computed value, not the stylesheet's source text", () => {
    // A percentage resolves against the parent's computed size -- only a
    // real cascade produces the right px/rem figure here. The root's
    // default computed size is 16px, so 50% of a 32px parent lands at
    // exactly 1rem.
    const container = mount(
      '<div style="font-size: 32px"><span style="font-size: 50%">half</span></div>',
    );
    const span = container.querySelector("span")!;
    expect(() => assertMinFontSize(span, 1)).not.toThrow();
    expect(() => assertMinFontSize(span, 1.1)).toThrow();
  });
});

describe("assertMinLineHeight", () => {
  it("fails when the computed line-height is below the required multiple", () => {
    const el = mount(
      '<p style="font-size: 16px; line-height: 1.1">cramped</p>',
    ).firstElementChild!;
    expect(() => assertMinLineHeight(el, 1.6)).toThrow(/line-height/);
  });

  it("passes when the computed line-height meets the multiple", () => {
    const el = mount(
      '<p style="font-size: 16px; line-height: 1.6">roomy</p>',
    ).firstElementChild!;
    expect(() => assertMinLineHeight(el, 1.6)).not.toThrow();
  });
});

describe("assertMinHitArea", () => {
  it("fails when a control renders smaller than the floor", () => {
    const el = mount(
      '<button style="width:20px;height:20px;padding:0;border:0;box-sizing:border-box;">x</button>',
    ).firstElementChild!;
    expect(() => assertMinHitArea(el)).toThrow(/hit area/);
  });

  it("passes when real padding produces the floor, not just the box's own size", () => {
    const el = mount(
      '<button style="font-size:10px;width:auto;height:auto;padding:20px;border:0;box-sizing:border-box;">x</button>',
    ).firstElementChild!;
    expect(() => assertMinHitArea(el)).not.toThrow();
  });
});

describe("assertMinGap", () => {
  it("fails when adjacent controls sit closer than the floor", () => {
    const container = mount(
      '<div style="display:flex;">' +
        '<button style="width:44px;height:44px;">a</button>' +
        '<button style="width:44px;height:44px;margin-left:2px;">b</button>' +
        "</div>",
    );
    const [a, b] = container.querySelectorAll("button");
    expect(() => assertMinGap(a!, b!)).toThrow(/non-actionable space/);
  });

  it("passes when the gap meets the floor", () => {
    const container = mount(
      '<div style="display:flex;">' +
        '<button style="width:44px;height:44px;">a</button>' +
        '<button style="width:44px;height:44px;margin-left:8px;">b</button>' +
        "</div>",
    );
    const [a, b] = container.querySelectorAll("button");
    expect(() => assertMinGap(a!, b!)).not.toThrow();
  });
});

describe("assertNoHorizontalOverflow", () => {
  it("fails when a wide element forces horizontal scroll", async () => {
    await page.viewport(390, 700);
    mount('<div style="width: 900px; height: 10px;"></div>');
    expect(() => assertNoHorizontalOverflow()).toThrow(/scrolls horizontally/);
  });

  it("passes when nothing exceeds the viewport", async () => {
    await page.viewport(390, 700);
    expect(() => assertNoHorizontalOverflow()).not.toThrow();
  });
});
