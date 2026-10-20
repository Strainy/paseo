import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useHostFeature } from "@/runtime/host-features";
import { markAgentUnread } from "@/workspace/mark-unread";

/**
 * The tab menu's Mark as unread action for one host, or undefined when the host cannot mark agents
 * unread. Offer it only on tabs whose presentation is finished and read.
 */
export function useMarkAgentUnreadAction(
  serverId: string,
): ((agentId: string) => void) | undefined {
  const { t } = useTranslation();
  const toast = useToast();
  // COMPAT(agentMarkUnread): added in v0.12.1, remove gate after 2027-04-20.
  const supportsMarkUnread = useHostFeature(serverId, "agentMarkUnread");
  // The entry stays offered until the agent update arrives, and the daemon rejects a repeat
  // mark because the agent is no longer read.
  const pendingAgentIdsRef = useRef(new Set<string>());
  const markUnread = useCallback(
    (agentId: string) => {
      const pendingAgentIds = pendingAgentIdsRef.current;
      if (pendingAgentIds.has(agentId)) {
        return;
      }
      pendingAgentIds.add(agentId);
      void markAgentUnread({ serverId, agentId })
        .catch((error) => {
          toast.error(
            error instanceof Error
              ? error.message
              : t("workspace.tabs.toasts.failedToMarkAgentUnread"),
          );
        })
        .finally(() => {
          pendingAgentIds.delete(agentId);
        });
    },
    [serverId, t, toast],
  );
  return supportsMarkUnread ? markUnread : undefined;
}
