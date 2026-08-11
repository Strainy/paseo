import type { z } from "zod";
import type { Logger } from "pino";
import type { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import type {
  AgentManager,
  ManagedAgent,
  ManagedImportableSessionPager,
  ManagedImportableProviderSession,
} from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import type { AgentPersistenceHandle, AgentProvider } from "./agent-sdk-types.js";
import { ensureAgentLoaded, type AgentLoaderManager } from "./agent-loading.js";
import { unarchiveAgentState } from "./agent-prompt.js";
import { toRecentProviderSessionDescriptorPayload } from "./agent-projections.js";
import type { WorkspaceProvisioningService } from "../session/workspace-provisioning/workspace-provisioning-service.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import type {
  FetchRecentProviderSessionsRequestMessage,
  ImportAgentRequestMessageSchema,
  RecentProviderSessionDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { getParentAgentIdFromLabels, PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { createRealpathAwarePathMatcher, normalizePathForIdentity } from "../../utils/path.js";
import type { ProjectImportScope, ProjectImportScopeResolver } from "../project-import-scope.js";
import pLimit from "p-limit";

type ImportAgentRequestMessage = z.infer<typeof ImportAgentRequestMessageSchema>;

const METADATA_GENERATION_PROMPT_PREFIX =
  "Generate metadata for a coding agent based on the user prompt.";
const IMPORT_SESSION_CURSOR_VERSION = 2;
const IMPORT_SESSION_CURSOR_MAX_LENGTH = 8_192;
const MAX_PAGE_SCAN_ROWS = 500;
const MAX_PAGE_SCAN_REQUESTS = 100;
const IMPORT_SESSION_CWD_FANOUT_CONCURRENCY = 4;
const importSessionCwdFanoutLimits = new WeakMap<object, ReturnType<typeof pLimit>>();
export type ImportSessionAgentManager = AgentLoaderManager &
  Pick<
    AgentManager,
    | "archiveSnapshot"
    | "closeAgent"
    | "getTimeline"
    | "importProviderSession"
    | "notifyAgentState"
    | "unarchiveSnapshot"
  >;

const providerSessionImportMutations = new WeakMap<
  ImportSessionAgentManager,
  Map<string, Promise<unknown>>
>();

export interface NormalizedImportAgentRequest {
  provider: AgentProvider;
  providerHandleId: string;
  cwd?: string;
  workspaceId?: string;
  projectId?: string;
  labels?: Record<string, string>;
  requestId: string;
}

export class ImportSessionsRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImportSessionsRequestError";
  }
}

export interface ListImportableProviderSessionsInput {
  request: FetchRecentProviderSessionsRequestMessage;
  agentManager: Pick<AgentManager, "listAgents" | "listImportableSessions"> &
    Partial<Pick<AgentManager, "openImportableSessionPager">>;
  agentStorage: Pick<AgentStorage, "list">;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "getProviderLabel">;
  projectImportScopeResolver?: ProjectImportScopeResolver;
}

export interface ListImportableProviderSessionsResult {
  entries: RecentProviderSessionDescriptorPayload[];
  filteredAlreadyImportedCount: number;
  nextCursor?: string | null;
}

export interface ImportProviderSessionInput {
  request: NormalizedImportAgentRequest;
  workspaceProvisioning: Pick<WorkspaceProvisioningService, "runInImportWorkspace">;
  agentManager: ImportSessionAgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}

export interface ImportProviderSessionResult {
  snapshot: ManagedAgent;
  timelineSize: number;
  createdWorkspace: PersistedWorkspaceRecord | null;
}

interface ImportedProviderSession {
  snapshot: ManagedAgent;
  timelineSize: number;
}

// COMPAT(import-agent-request-v1): accept legacy {provider, sessionId} shape
// alongside the new {providerId, providerHandleId} shape. Old clients
// (< target daemon floor) send the legacy fields. Drop the fallbacks and the
// .optional() in messages.ts when the supported client floor is >= the daemon
// version that ships the new shape (target: 2026-11-08).
export function normalizeImportAgentRequest(
  msg: ImportAgentRequestMessage,
): NormalizedImportAgentRequest | { error: string } {
  const provider = msg.providerId ?? msg.provider;
  const providerHandleId = msg.providerHandleId ?? msg.sessionId;
  if (!provider || !providerHandleId) {
    return { error: "Import requires providerId and providerHandleId" };
  }
  if (msg.workspaceId !== undefined && msg.projectId !== undefined) {
    return { error: "Import cannot target both a workspace and a project" };
  }
  return {
    provider: provider as AgentProvider,
    providerHandleId,
    cwd: msg.cwd,
    workspaceId: msg.workspaceId,
    projectId: msg.projectId,
    labels: msg.labels,
    requestId: msg.requestId,
  };
}

