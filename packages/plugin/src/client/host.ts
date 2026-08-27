import { PluginAttachmentSearchPayloadSchema } from "../attachments.js";
import { PluginSidebarBadgeSchema, resolvePluginSidebarBadgeInterval } from "../badges.js";
export { PluginClientStateProvider, type PluginClientStateSource } from "./client-state.js";
export {
  usePluginRuntimeContextBridge,
  type PluginRuntimeContextBridge,
} from "./runtime-context-bridge.js";
import type {
  PluginAttachmentSourceContribution,
  PluginNotificationSourceContribution,
  PluginSidebarBadgeContribution,
} from "../contracts.js";
import { PluginRpcProvider } from "./rpc-context.js";
import { PaseoApiProvider } from "./paseo-context.js";
import { callPluginRpc } from "../rpc.js";
import {
  PluginNotificationPollResultSchema,
  resolvePluginNotificationInterval,
  type PluginNotificationPollResult,
} from "../notifications.js";

export async function readPluginSidebarBadge(
  contribution: { badge?: PluginSidebarBadgeContribution },
  invoke: (method: string, input: unknown) => Promise<unknown>,
) {
  if (!contribution.badge) return null;
  const output = await callPluginRpc(contribution.badge.rpc, invoke, {});
  return PluginSidebarBadgeSchema.parseAsync(output);
}

export async function searchPluginAttachments(
  source: PluginAttachmentSourceContribution,
  invoke: (method: string, input: unknown) => Promise<unknown>,
  query: string,
) {
  const output = await callPluginRpc(source.search, invoke, { query });
  return PluginAttachmentSearchPayloadSchema.parseAsync(output);
}

export async function readPluginNotificationSource(
  source: PluginNotificationSourceContribution,
  invoke: (method: string, input: unknown) => Promise<unknown>,
): Promise<PluginNotificationPollResult> {
  const output = await callPluginRpc(source.rpc, invoke, {});
  return PluginNotificationPollResultSchema.parseAsync(output);
}

export {
  callPluginRpc,
  resolvePluginNotificationInterval,
  resolvePluginSidebarBadgeInterval,
  PaseoApiProvider,
  PluginRpcProvider,
};
export { PluginNavigationProvider } from "../navigation-context.js";
export { PluginProjectProvider } from "../project-context.js";
