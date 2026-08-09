import { describe, expect, it } from "vitest";
import { filterBranches } from "./workspace-base-branch-filter";

const BRANCHES = ["main", "jstrain/fix-hover", "mmilenkovic/feat-hover-intent", "hotfix/main-sync"];

describe("filterBranches", () => {
  it("returns every branch when the query is blank", () => {
    expect(filterBranches(BRANCHES, "   ")).toEqual(BRANCHES);
  });

  it("matches anywhere in the name, case-insensitively", () => {
    expect(filterBranches(BRANCHES, "HOVER")).toEqual([
      "jstrain/fix-hover",
      "mmilenkovic/feat-hover-intent",
    ]);
  });

  it("ranks earlier matches first", () => {
    expect(filterBranches(BRANCHES, "main")).toEqual(["main", "hotfix/main-sync"]);
  });

  it("returns nothing when no branch matches", () => {
    expect(filterBranches(BRANCHES, "nope")).toEqual([]);
  });
});
