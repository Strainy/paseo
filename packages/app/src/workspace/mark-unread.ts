import { i18n } from "@/i18n/i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";

export async function markWorkspaceUnread(serverId: string, workspaceId: string): Promise<void> {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) {
    throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
  }

  const workspaceKey = `${serverId}:${workspaceId}`;
  const layout = useWorkspaceLayoutStore.getState();
  // End viewing before restoring attention. The next pane focus reads it normally;
  // leaving the workspace must not consume the mark the user just made.
  const focusToken = layout.layoutByWorkspace[workspaceKey]?.focusedPaneId
    ? layout.unfocusPane(workspaceKey)
    : null;
  try {
    await client.markWorkspaceUnread(workspaceId);
  } catch (error) {
    if (focusToken) {
      layout.restorePaneFocus(workspaceKey, focusToken);
    }
    throw error;
  }
}

export async function markAgentUnread(serverId: string, agentId: string): Promise<void> {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) {
    throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
  }
  // Attention that lands while its agent is on screen stays unread until the next deliberate
  // focus, so a mark on the visible tab needs no pane unfocus like the workspace mark does.
  await client.markAgentUnread(agentId);
}
