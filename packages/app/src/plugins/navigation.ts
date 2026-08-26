import { router } from "expo-router";
import type { PluginOpenWorkspaceOptions, PluginPanelLocation } from "@getpaseo/plugin";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { openExternalUrl } from "@/utils/open-external-url";
import type { PluginNavigation } from "./actions";
import { buildPluginSurfaceRoute } from "./routes";

export interface PluginNavigationDeps {
  navigateToWorkspace: typeof navigateToWorkspace;
  navigateToAgent: typeof navigateToAgent;
  openExternalUrl: typeof openExternalUrl;
}

const defaultDeps: PluginNavigationDeps = { navigateToWorkspace, navigateToAgent, openExternalUrl };
const EXTERNAL_URL_PROTOCOLS = new Set(["http:", "https:"]);

export function createPluginNavigation(
  input: { serverId: string; workspaceId: string | null },
  deps: PluginNavigationDeps = defaultDeps,
): PluginNavigation {
  const { serverId, workspaceId } = input;
  function placement(location: PluginPanelLocation) {
    if (location !== "explorer") return undefined;
    if (!workspaceId) throw new Error("No active workspace");
    const workspaceKey = `${serverId}:${workspaceId}`;
    const paneId = useWorkspaceLayoutStore.getState().showExplorerSidebar(workspaceKey);
    if (!paneId) throw new Error("Explorer is unavailable");
    return { mode: "pane" as const, paneId };
  }
  return {
    openWorkspace(targetWorkspaceId: string, options?: PluginOpenWorkspaceOptions) {
      const normalizedWorkspaceId = targetWorkspaceId.trim();
      if (!normalizedWorkspaceId) throw new Error("openWorkspace requires a workspace id");
      const targetServerId = options?.serverId?.trim() || serverId;
      const agentId = options?.agentId?.trim();
      if (agentId) {
        deps.navigateToAgent({
          serverId: targetServerId,
          agentId,
          workspaceId: normalizedWorkspaceId,
          pin: options?.pin ?? true,
        });
        return;
      }
      deps.navigateToWorkspace({
        serverId: targetServerId,
        workspaceId: normalizedWorkspaceId,
        ...(options?.pin === undefined ? {} : { pin: options.pin }),
      });
    },
    async openExternal(url: string) {
      let protocol: string;
      try {
        protocol = new URL(url).protocol;
      } catch {
        throw new Error(`openExternal requires an absolute URL: ${url}`);
      }
      if (!EXTERNAL_URL_PROTOCOLS.has(protocol)) {
        throw new Error(`openExternal only opens http(s) URLs: ${url}`);
      }
      await deps.openExternalUrl(url);
    },
    openSurface(pluginId, surfaceId) {
      router.push(buildPluginSurfaceRoute(serverId, pluginId, { kind: "surface", id: surfaceId }));
    },
    openWorkspacePanel(pluginId, panelId, location) {
      if (!workspaceId) throw new Error("No active workspace");
      deps.navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "plugin", pluginId, panelId, context: "workspace" },
        placement: placement(location),
      });
    },
    openAgentPanel(pluginId, panelId, agentId, location) {
      if (!workspaceId) throw new Error("No active workspace");
      deps.navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "plugin", pluginId, panelId, context: "agent", agentId },
        placement: placement(location),
      });
    },
  };
}
