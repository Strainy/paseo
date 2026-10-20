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

const manualUnreadAgentKeys = new Set<string>();

function manualUnreadAgentKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

interface MarkAgentUnreadClient {
  markAgentUnread: (agentId: string) => Promise<void>;
}

function getHostClient(serverId: string): MarkAgentUnreadClient | null {
  return getHostRuntimeStore().getClient(serverId);
}

export async function markAgentUnread(input: {
  serverId: string;
  agentId: string;
  getClient?: (serverId: string) => MarkAgentUnreadClient | null;
}): Promise<void> {
  const { serverId, agentId, getClient = getHostClient } = input;
  const client = getClient(serverId);
  if (!client) {
    throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
  }

  // Attention that lands while its agent is on screen is read when the user looks away. Note the
  // mark first so that blur leaves it for the next time the user opens the agent.
  const key = manualUnreadAgentKey(serverId, agentId);
  // A repeat the daemon rejects must not drop the mark an earlier call made.
  const addedMark = !manualUnreadAgentKeys.has(key);
  manualUnreadAgentKeys.add(key);
  try {
    await client.markAgentUnread(agentId);
  } catch (error) {
    if (addedMark) {
      manualUnreadAgentKeys.delete(key);
    }
    throw error;
  }
}

/** Whether the agent was marked unread since it was last read. Consumes the mark. */
export function consumeManualUnreadMark(input: { serverId: string; agentId: string }): boolean {
  return manualUnreadAgentKeys.delete(manualUnreadAgentKey(input.serverId, input.agentId));
}
