import type { SidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";

export interface LabelGroup {
  key: string;
  label: string;
  rows: SidebarWorkspaceEntry[];
}

export function buildLabelGroups(
  workspaces: SidebarWorkspaceEntry[],
  unlabeledLabel: string,
): LabelGroup[] {
  const rowsByLabel = new Map<string, SidebarWorkspaceEntry[]>();
  const unlabeledRows: SidebarWorkspaceEntry[] = [];

  for (const workspace of workspaces) {
    if (workspace.labels.length === 0) {
      unlabeledRows.push(workspace);
      continue;
    }
    for (const label of workspace.labels) {
      const rows = rowsByLabel.get(label);
      if (rows) {
        rows.push(workspace);
      } else {
        rowsByLabel.set(label, [workspace]);
      }
    }
  }

  const groups = Array.from(rowsByLabel, ([label, rows]) => ({
    key: `label:${encodeURIComponent(label)}`,
    label,
    rows: sortRows(rows),
  })).sort((left, right) => left.label.localeCompare(right.label));
  if (unlabeledRows.length > 0) {
    groups.push({ key: "label:", label: unlabeledLabel, rows: sortRows(unlabeledRows) });
  }
  return groups;
}

function sortRows(rows: SidebarWorkspaceEntry[]): SidebarWorkspaceEntry[] {
  return rows.sort(
    (left, right) =>
      left.projectName.localeCompare(right.projectName) ||
      left.name.localeCompare(right.name) ||
      left.workspaceKey.localeCompare(right.workspaceKey),
  );
}