export async function listImportableProviderSessions(
  input: ListImportableProviderSessionsInput,
): Promise<ListImportableProviderSessionsResult> {
  const { request, agentManager, agentStorage, providerSnapshotManager } = input;
  const requestCwd = request.cwd;
  const requestProjectId = request.projectId;
  if (requestCwd !== undefined && requestProjectId !== undefined) {
    throw new ImportSessionsRequestError(
      "invalid_scope",
      "Recent provider sessions cannot target both a cwd and a project",
    );
  }
  const projectScope =
    requestProjectId !== undefined
      ? await requireProjectImportScopeResolver(input).resolve(requestProjectId, {
          reason: "list-provider-sessions",
        })
      : null;
  const limit = request.limit ?? 20;
  const sinceTimestamp = parseRecentProviderSessionsSince(request.since);
  const providerFilter = request.providers ? new Set(request.providers) : undefined;
  const pageProvider = request.providers?.length === 1 ? request.providers[0] : undefined;
  if (request.cursor && !pageProvider) {
    throw invalidImportSessionCursor("Pagination requires exactly one provider");
  }
  const importedSessions = await collectImportedProviderSessions(
    agentManager,
    agentStorage,
    providerFilter,
  );
  const importedHandles = importedSessions.handles;
  const matchesRequestCwd = resolveImportSessionCwdMatcher(requestCwd, projectScope);

  if (pageProvider && agentManager.openImportableSessionPager) {
    const cursorIdentity = buildImportSessionCursorIdentity({
      provider: pageProvider,
      cwd: requestCwd,
      projectId: requestProjectId,
      sinceTimestamp,
    });
    const nativeCursor = request.cursor
      ? decodeImportSessionCursor(request.cursor, cursorIdentity)
      : undefined;
    const pager = await agentManager.openImportableSessionPager(pageProvider, {
      cursor: nativeCursor,
    });
    if (pager) {
      return await listImportableProviderSessionPage({
        pager,
        provider: pageProvider,
        initialNativeCursor: nativeCursor,
        limit,
        sinceTimestamp,
        importedHandles,
        matchesRequestCwd,
        cursorIdentity,
        providerSnapshotManager,
      });
    }
    if (request.cursor) {
      throw invalidImportSessionCursor(`Provider '${pageProvider}' does not support pagination`);
    }
  } else if (request.cursor) {
    throw invalidImportSessionCursor("The provider does not support pagination");
  }

  const sessions = projectScope
    ? await listImportableSessionsForProjectScope({
        projectScope,
        agentManager,
        limit: limit + importedSessions.count,
        providerFilter,
      })
    : await agentManager.listImportableSessions({
        limit: limit + importedSessions.count,
        providerFilter,
        cwd: requestCwd,
      });
  const candidates: ManagedImportableProviderSession[] = [];
  const filteredAlreadyImportedCount = await appendVisibleImportableSessions({
    sessions,
    candidates,
    matchesRequestCwd,
    sinceTimestamp,
    importedHandles,
  });
  const entries = projectImportableSessions(candidates, limit, providerSnapshotManager);

  return { entries, filteredAlreadyImportedCount };
}

export async function importProviderSession(
  input: ImportProviderSessionInput,
): Promise<ImportProviderSessionResult> {
  const cwd = input.request.cwd;
  if (!cwd) {
    throw new Error("Import requires cwd from the selected provider session");
  }
  const key = await resolveProviderSessionImportMutationKey(input);
  return serializeProviderSessionImport(input.agentManager, key, async () => {
    const placement = await input.workspaceProvisioning.runInImportWorkspace(
      {
        cwd,
        requestedWorkspaceId: input.request.workspaceId,
        requestedProjectId: input.request.projectId,
      },
      (workspace) => importProviderSessionNow(input, cwd, workspace.workspaceId),
    );
    return { ...placement.value, createdWorkspace: placement.createdWorkspace };
  });
}

