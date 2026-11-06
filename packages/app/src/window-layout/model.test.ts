import { describe, expect, it } from "vitest";
import { resolveHomeScreenTopInset, resolveSafeAreaInsets, type WindowLayout } from "./model";

const systemInsets = { top: 59, right: 0, bottom: 34, left: 0 };

function layout(bottomClearance: number | null | undefined): WindowLayout {
  return {
    bounds: { x: 0, y: 0, width: 402, height: 874 },
    verticalBarEdge: "none",
    verticalBar: null,
    bottomClearance,
    divisions: [],
  };
}

describe("resolveSafeAreaInsets", () => {
  it("replaces only the bottom with the measured bar clearance", () => {
    expect(resolveSafeAreaInsets(systemInsets, layout(24))).toEqual({
      ...systemInsets,
      bottom: 24,
    });
  });

  it("keeps a measured zero instead of falling back to the system inset", () => {
    expect(resolveSafeAreaInsets(systemInsets, layout(0)).bottom).toBe(0);
  });

  it.each([null, undefined])("leaves system insets alone without a clearance (%s)", (value) => {
    expect(resolveSafeAreaInsets(systemInsets, layout(value))).toBe(systemInsets);
  });

  it("leaves system insets alone before the native layout arrives", () => {
    expect(resolveSafeAreaInsets(systemInsets, null)).toBe(systemInsets);
  });
});

describe("home screen top inset", () => {
  it("starts content at the bottom of the Dynamic Island", () => {
    // A 402x874 pt iPhone: the island ends at 52 pt, the status-bar safe area at 62 pt.
    expect(resolveHomeScreenTopInset(62)).toBe(52);
  });

  it("keeps status bars without a cutout whole", () => {
    expect(resolveHomeScreenTopInset(24)).toBe(24);
    expect(resolveHomeScreenTopInset(0)).toBe(0);
  });
});
