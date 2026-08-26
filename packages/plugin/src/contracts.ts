import type { ComponentType } from "react";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { PluginRpcContract } from "./rpc.js";

export interface PluginTheme {
  readonly colors: {
    readonly surface0: string;
    readonly surface1: string;
    readonly surface2: string;
    readonly border: string;
    readonly foreground: string;
    readonly foregroundMuted: string;
    readonly accent: string;
    readonly accentForeground: string;
    readonly statusSuccess: string;
    readonly statusWarning: string;
    readonly statusDanger: string;
  };
}

export interface PluginHostProps {
  theme: PluginTheme;
  host: {
    id: string;
    label: string;
  };
  layout: {
    compact: boolean;
    platform: "ios" | "android" | "web";
  };
}

interface PluginNavigableHostProps extends PluginHostProps {
  /** Client-owned navigation. Undefined on older hosts; hide dependent affordances when absent. */
  readonly navigation?: {
    readonly openAgent: (input: { readonly agentId: string }) => void;
    readonly openWorkspace: (input: { readonly workspaceId: string }) => void;
  };
}

export interface PluginSurfaceProps extends PluginNavigableHostProps {
  /**
   * Updates a contributed sidebar item's visible badge without waiting for its
   * next poll. Older hosts omit this callback.
   */
  setSidebarBadgeCount?(itemId: string, count: number): void;
}

export interface PluginIconProps {
  name: string;
  size?: number;
  color?: string;
}

export interface PluginProjectPlacementSnapshot {
  readonly serverId: string;
  readonly serverName: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRootPath: string;
  readonly projectKind: "git" | "non_git" | "directory";
  readonly isOnline: boolean;
}

export interface PluginProjectSnapshot {
  /** Cross-host identity shared by placements of the same project. */
  readonly projectKey: string;
  readonly projectName: string;
  readonly placements: readonly PluginProjectPlacementSnapshot[];
}

export interface PluginWorkspaceSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly projectDisplayName: string;
  readonly projectRootPath: string;
  readonly directory: string;
  readonly projectKind: "git" | "non_git" | "directory";
  readonly kind: "directory" | "local_checkout" | "checkout" | "worktree";
  readonly name: string;
  readonly title: string | null;
  readonly status: "needs_input" | "failed" | "running" | "attention" | "done";
  readonly statusEnteredAt: string | null;
  readonly archivingAt: string | null;
  readonly diffStat: { readonly additions: number; readonly deletions: number } | null;
}

export interface PluginAgentSnapshot {
  readonly id: string;
  readonly workspaceId: string;
  readonly provider: string;
  readonly status: "initializing" | "idle" | "running" | "error" | "closed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastActivityAt: string;
  readonly title: string | null;
  readonly cwd: string;
  readonly model: string | null;
  readonly currentModeId: string | null;
  readonly thinkingOptionId: string | null;
  readonly requiresAttention: boolean;
  readonly attentionReason: "finished" | "error" | "permission" | null;
  readonly parentAgentId: string | null;
  readonly labels: Readonly<Record<string, string>>;
}

export type PluginPanelLocation = "workspace" | "explorer";

export interface PluginOpenPanelOptions {
  location?: PluginPanelLocation;
}

export interface PluginOpenWorkspaceOptions {
  /** Focus this agent inside the workspace instead of its default tab. */
  agentId?: string;
  /** Pin the opened tab. Defaults to true when `agentId` is set. */
  pin?: boolean;
  /** Navigate on this host instead of the plugin installation's selected host. */
  serverId?: string;
}

/**
 * In-app navigation the host performs on a plugin's behalf. Plugins never get
 * router access; this is the whole navigation surface.
 */
export interface PluginNavigation {
  openWorkspace(workspaceId: string, options?: PluginOpenWorkspaceOptions): void;
  /**
   * Hands an http(s) URL to the OS browser. Plugin code cannot do this itself:
   * `Linking.openURL` reaches `window.open`, which Paseo's desktop shell turns
   * into an in-app browser tab rather than leaving the app.
   */
  openExternal(url: string): Promise<void>;
}

interface PluginWorkspacePanelBase {
  id: string;
  title: string;
  icon: string;
  locations?: readonly PluginPanelLocation[];
}

export interface PluginWorkspacePanelProps extends PluginNavigableHostProps {
  context: "workspace";
  workspaceId: string;
}

export interface PluginAgentPanelProps extends PluginNavigableHostProps {
  context: "agent";
  workspaceId: string;
  agentId: string;
}

export interface PluginComposerPillProps extends PluginHostProps {
  workspaceId: string;
  agentId: string;
}

export interface PluginComposerPillContribution {
  id: string;
  title: string;
  workspaceId: string;
  agentId: string;
  Component: ComponentType<PluginComposerPillProps>;
  onPress(): void | Promise<void>;
}

export interface PluginClientOpenPanelOptions extends PluginOpenPanelOptions {
  workspaceId: string;
  agentId?: string;
}

export interface PluginClientContext extends PluginCommandCapabilities {
  addComposerPill(contribution: PluginComposerPillContribution): PluginCleanup;
  openPanel(id: string, options: PluginClientOpenPanelOptions): void;
}

export type PluginClientContribution = (client: PluginClientContext) => PluginCleanup;