async function importProviderSessionNow(
  input: ImportProviderSessionInput,
  cwd: string,
  workspaceId: string,
): Promise<ImportedProviderSession> {
  const { provider, providerHandleId, labels } = input.request;

  const matchingRecords = await input.agentStorage.listByProviderSession(
    provider,
    providerHandleId,
  );
  const activeRecord = matchingRecords.find((record) => !record.archivedAt);
  if (activeRecord) {
    throw new Error(`Provider session is already imported: ${providerHandleId}`);
  }
  const archivedRecord = matchingRecords.find((record) => record.archivedAt);
  if (archivedRecord?.persistence && archivedRecord.archivedAt) {
    if (!createRealpathAwarePathMatcher(cwd)(archivedRecord.cwd)) {
      throw new Error(`Provider session cwd does not match import cwd: ${providerHandleId}`);
    }
    const requestedParentAgentId = getParentAgentIdFromLabels(input.request.labels);
    const labelPatch: Record<string, string | null> = { ...input.request.labels };
    if (
      Object.hasOwn(archivedRecord.labels, PARENT_AGENT_ID_LABEL) ||
      Object.hasOwn(input.request.labels ?? {}, PARENT_AGENT_ID_LABEL)
    ) {
      labelPatch[PARENT_AGENT_ID_LABEL] = requestedParentAgentId;
    }
    await unarchiveAgentState(input.agentStorage, input.agentManager, archivedRecord.id, {
      workspaceId,
      labels: Object.keys(labelPatch).length > 0 ? labelPatch : undefined,
    });
    try {
      const snapshot = await ensureAgentLoaded(archivedRecord.id, {
        agentManager: input.agentManager,
        agentStorage: input.agentStorage,
        logger: input.logger,
      });
      return {
        snapshot,
        timelineSize: input.agentManager.getTimeline(snapshot.id).length,
      };
    } catch (error) {
      await rollbackArchivedImport(input, archivedRecord, archivedRecord.archivedAt);
      throw error;
    }
  }

  const snapshot = await input.agentManager.importProviderSession({
    provider,
    providerHandleId,
    cwd,
    workspaceId,
    labels,
  });
  await unarchiveAgentState(input.agentStorage, input.agentManager, snapshot.id);

  return {
    snapshot,
    timelineSize: input.agentManager.getTimeline(snapshot.id).length,
  };
}

async function serializeProviderSessionImport<T>(
  agentManager: ImportSessionAgentManager,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  let mutations = providerSessionImportMutations.get(agentManager);
  if (!mutations) {
    mutations = new Map();
    providerSessionImportMutations.set(agentManager, mutations);
  }

  const previous = mutations.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  mutations.set(key, next);
  try {
    return await next;
  } finally {
    if (mutations.get(key) === next) {
      mutations.delete(key);
    }
  }
}

async function resolveProviderSessionImportMutationKey(
  input: ImportProviderSessionInput,
): Promise<string> {
  const matchingRecord = (
    await input.agentStorage.listByProviderSession(
      input.request.provider,
      input.request.providerHandleId,
    )
  ).at(0);
  return matchingRecord
    ? `agent\0${matchingRecord.id}`
    : `handle\0${toProviderSessionHandleKey(
        input.request.provider,
        input.request.providerHandleId,
      )}`;
}

async function rollbackArchivedImport(
  input: ImportProviderSessionInput,
  archivedRecord: StoredAgentRecord,
  archivedAt: string,
): Promise<void> {
  try {
    if (input.agentManager.getAgent(archivedRecord.id)) {
      await input.agentManager.closeAgent(archivedRecord.id);
    }
    await input.agentManager.archiveSnapshot(archivedRecord.id, archivedAt);
  } catch (error) {
    input.logger.error(
      { err: error, agentId: archivedRecord.id },
      "Failed to re-archive provider session after import failure",
    );
  }

  try {
    await input.agentStorage.upsert(archivedRecord);
  } catch (error) {
    input.logger.error(
      { err: error, agentId: archivedRecord.id },
      "Failed to restore archived agent record after import failure",
    );
  }
}

type ImportSessionCursorScopeIdentity =
  | { kind: "global" }
  | { kind: "cwd"; cwd: string }
  | { kind: "project"; projectId: string };

interface ImportSessionCursorIdentity {
  provider: string;
  scope: ImportSessionCursorScopeIdentity;
  sinceTimestamp: number | null;
}

