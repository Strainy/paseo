import { describe, expect, it } from "vitest";
import type { SidebarWorkspaceEntry } from "./sidebar-workspaces-view-model";
import { buildLabelGroups } from "./sidebar-label-view-model";

function workspace(workspaceKey: string, labels: string[]): SidebarWorkspaceEntry {
  return {
    workspaceKey,
    serverId: "host-1",
    workspaceId: workspaceKey,
    projectViewKey: "project-1",
    projectName: "Paseo",
    projectKind: "git",
    workspaceKind: "worktree",
    name: workspaceKey,
    workspaceDirectory: `/tmp/${workspaceKey}`,
    workspaceDirectoryLabel: workspaceKey,
    title: null,
    labels,
    currentBranch: workspaceKey,
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
  };
}

function summarizeGroup(group: ReturnType<typeof buildLabelGroups>[number]) {
  return {
    label: group.label,
    workspaceKeys: group.rows.map((entry) => entry.workspaceKey),
  };
}

describe("buildLabelGroups", () => {
  it("places a workspace in every assigned label group and keeps unlabeled workspaces visible", () => {
    const groups = buildLabelGroups(
      [workspace("one", ["frontend", "urgent"]), workspace("two", [])],
      "Unlabeled",
    );

    expect(groups.map(summarizeGroup)).toEqual([
      { label: "frontend", workspaceKeys: ["one"] },
      { label: "urgent", workspaceKeys: ["one"] },
      { label: "Unlabeled", workspaceKeys: ["two"] },
    ]);
  });
});
