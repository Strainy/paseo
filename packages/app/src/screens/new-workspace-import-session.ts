import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { ImportSessionTarget } from "@/components/import-session-sheet";
import { getHostProjectId, type HostProjectListItem } from "@/projects/host-projects";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";

export function resolveNewWorkspaceImportSessionTarget(input: {
  project: HostProjectListItem | null;
  providerContextCwd: string | null;
  serverId: string;
}): ImportSessionTarget | null {
  if (!input.project || !input.providerContextCwd?.trim()) return null;
  const projectId = getHostProjectId(input.project, input.serverId);
  if (!projectId?.trim()) return null;
  return {
    kind: "project",
    projectId,
    providerContextCwd: input.providerContextCwd,
  };
}

export function importedSessionWorkspaceNavigation(
  serverId: string,
  agent: Pick<AgentSnapshotPayload, "id" | "workspaceId">,
): NavigateToWorkspaceInput | null {
  const workspaceId = agent.workspaceId?.trim();
  if (!workspaceId) {
    return null;
  }
  return {
    serverId,
    workspaceId,
    target: { kind: "agent", agentId: agent.id },
  };
}
