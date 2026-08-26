// Shared SDK entry. Keep runtime-specific imports and re-exports on /client or /server.
export { PluginSidebarBadgeSchema, type PluginSidebarBadge } from "./badges.js";
export type {
  PluginNavigation,
  PluginOpenWorkspaceOptions,
  PluginProjectPlacementSnapshot,
  PluginProjectSnapshot,
  PluginTheme,
  PluginWorkspaceSnapshot,
  PluginAgentSnapshot,
  PluginSidebarBadgeContribution,
  PluginThemeColors,
  PluginThemeContribution,
  PluginAttachmentSourceContribution,
  PluginTimelineData,
  PluginTimelineItem,
  PluginTimelineTransformResult,
  PluginCleanup,
} from "./contracts.js";
export { defineSettings, settingsRpc, type SettingsDefinition } from "./settings.js";
export {
  defineAttachmentSource,
  PluginAttachmentItemSchema,
  PluginAttachmentSearchPayloadSchema,
  type PluginAttachmentItem,
  type PluginAttachmentSearchPayload,
} from "./attachments.js";
export { defineRpc, type PluginRpcContract, type RpcInput, type RpcOutput } from "./rpc.js";