interface ImportSessionCursorPayload {
  v: typeof IMPORT_SESSION_CURSOR_VERSION;
  provider: string;
  scope: ImportSessionCursorScopeIdentity;
  since: number | null;
  cursor: string;
}

interface LegacyImportSessionCursorPayload {
  v: 1;
  provider: string;
  cwd: string | null;
  since: number | null;
  cursor: string;
}

type ImportSessionCwdMatcher = ((candidate: string) => Promise<boolean>) | null;

async function listImportableProviderSessionPage(input: {
  pager: ManagedImportableSessionPager;
  provider: string;
  initialNativeCursor: string | undefined;
  limit: number;
  sinceTimestamp: number | null;
  importedHandles: Set<string>;
  matchesRequestCwd: ImportSessionCwdMatcher;
  cursorIdentity: ImportSessionCursorIdentity;
  providerSnapshotManager: ListImportableProviderSessionsInput["providerSnapshotManager"];
}): Promise<ListImportableProviderSessionsResult> {
  const candidates: ManagedImportableProviderSession[] = [];
  let filteredAlreadyImportedCount = 0;
  let scanRowsRemaining = MAX_PAGE_SCAN_ROWS;
  let scanRequestsRemaining = MAX_PAGE_SCAN_REQUESTS;
  let nativeCursor: string | null = input.initialNativeCursor ?? null;
  const seenCursors = new Set<string>();
  if (input.initialNativeCursor) seenCursors.add(input.initialNativeCursor);

  try {
    while (candidates.length < input.limit && scanRowsRemaining > 0 && scanRequestsRemaining > 0) {
      const pageLimit = Math.min(input.limit - candidates.length, scanRowsRemaining);
      const page = await input.pager.next(pageLimit);
      scanRequestsRemaining -= 1;
      if (page.sessions.length > pageLimit) {
        throw new Error(
          `Provider '${input.provider}' returned more importable sessions than requested`,
        );
      }
      scanRowsRemaining -= page.sessions.length;
      filteredAlreadyImportedCount += await appendVisibleImportableSessions({
        sessions: page.sessions,
        candidates,
        matchesRequestCwd: input.matchesRequestCwd,
        sinceTimestamp: input.sinceTimestamp,
        importedHandles: input.importedHandles,
      });

      nativeCursor = page.nextCursor;
      if (nativeCursor === null) break;
      if (seenCursors.has(nativeCursor)) {
        throw new Error(`Provider '${input.provider}' returned a repeated import session cursor`);
      }
      seenCursors.add(nativeCursor);
    }
  } finally {
    await input.pager.close();
  }

  return {
    entries: projectImportableSessions(candidates, input.limit, input.providerSnapshotManager),
    filteredAlreadyImportedCount,
    nextCursor:
      nativeCursor === null ? null : encodeImportSessionCursor(nativeCursor, input.cursorIdentity),
  };
}

async function appendVisibleImportableSessions(input: {
  sessions: ManagedImportableProviderSession[];
  candidates: ManagedImportableProviderSession[];
  matchesRequestCwd: ImportSessionCwdMatcher;
  sinceTimestamp: number | null;
  importedHandles: Set<string>;
}): Promise<number> {
  let filteredAlreadyImportedCount = 0;
  for (const session of input.sessions) {
    if (input.matchesRequestCwd && !(await input.matchesRequestCwd(session.cwd))) continue;
    if (input.sinceTimestamp !== null && session.lastActivityAt.getTime() < input.sinceTimestamp) {
      continue;
    }
    if (isMetadataGenerationSession(session)) continue;
    if (
      input.importedHandles.has(
        toProviderSessionHandleKey(session.provider, session.providerHandleId),
      )
    ) {
      filteredAlreadyImportedCount += 1;
      continue;
    }
    input.candidates.push(session);
  }
  return filteredAlreadyImportedCount;
}

function projectImportableSessions(
  candidates: ManagedImportableProviderSession[],
  limit: number,
  providerSnapshotManager: ListImportableProviderSessionsInput["providerSnapshotManager"],
): RecentProviderSessionDescriptorPayload[] {
  return candidates
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
    .slice(0, limit)
    .map((descriptor) =>
      toRecentProviderSessionDescriptorPayload(descriptor, {
        providerLabel: providerSnapshotManager.getProviderLabel(descriptor.provider),
      }),
    );
}

