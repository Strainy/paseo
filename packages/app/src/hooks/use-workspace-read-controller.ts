import { useCallback, useMemo, useRef, useState } from "react";
import { i18n } from "@/i18n/i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { WorkspaceDescriptor } from "@/stores/session-store";

export type WorkspaceReadAction = "mark_as_read" | "mark_unread" | null;

export function resolveWorkspaceReadAction({
  status,
  markedUnreadAt,
  supportsMarkUnread,
}: {
  status: WorkspaceDescriptor["status"] | null | undefined;
  markedUnreadAt: string | null | undefined;
  supportsMarkUnread: boolean;
}): WorkspaceReadAction {
  if (markedUnreadAt != null || status === "attention" || status === "failed") {
    return "mark_as_read";
  }
  if (status != null && supportsMarkUnread) {
    return "mark_unread";
  }
  return null;
}

export interface WorkspaceReadController {
  action: WorkspaceReadAction;
  pending: boolean;
  performAction: () => Promise<void>;
}

export function useWorkspaceReadController({
  serverId,
  workspaceId,
  status,
  markedUnreadAt,
  supportsMarkUnread,
}: {
  serverId: string;
  workspaceId: string;
  status: WorkspaceDescriptor["status"] | null | undefined;
  markedUnreadAt: string | null | undefined;
  supportsMarkUnread: boolean;
}): WorkspaceReadController {
  const action = resolveWorkspaceReadAction({ status, markedUnreadAt, supportsMarkUnread });
  const pendingRequestRef = useRef<Promise<void> | null>(null);
  const [pending, setPending] = useState(false);

  const performAction = useCallback((): Promise<void> => {
    const pendingRequest = pendingRequestRef.current;
    if (pendingRequest) {
      return pendingRequest;
    }
    if (!action) {
      return Promise.resolve();
    }

    const request = (async () => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) {
        throw new Error(i18n.t("sidebar.workspace.toasts.hostDisconnected"));
      }
      if (action === "mark_as_read") {
        await client.clearWorkspaceAttention(workspaceId);
        return;
      }
      await client.markWorkspaceUnread(workspaceId);
    })();

    pendingRequestRef.current = request;
    setPending(true);
    const clearPending = () => {
      if (pendingRequestRef.current !== request) {
        return;
      }
      pendingRequestRef.current = null;
      setPending(false);
    };
    void request.then(clearPending, clearPending);
    return request;
  }, [action, serverId, workspaceId]);

  return useMemo(() => ({ action, pending, performAction }), [action, pending, performAction]);
}