export type PluginWorkspacePanelContribution =
  | (PluginWorkspacePanelBase & {
      context: "workspace";
      Component: ComponentType<PluginWorkspacePanelProps>;
    })
  | (PluginWorkspacePanelBase & {
      context: "agent";
      Component: ComponentType<PluginAgentPanelProps>;
    });

export interface PluginSurfaceContribution {
  id: string;
  Component: ComponentType<PluginSurfaceProps>;
}

export interface PluginSidebarBadgeContribution {
  /** RPC returning `{ count }`. Called with an empty input object. */
  rpc: PluginRpcContract;
  /** Poll interval. Defaults to 60s; the host floors it at 15s. */
  intervalMs?: number;
}

export interface PluginSidebarContribution {
  id: string;
  title: string;
  icon: string;
  surface: string;
  badge?: PluginSidebarBadgeContribution;
}

export interface PluginThemeColors {
  background: string;
  foreground: string;
  raised: string;
  control: string;
  border: string;
  accent?: string;
  mutedForeground: string;
  ring: string;
}

export interface PluginThemeContribution {
  id: string;
  name: string;
  appearance: "light" | "dark";
  colors: PluginThemeColors;
}

export interface PluginAttachmentSourceContribution {
  id: string;
  title: string;
  icon: string;
  pickerTitle: string;
  searchPlaceholder: string;
  search: PluginRpcContract;
}

export type PluginTimelineData =
  | null
  | boolean
  | number
  | string
  | PluginTimelineData[]
  | { [key: string]: PluginTimelineData };

export interface PluginTimelineItem {
  type: "plugin";
  kind: string;
  version: number;
  data: PluginTimelineData;
}

export interface PluginTimelineTransformResult {
  items: PluginTimelineItem[];
}

export type PluginTimelineTransformerContribution<
  ItemType extends AgentTimelineItem["type"] = AgentTimelineItem["type"],
> = ItemType extends AgentTimelineItem["type"]
  ? {
      id: string;
      query: {
        itemType: ItemType;
      };
      transform(input: {
        item: Extract<AgentTimelineItem, { type: ItemType }>;
      }): PluginTimelineTransformResult | undefined;
    }
  : never;

export interface PluginTimelineItemProps<Data = unknown> extends PluginHostProps {
  agentId: string;
  item: {
    type: "plugin";
    kind: string;
    version: number;
    data: Data;
  };
  timestamp: Date;
}

export interface PluginTimelineRendererContribution<Schema extends ZodType = ZodType> {
  kind: string;
  version: number;
  schema: Schema;
  Component: ComponentType<PluginTimelineItemProps<ZodOutput<Schema>>>;
}

export interface PluginCommandCapabilities {
  paseo: PaseoApi;
  rpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    input: ZodInput<InputSchema>,
  ): Promise<ZodOutput<OutputSchema>>;
  openSurface(id: string): void;
  openWorkspace(workspaceId: string, options?: PluginOpenWorkspaceOptions): void;
  openExternal(url: string): Promise<void>;
}

export interface PluginGlobalCommandContext extends PluginCommandCapabilities {
  context: "global";
}

export interface PluginWorkspaceCommandContext extends PluginCommandCapabilities {
  context: "workspace";
  workspace: PluginWorkspaceSnapshot;
  openPanel(id: string, options?: PluginOpenPanelOptions): void;
}

export interface PluginAgentCommandContext extends PluginCommandCapabilities {
  context: "agent";
  workspace: PluginWorkspaceSnapshot;
  agent: PluginAgentSnapshot;
  openPanel(id: string, options?: PluginOpenPanelOptions): void;
}

interface PluginCommandCenterItemBase {
  id: string;
  title: string;
  icon: string;
  keywords?: readonly string[];
}

export type PluginCommandCenterItemContribution =
  | (PluginCommandCenterItemBase & {
      context: "global";
      onSelect(context: PluginGlobalCommandContext): void | Promise<void>;
    })
  | (PluginCommandCenterItemBase & {
      context: "workspace";
      onSelect(context: PluginWorkspaceCommandContext): void | Promise<void>;
    })
  | (PluginCommandCenterItemBase & {
      context: "agent";
      onSelect(context: PluginAgentCommandContext): void | Promise<void>;
    });

export interface PluginHandlerContext {
  paseo: PaseoApi;
}

export interface PluginContext {
  handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    handler: (
      input: ZodOutput<InputSchema>,
      context: PluginHandlerContext,
    ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
  ): void;
  addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): void;
  addSidebarItem(contribution: PluginSidebarContribution): void;
  addWorkspacePanel(contribution: PluginWorkspacePanelContribution): void;
  addCommandCenterItem(contribution: PluginCommandCenterItemContribution): void;
  addClientSide(contribution: PluginClientContribution): void;
  addAttachmentSource(contribution: PluginAttachmentSourceContribution): void;
  addTheme(contribution: PluginThemeContribution): void;
  addTimelineTransformer<ItemType extends AgentTimelineItem["type"]>(
    contribution: PluginTimelineTransformerContribution<ItemType>,
  ): void;
  addTimelineRenderer<Schema extends ZodType>(
    contribution: PluginTimelineRendererContribution<Schema>,
  ): void;
}

export type PluginCleanup = () => void | Promise<void>;

export type PluginContribution = (plugin: PluginContext) => PluginCleanup;
