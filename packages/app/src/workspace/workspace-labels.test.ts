import { describe, expect, it } from "vitest";
import {
  filterWorkspaceLabelSuggestions,
  mergeWorkspaceLabelSuggestions,
  parseWorkspaceLabelsInput,
  recordRecentWorkspaceLabels,
  resolveWorkspaceLabelDraftLabels,
} from "./workspace-labels";

describe("parseWorkspaceLabelsInput", () => {
  it("trims, removes empty labels, and preserves first occurrence order", () => {
    expect(parseWorkspaceLabelsInput(" frontend, urgent, frontend, , backend ")).toEqual([
      "frontend",
      "urgent",
      "backend",
    ]);
  });
});

describe("workspace label suggestions", () => {
  it("moves the labels from the latest save to the front", () => {
    expect(
      recordRecentWorkspaceLabels(["backend", "urgent", "frontend"], ["frontend", "ops"]),
    ).toEqual(["frontend", "ops", "backend", "urgent"]);
  });

  it("keeps saved recency ahead of labels discovered from workspaces", () => {
    expect(
      mergeWorkspaceLabelSuggestions({
        recentLabels: ["urgent", "backend"],
        selectedLabels: ["frontend"],
        knownLabels: ["docs", "backend"],
      }),
    ).toEqual(["urgent", "backend", "docs", "frontend"]);
  });

  it("filters labels case-insensitively", () => {
    expect(filterWorkspaceLabelSuggestions(["Backend", "frontend", "urgent"], "END")).toEqual([
      "Backend",
      "frontend",
    ]);
  });

  it("reuses the existing label casing when adding from the filter", () => {
    expect(resolveWorkspaceLabelDraftLabels(" bug, New Label ", ["Bug", "documentation"])).toEqual([
      "Bug",
      "New Label",
    ]);
  });
});
