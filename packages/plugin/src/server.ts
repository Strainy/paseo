import type { PluginAttachmentSourceContribution } from "./contracts.js";

export { PluginSidebarBadgeSchema, type PluginSidebarBadge } from "./badges.js";
export {
  PluginAttachmentItemSchema,
  PluginAttachmentSearchPayloadSchema,
  type PluginAttachmentItem,
  type PluginAttachmentSearchPayload,
} from "./attachments.js";
export type {
  PluginAttachmentSourceContribution,
  PluginHandlerContext,
  PluginSidebarBadgeContribution,
} from "./contracts.js";
export {
  PluginNotificationEventSchema,
  PluginNotificationPollResultSchema,
  PluginNotificationSchema,
  type PluginNotification,
  type PluginNotificationEvent,
  type PluginNotificationPollResult,
} from "./notifications.js";
export type { PluginNotificationSourceContribution } from "./contracts.js";
export { defineRpc, type PluginRpcContract } from "./rpc.js";

export function defineAttachmentSource<Definition extends PluginAttachmentSourceContribution>(
  definition: Definition,
): Definition {
  return definition;
}