function encodeImportSessionCursor(
  nativeCursor: string,
  identity: ImportSessionCursorIdentity,
): string {
  const payload: ImportSessionCursorPayload = {
    v: IMPORT_SESSION_CURSOR_VERSION,
    provider: identity.provider,
    scope: identity.scope,
    since: identity.sinceTimestamp,
    cursor: nativeCursor,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  if (encoded.length > IMPORT_SESSION_CURSOR_MAX_LENGTH) {
    throw new Error("Import session continuation cursor exceeds the maximum length");
  }
  return encoded;
}

function decodeImportSessionCursor(encoded: string, identity: ImportSessionCursorIdentity): string {
  if (encoded.length > IMPORT_SESSION_CURSOR_MAX_LENGTH) {
    throw invalidImportSessionCursor("Cursor is too long");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw invalidImportSessionCursor();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidImportSessionCursor();
  }
  const cursorVersion = (parsed as { v?: unknown }).v;
  if (cursorVersion === 1) {
    return decodeLegacyImportSessionCursor(
      parsed as Partial<LegacyImportSessionCursorPayload>,
      identity,
    );
  }
  const payload = parsed as Partial<ImportSessionCursorPayload>;
  if (
    payload.v !== IMPORT_SESSION_CURSOR_VERSION ||
    payload.provider !== identity.provider ||
    !cursorScopesEqual(payload.scope, identity.scope) ||
    payload.since !== identity.sinceTimestamp ||
    typeof payload.cursor !== "string" ||
    payload.cursor.length === 0
  ) {
    throw invalidImportSessionCursor("Cursor does not match the current query");
  }
  return payload.cursor;
}

function decodeLegacyImportSessionCursor(
  payload: Partial<LegacyImportSessionCursorPayload>,
  identity: ImportSessionCursorIdentity,
): string {
  if (identity.scope.kind === "project") {
    throw invalidImportSessionCursor("Cursor does not match the current query");
  }
  const expectedCwd = identity.scope.kind === "cwd" ? identity.scope.cwd : null;
  if (
    payload.provider !== identity.provider ||
    payload.cwd !== expectedCwd ||
    payload.since !== identity.sinceTimestamp ||
    typeof payload.cursor !== "string" ||
    payload.cursor.length === 0
  ) {
    throw invalidImportSessionCursor("Cursor does not match the current query");
  }
  return payload.cursor;
}

function cursorScopesEqual(
  left: ImportSessionCursorScopeIdentity | undefined,
  right: ImportSessionCursorScopeIdentity,
): boolean {
  if (!left || left.kind !== right.kind) return false;
  switch (right.kind) {
    case "global":
      return true;
    case "cwd":
      return left.kind === "cwd" && left.cwd === right.cwd;
    case "project":
      return left.kind === "project" && left.projectId === right.projectId;
  }
}

function buildImportSessionCursorIdentity(input: {
  provider: string;
  cwd?: string;
  projectId?: string;
  sinceTimestamp: number | null;
}): ImportSessionCursorIdentity {
  let scope: ImportSessionCursorScopeIdentity = { kind: "global" };
  if (input.projectId !== undefined) {
    scope = { kind: "project", projectId: input.projectId };
  } else if (input.cwd !== undefined) {
    scope = { kind: "cwd", cwd: normalizePathForIdentity(input.cwd) };
  }
  return { provider: input.provider, scope, sinceTimestamp: input.sinceTimestamp };
}

function resolveImportSessionCwdMatcher(
  cwd: string | undefined,
  projectScope: ProjectImportScope | null,
): ImportSessionCwdMatcher {
  if (projectScope) return (candidate) => projectScope.matchesCwd(candidate);
  if (!cwd) return null;
  const matches = createRealpathAwarePathMatcher(cwd);
  return async (candidate) => matches(candidate);
}

function requireProjectImportScopeResolver(
  input: ListImportableProviderSessionsInput,
): ProjectImportScopeResolver {
  if (!input.projectImportScopeResolver) {
    throw new ImportSessionsRequestError(
      "project_scope_unavailable",
      "Project-scoped provider session import is unavailable",
    );
  }
  return input.projectImportScopeResolver;
}

async function listImportableSessionsForProjectScope(input: {
  projectScope: ProjectImportScope;
  agentManager: Pick<AgentManager, "listImportableSessions">;
  limit: number;
  providerFilter: Set<string> | undefined;
}): Promise<ManagedImportableProviderSession[]> {
  const limit = getImportSessionCwdFanoutLimit(input.agentManager);
  const lists = await Promise.all(
    input.projectScope.exactCwds.map((cwd) =>
      limit(() =>
        input.agentManager.listImportableSessions({
          limit: input.limit,
          providerFilter: input.providerFilter,
          cwd,
        }),
      ),
    ),
  );

  const sessionsByHandle = new Map<string, ManagedImportableProviderSession>();
  for (const session of lists.flat()) {
    // `cwd` is only a provider hint. Filter before deduplication so a newer
    // out-of-scope descriptor cannot displace the valid scoped descriptor for
    // the same native session handle.
    if (!(await input.projectScope.matchesCwd(session.cwd))) continue;
    const key = toProviderSessionHandleKey(session.provider, session.providerHandleId);
    const previous = sessionsByHandle.get(key);
    if (!previous || previous.lastActivityAt.getTime() < session.lastActivityAt.getTime()) {
      sessionsByHandle.set(key, session);
    }
  }
  return Array.from(sessionsByHandle.values()).sort(
    (left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime(),
  );
}

function getImportSessionCwdFanoutLimit(agentManager: object): ReturnType<typeof pLimit> {
  const existing = importSessionCwdFanoutLimits.get(agentManager);
  if (existing) return existing;
  const created = pLimit({ concurrency: IMPORT_SESSION_CWD_FANOUT_CONCURRENCY });
  importSessionCwdFanoutLimits.set(agentManager, created);
  return created;
}

function invalidImportSessionCursor(detail?: string): ImportSessionsRequestError {
  return new ImportSessionsRequestError(
    "invalid_cursor",
    detail
      ? `Invalid recent provider sessions cursor: ${detail}`
      : "Invalid recent provider sessions cursor",
  );
}

function parseRecentProviderSessionsSince(since: string | undefined): number | null {
  if (!since) {
    return null;
  }
  const timestamp = Date.parse(since);
  if (Number.isNaN(timestamp)) {
    throw new ImportSessionsRequestError("invalid_since", "Invalid recent provider sessions since");
  }
  return timestamp;
}

async function collectImportedProviderSessions(
  agentManager: Pick<AgentManager, "listAgents">,
  agentStorage: Pick<AgentStorage, "list">,
  providerFilter: Set<string> | undefined,
): Promise<{ handles: Set<string>; count: number }> {
  const handles = new Set<string>();
  const sessions = new Set<string>();
  const records = await agentStorage.list();
  const storedRecordsById = new Map(records.map((record) => [record.id, record]));

  const collect = (
    provider: AgentProvider | StoredAgentRecord["provider"] | string,
    persistence: AgentPersistenceHandle | null | undefined,
  ) => {
    if (!persistence || (providerFilter && !providerFilter.has(provider))) return;
    sessions.add(toProviderSessionHandleKey(provider, persistence.sessionId));
    collectProviderSessionHandleKeys(handles, provider, persistence);
  };

  for (const agent of agentManager.listAgents()) {
    if (storedRecordsById.get(agent.id)?.archivedAt) {
      continue;
    }
    collect(agent.provider, agent.persistence);
  }

  for (const record of records) {
    if (record.archivedAt) {
      continue;
    }
    collect(record.provider, record.persistence);
  }

  return { handles, count: sessions.size };
}

function toProviderSessionHandleKey(provider: string, providerHandleId: string): string {
  return `${provider}\0${providerHandleId}`;
}

function isMetadataGenerationSession(input: { firstPromptPreview: string | null }): boolean {
  return (
    input.firstPromptPreview?.trimStart().startsWith(METADATA_GENERATION_PROMPT_PREFIX) ?? false
  );
}

function collectProviderSessionHandleKeys(
  target: Set<string>,
  provider: AgentProvider | StoredAgentRecord["provider"] | string,
  persistence: AgentPersistenceHandle | null | undefined,
): void {
  if (!persistence) {
    return;
  }

  target.add(toProviderSessionHandleKey(provider, persistence.sessionId));
  if (persistence.nativeHandle) {
    target.add(toProviderSessionHandleKey(provider, persistence.nativeHandle));
  }
}
