import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentManager,
  ManagedAgent,
  ManagedImportableSessionPager,
  ManagedImportableProviderSession,
} from "./agent-manager.js";
import { AgentStorage, type StoredAgentRecord } from "./agent-storage.js";
import type { FetchRecentProviderSessionsRequestMessage } from "@getpaseo/protocol/messages";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { createPersistedWorkspaceRecord } from "../workspace-registry.js";
import type { WorkspaceProvisioningService } from "../session/workspace-provisioning/workspace-provisioning-service.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  type ImportSessionAgentManager,
  ImportSessionsRequestError,
  importProviderSession,
  listImportableProviderSessions,
  normalizeImportAgentRequest,
} from "./import-sessions.js";
import type { ProjectImportScopeResolver } from "../project-import-scope.js";
import { createRealpathAwarePathMatcher, normalizePathForIdentity } from "../../utils/path.js";

const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";
const importTestDirectories: string[] = [];

const TEST_CAPABILITIES = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const directory of importTestDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeImportableSession(args: {
  provider?: string;
  sessionId: string;
  nativeHandle?: string;
  cwd?: string;
  title?: string | null;
  lastActivityAt: string;
  firstPrompt?: string;
  lastPrompt?: string;
}): ManagedImportableProviderSession {
  const provider = args.provider ?? "codex";
  const cwd = args.cwd ?? "/tmp/project";
  return {
    provider,
    providerHandleId: args.nativeHandle ?? args.sessionId,
    cwd,
    title: args.title ?? null,
    lastActivityAt: new Date(args.lastActivityAt),
    firstPromptPreview: args.firstPrompt ?? null,
    lastPromptPreview: args.lastPrompt ?? args.firstPrompt ?? null,
  };
}

function makeManagedAgent(args: {
  id?: string;
  provider?: string;
  cwd: string;
  sessionId: string;
  nativeHandle?: string;
  title?: string | null;
}): ManagedAgent {
  const provider = args.provider ?? "codex";
  return {
    id: args.id ?? "00000000-0000-4000-8000-000000000632",
    provider,
    cwd: args.cwd,
    capabilities: TEST_CAPABILITIES,
    config: { provider, cwd: args.cwd, title: args.title },
    createdAt: new Date("2026-04-30T00:00:00.000Z"),
    updatedAt: new Date("2026-04-30T00:00:00.000Z"),
    availableModes: [],
    currentModeId: null,
    pendingPermissions: new Map(),
    bufferedPermissionResolutions: new Map(),
    inFlightPermissionResponses: new Set(),
    pendingReplacement: false,
    persistence: {
      provider,
      sessionId: args.sessionId,
      ...(args.nativeHandle ? { nativeHandle: args.nativeHandle } : {}),
      metadata: { provider, cwd: args.cwd },
    },
    historyPrimed: true,
    lastUserMessageAt: null,
    attention: { requiresAttention: false },
    foregroundTurnWaiters: new Set(),
    finalizedForegroundTurnIds: new Set(),
    unsubscribeSession: null,
    internal: false,
    labels: {},
    lifecycle: "closed",
    session: null,
    activeForegroundTurnId: null,
  } satisfies ManagedAgent;
}

function createImportWorkspace(
  workspaceId: string,
): Pick<WorkspaceProvisioningService, "runInImportWorkspace"> {
  return {
    async runInImportWorkspace(input, operation) {
      const workspace = createPersistedWorkspaceRecord({
        workspaceId,
        projectId: `project-${workspaceId}`,
        cwd: input.cwd,
        kind: "directory",
        displayName: "imported",
        createdAt: "2026-04-30T00:00:00.000Z",
        updatedAt: "2026-04-30T00:00:00.000Z",
      });
      return {
        value: await operation(workspace),
        createdWorkspace: null,
      };
    },
  };
}

function makeRequest(
  overrides: Partial<FetchRecentProviderSessionsRequestMessage> = {},
): FetchRecentProviderSessionsRequestMessage {
  return {
    type: "fetch_recent_provider_sessions_request",
    requestId: "recent-provider-sessions",
    ...overrides,
  };
}

test("listImportableProviderSessions filters, sorts, limits, and projects importable sessions", async () => {
  const cwd = "/tmp/project";
  const sessions = [
    makeImportableSession({
      sessionId: "outside-cwd",
      nativeHandle: "outside-cwd-handle",
      cwd: "/tmp/elsewhere",
      title: "Outside cwd",
      lastActivityAt: "2026-04-30T12:05:00.000Z",
    }),
    makeImportableSession({
      sessionId: "stored-session",
      nativeHandle: "stored-handle",
      cwd,
      title: "Already stored",
      lastActivityAt: "2026-04-30T12:04:00.000Z",
      firstPrompt: "stored prompt",
    }),
    makeImportableSession({
      sessionId: "older-session",
      nativeHandle: "older-handle",
      cwd,
      title: "Older than since",
      lastActivityAt: "2026-04-29T23:59:59.000Z",
    }),
    makeImportableSession({
      sessionId: "newer-session",
      nativeHandle: "newer-handle",
      cwd,
      title: "Newer import",
      lastActivityAt: "2026-04-30T12:02:00.000Z",
      firstPrompt: "newer first prompt",
      lastPrompt: "newer last prompt",
    }),
    makeImportableSession({
      sessionId: "second-session",
      nativeHandle: "second-handle",
      cwd,
      title: "Second import",
      lastActivityAt: "2026-04-30T12:00:00.000Z",
      firstPrompt: "second prompt",
    }),
    makeImportableSession({
      sessionId: "third-session",
      nativeHandle: "third-handle",
      cwd,
      title: "Third import",
      lastActivityAt: "2026-04-30T11:59:00.000Z",
      firstPrompt: "third prompt",
    }),
    makeImportableSession({
      sessionId: "live-session",
      nativeHandle: "live-handle",
      cwd,
      title: "Already live",
      lastActivityAt: "2026-04-30T12:01:00.000Z",
      firstPrompt: "live prompt",
    }),
  ];
  const listImportableSessions = vi.fn(async () => sessions);
  const agentManager = {
    listAgents: () =>
      [
        {
          provider: "codex",
          persistence: {
            provider: "codex",
            sessionId: "live-session",
            nativeHandle: "live-handle",
          },
        },
      ] as ManagedAgent[],
    listImportableSessions,
  } satisfies Pick<AgentManager, "listAgents" | "listImportableSessions">;
  const agentStorage = {
    list: async () => [
      {
        provider: "codex",
        persistence: {
          provider: "codex",
          sessionId: "stored-session",
          nativeHandle: "stored-handle",
        },
      } as StoredAgentRecord,
    ],
  } satisfies Pick<AgentStorage, "list">;

  const result = await listImportableProviderSessions({
    request: makeRequest({
      cwd,
      providers: ["codex"],
      since: "2026-04-30T00:00:00.000Z",
      limit: 2,
    }),
    agentManager,
    agentStorage,
    providerSnapshotManager: { getProviderLabel: () => "Codex" },
  });

  expect(listImportableSessions).toHaveBeenCalledWith({
    limit: 4,
    providerFilter: new Set(["codex"]),
    cwd,
  });
  expect(result).toEqual({
    filteredAlreadyImportedCount: 2,
    entries: [
      {
        providerId: "codex",
        providerLabel: "Codex",
        providerHandleId: "newer-handle",
        cwd,
        title: "Newer import",
        firstPromptPreview: "newer first prompt",
        lastPromptPreview: "newer last prompt",
        lastActivityAt: "2026-04-30T12:02:00.000Z",
      },
      {
        providerId: "codex",
        providerLabel: "Codex",
        providerHandleId: "second-handle",
        cwd,
        title: "Second import",
        firstPromptPreview: "second prompt",
        lastPromptPreview: "second prompt",
        lastActivityAt: "2026-04-30T12:00:00.000Z",
      },
    ],
  });
});

test("listImportableProviderSessions looks past already-imported rows to fill the requested limit", async () => {
  const cwd = "/tmp/project";
  const imported = makeImportableSession({
    provider: "claude",
    sessionId: "already-imported",
    cwd,
    lastActivityAt: "2026-04-30T12:02:00.000Z",
  });
  const available = makeImportableSession({
    provider: "claude",
    sessionId: "available",
    cwd,
    lastActivityAt: "2026-04-30T12:01:00.000Z",
  });
  const listImportableSessions = vi.fn(async (options?: { limit?: number }) =>
    [imported, available].slice(0, options?.limit),
  );

  const result = await listImportableProviderSessions({
    request: makeRequest({ cwd, providers: ["claude"], limit: 1 }),
    agentManager: {
      listAgents: () => [],
      listImportableSessions,
    },
    agentStorage: {
      list: async () => [
        {
          provider: "claude",
          persistence: { provider: "claude", sessionId: "already-imported" },
        } as StoredAgentRecord,
      ],
    },
    providerSnapshotManager: { getProviderLabel: () => "Claude Code" },
  });

  expect(listImportableSessions).toHaveBeenCalledWith({
    limit: 2,
    providerFilter: new Set(["claude"]),
    cwd,
  });
  expect(result.entries.map((entry) => entry.providerHandleId)).toEqual(["available"]);
  expect(result.filteredAlreadyImportedCount).toBe(1);
});

test("listImportableProviderSessions drains pageable provider rows through server-owned filters", async () => {
  const cwd = "/tmp/project";
  const openImportableSessionPager = vi.fn(
    async (
      _provider: string,
      options?: { cursor?: string },
    ): Promise<ManagedImportableSessionPager> => {
      const pages =
        options?.cursor === "native-page-4"
          ? [
              {
                sessions: [
                  makeImportableSession({
                    sessionId: "later",
                    cwd,
                    lastActivityAt: "2026-04-30T11:58:00.000Z",
                  }),
                ],
                nextCursor: null,
              },
            ]
          : [
              {
                sessions: [
                  makeImportableSession({
                    sessionId: "already-imported",
                    cwd,
                    lastActivityAt: "2026-04-30T12:02:00.000Z",
                  }),
                ],
                nextCursor: "native-page-2",
              },
              {
                sessions: [
                  makeImportableSession({
                    sessionId: "wrong-cwd",
                    cwd: "/tmp/elsewhere",
                    lastActivityAt: "2026-04-30T12:01:00.000Z",
                  }),
                ],
                nextCursor: "native-page-3",
              },
              {
                sessions: [
                  makeImportableSession({
                    sessionId: "available",
                    cwd,
                    lastActivityAt: "2026-04-30T12:00:00.000Z",
                  }),
                ],
                nextCursor: "native-page-4",
              },
            ];
      let pageIndex = 0;
      return {
        next: vi.fn(async () => pages[pageIndex++] ?? { sessions: [], nextCursor: null }),
        close: vi.fn(async () => {}),
      };
    },
  );
  const listImportableSessions = vi.fn(async () => []);
  const agentManager = {
    listAgents: () => [],
    listImportableSessions,
    openImportableSessionPager,
  } satisfies Pick<
    AgentManager,
    "listAgents" | "listImportableSessions" | "openImportableSessionPager"
  >;
  const agentStorage = {
    list: async () => [
      {
        provider: "codex",
        persistence: { provider: "codex", sessionId: "already-imported" },
      } as StoredAgentRecord,
    ],
  } satisfies Pick<AgentStorage, "list">;

  const first = await listImportableProviderSessions({
    request: makeRequest({ cwd, providers: ["codex"], limit: 1 }),
    agentManager,
    agentStorage,
    providerSnapshotManager: { getProviderLabel: () => "Codex" },
  });

  expect(first.entries.map((entry) => entry.providerHandleId)).toEqual(["available"]);
  expect(first.filteredAlreadyImportedCount).toBe(1);
  expect(first.nextCursor).toEqual(expect.any(String));
  expect(listImportableSessions).not.toHaveBeenCalled();
  expect(openImportableSessionPager).toHaveBeenNthCalledWith(1, "codex", { cursor: undefined });

  const second = await listImportableProviderSessions({
    request: makeRequest({
      cwd,
      providers: ["codex"],
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    }),
    agentManager,
    agentStorage,
    providerSnapshotManager: { getProviderLabel: () => "Codex" },
  });

  expect(second.entries.map((entry) => entry.providerHandleId)).toEqual(["later"]);
  expect(second.nextCursor).toBeNull();
  expect(openImportableSessionPager).toHaveBeenNthCalledWith(2, "codex", {
    cursor: "native-page-4",
  });
});

test("listImportableProviderSessions retains a continuation when its scan budget underfills a page", async () => {
  let index = 0;
  const next = vi.fn(async () => {
    index += 1;
    return {
      sessions: [],
      nextCursor: `native-page-${index + 1}`,
    };
  });

  const result = await listImportableProviderSessions({
    request: makeRequest({ cwd: "/tmp/project", providers: ["codex"], limit: 1 }),
    agentManager: {
      listAgents: () => [],
      listImportableSessions: async () => [],
      openImportableSessionPager: async () => ({ next, close: async () => {} }),
    },
    agentStorage: { list: async () => [] },
    providerSnapshotManager: { getProviderLabel: () => "Codex" },
  });

  expect(result.entries).toEqual([]);
  expect(result.nextCursor).toEqual(expect.any(String));
  expect(next).toHaveBeenCalledTimes(100);
});

test("listImportableProviderSessions does not turn pageable provider failures into exhaustion", async () => {
  const providerError = new Error("thread/list failed");
  await expect(
    listImportableProviderSessions({
      request: makeRequest({ providers: ["codex"], limit: 1 }),
      agentManager: {
        listAgents: () => [],
        listImportableSessions: vi.fn(async () => []),
        openImportableSessionPager: async () => {
          throw providerError;
        },
      },
      agentStorage: { list: async () => [] },
      providerSnapshotManager: { getProviderLabel: () => "Codex" },
    }),
  ).rejects.toBe(providerError);
});

test("listImportableProviderSessions rejects cursors reused with a different filter", async () => {
  const openImportableSessionPager = vi.fn(async () => ({
    next: async () => ({
      sessions: [
        makeImportableSession({
          sessionId: "first-page-session",
          cwd: "/tmp/project-a",
          lastActivityAt: "2026-04-30T12:00:00.000Z",
        }),
      ],
      nextCursor: "native-page-2",
    }),
    close: async () => {},
  }));
  const agentManager = {
    listAgents: () => [],
    listImportableSessions: async () => [],
    openImportableSessionPager,
  };
  const first = await listImportableProviderSessions({
    request: makeRequest({ cwd: "/tmp/project-a", providers: ["codex"], limit: 1 }),
    agentManager,
    agentStorage: { list: async () => [] },
    providerSnapshotManager: { getProviderLabel: () => "Codex" },
  });

  await expect(
    listImportableProviderSessions({
      request: makeRequest({
        cwd: "/tmp/project-b",
        providers: ["codex"],
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      }),
      agentManager,
      agentStorage: { list: async () => [] },
      providerSnapshotManager: { getProviderLabel: () => "Codex" },
    }),
  ).rejects.toMatchObject({ name: "ImportSessionsRequestError", code: "invalid_cursor" });
  expect(openImportableSessionPager).toHaveBeenCalledTimes(1);
});

test("listImportableProviderSessions drains pageable rows through an exact project scope", async () => {
  const mainCwd = "/tmp/lpu-monorepo";
  const worktreeCwd = "/home/user/.codex/worktrees/a227/lpu-monorepo";
  const resolver = exactProjectScopeResolver([mainCwd, worktreeCwd]);
  const openImportableSessionPager = vi.fn(async () => {
    let page = 0;
    return {
      next: async () => {
        page += 1;
        return page === 1
          ? {
              sessions: [
                makeImportableSession({
                  sessionId: "unrelated",
                  cwd: "/tmp/github",
                  lastActivityAt: "2026-04-30T12:01:00.000Z",
                }),
              ],
              nextCursor: "native-page-2",
            }
          : {
              sessions: [
                makeImportableSession({
                  sessionId: "linked",
                  cwd: worktreeCwd,
                  lastActivityAt: "2026-04-30T12:00:00.000Z",
                }),
              ],
              nextCursor: "native-page-3",
            };
      },
      close: async () => {},
    };
  });
  const agentManager = {
    listAgents: () => [],
    listImportableSessions: async () => [],
    openImportableSessionPager,
  };

  const first = await listImportableProviderSessions({
    request: makeRequest({ projectId: "lpu", providers: ["codex"], limit: 1 }),
    agentManager,
    agentStorage: { list: async () => [] },
    providerSnapshotManager: { getProviderLabel: () => "Codex" },
    projectImportScopeResolver: resolver,
  });

  expect(first.entries.map((entry) => entry.providerHandleId)).toEqual(["linked"]);
  expect(first.nextCursor).toEqual(expect.any(String));

  await expect(
    listImportableProviderSessions({
      request: makeRequest({
        projectId: "another-project",
        providers: ["codex"],
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      }),
      agentManager,
      agentStorage: { list: async () => [] },
      providerSnapshotManager: { getProviderLabel: () => "Codex" },
      projectImportScopeResolver: resolver,
    }),
  ).rejects.toMatchObject({ code: "invalid_cursor" });
  expect(openImportableSessionPager).toHaveBeenCalledTimes(1);
});

test("listImportableProviderSessions fans non-pageable providers out to every project cwd", async () => {
  const mainCwd = "/tmp/lpu-monorepo";
  const worktreeCwd = "/home/user/.codex/worktrees/a227/lpu-monorepo";
  const listImportableSessions = vi.fn(async (options?: { cwd?: string }) => {
    if (options?.cwd === mainCwd) {
      return [
        makeImportableSession({
          provider: "claude",
          sessionId: "main",
          cwd: mainCwd,
          lastActivityAt: "2026-04-30T12:00:00.000Z",
        }),
        makeImportableSession({
          provider: "claude",
          sessionId: "duplicate",
          cwd: mainCwd,
          lastActivityAt: "2026-04-30T11:59:00.000Z",
        }),
      ];
    }
    return [
      makeImportableSession({
        provider: "claude",
        sessionId: "worktree",
        cwd: worktreeCwd,
        lastActivityAt: "2026-04-30T12:01:00.000Z",
      }),
      makeImportableSession({
        provider: "claude",
        sessionId: "duplicate",
        cwd: "/tmp/unrelated",
        lastActivityAt: "2026-04-30T12:03:00.000Z",
      }),
      makeImportableSession({
        provider: "claude",
        sessionId: "provider-ignored-cwd",
        cwd: "/tmp/unrelated",
        lastActivityAt: "2026-04-30T12:02:00.000Z",
      }),
    ];
  });

  const result = await listImportableProviderSessions({
    request: makeRequest({ projectId: "lpu", providers: ["claude"], limit: 10 }),
    agentManager: { listAgents: () => [], listImportableSessions },
    agentStorage: { list: async () => [] },
    providerSnapshotManager: { getProviderLabel: () => "Claude" },
    projectImportScopeResolver: exactProjectScopeResolver([mainCwd, worktreeCwd]),
  });

  expect(listImportableSessions).toHaveBeenCalledTimes(2);
  expect(listImportableSessions.mock.calls.map(([options]) => options?.cwd).sort()).toEqual(
    [mainCwd, worktreeCwd].sort(),
  );
  expect(result.entries.map((entry) => entry.providerHandleId)).toEqual([
    "worktree",
    "main",
    "duplicate",
  ]);
});

test("listImportableProviderSessions shares its project cwd fanout bound across providers", async () => {
  const scopedCwds = Array.from({ length: 6 }, (_, index) => `/tmp/lpu-worktree-${index}`);
  let active = 0;
  let maxActive = 0;
  const listImportableSessions = vi.fn(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
    return [];
  });
  const agentManager = { listAgents: () => [], listImportableSessions };
  const commonInput = {
    agentManager,
    agentStorage: { list: async () => [] },
    providerSnapshotManager: { getProviderLabel: () => "" },
    projectImportScopeResolver: exactProjectScopeResolver(scopedCwds),
  };

  await Promise.all([
    listImportableProviderSessions({
      ...commonInput,
      request: makeRequest({ projectId: "lpu", providers: ["claude"], limit: 10 }),
    }),
    listImportableProviderSessions({
      ...commonInput,
      request: makeRequest({ projectId: "lpu", providers: ["copilot"], limit: 10 }),
    }),
  ]);

  expect(listImportableSessions).toHaveBeenCalledTimes(scopedCwds.length * 2);
  expect(maxActive).toBe(4);
});

test("listImportableProviderSessions rejects ambiguous cwd and project scope", async () => {
  await expect(
    listImportableProviderSessions({
      request: makeRequest({ cwd: "/tmp/lpu", projectId: "lpu" }),
      agentManager: { listAgents: () => [], listImportableSessions: async () => [] },
      agentStorage: { list: async () => [] },
      providerSnapshotManager: { getProviderLabel: () => "" },
      projectImportScopeResolver: exactProjectScopeResolver(["/tmp/lpu"]),
    }),
  ).rejects.toMatchObject({ code: "invalid_scope" });
});

test("listImportableProviderSessions accepts legacy v1 cwd cursors", async () => {
  const cwd = "/tmp/project";
  const legacyCursor = Buffer.from(
    JSON.stringify({
      v: 1,
      provider: "codex",
      cwd: normalizePathForIdentity(cwd),
      since: null,
      cursor: "native-page-2",
    }),
  ).toString("base64url");
  const openImportableSessionPager = vi.fn(async () => ({
    next: async () => ({ sessions: [], nextCursor: null }),
    close: async () => {},
  }));

  await listImportableProviderSessions({
    request: makeRequest({ cwd, providers: ["codex"], cursor: legacyCursor }),
    agentManager: {
      listAgents: () => [],
      listImportableSessions: async () => [],
      openImportableSessionPager,
    },
    agentStorage: { list: async () => [] },
    providerSnapshotManager: { getProviderLabel: () => "Codex" },
  });

  expect(openImportableSessionPager).toHaveBeenCalledWith("codex", {
    cursor: "native-page-2",
  });
});

test("listImportableProviderSessions includes a provider session after its Paseo agent is archived", async () => {
  const cwd = "/tmp/project";
  const archivedSession = makeImportableSession({
    provider: "claude",
    sessionId: "archived-session",
    cwd,
    title: "Archived import",
    lastActivityAt: "2026-04-30T12:00:00.000Z",
    firstPrompt: "import me again",
  });

  const result = await listImportableProviderSessions({
    request: makeRequest({ cwd, providers: ["claude"] }),
    agentManager: {
      listAgents: () => [],
      listImportableSessions: async () => [archivedSession],
    },
    agentStorage: {
      list: async () => [
        {
          provider: "claude",
          archivedAt: "2026-04-30T12:01:00.000Z",
          persistence: {
            provider: "claude",
            sessionId: "archived-session",
          },
        } as StoredAgentRecord,
      ],
    },
    providerSnapshotManager: { getProviderLabel: () => "Claude" },
  });

  expect(result.entries.map((entry) => entry.providerHandleId)).toEqual(["archived-session"]);
  expect(result.filteredAlreadyImportedCount).toBe(0);
});

test("listImportableProviderSessions includes an archived provider session still loaded in memory", async () => {
  const cwd = "/tmp/project";
  const agentId = "00000000-0000-4000-8000-000000000633";
  const archivedSession = makeImportableSession({
    provider: "claude",
    sessionId: "archived-live-session",
    cwd,
    title: "Archived live import",
    lastActivityAt: "2026-04-30T12:00:00.000Z",
    firstPrompt: "import the loaded session again",
  });

  const result = await listImportableProviderSessions({
    request: makeRequest({ cwd, providers: ["claude"] }),
    agentManager: {
      listAgents: () => [
        makeManagedAgent({
          id: agentId,
          provider: "claude",
          cwd,
          sessionId: "archived-live-session",
        }),
      ],
      listImportableSessions: async () => [archivedSession],
    },
    agentStorage: {
      list: async () => [
        {
          id: agentId,
          provider: "claude",
          archivedAt: "2026-04-30T12:01:00.000Z",
          persistence: {
            provider: "claude",
            sessionId: "archived-live-session",
          },
        } as StoredAgentRecord,
      ],
    },
    providerSnapshotManager: { getProviderLabel: () => "Claude" },
  });

  expect(result.entries.map((entry) => entry.providerHandleId)).toEqual(["archived-live-session"]);
  expect(result.filteredAlreadyImportedCount).toBe(0);
});

test("listImportableProviderSessions filters out metadata generation sessions", async () => {
  const cwd = "/tmp/project";
  const sessions = [
    makeImportableSession({
      sessionId: "metadata-session",
      nativeHandle: "metadata-handle",
      cwd,
      title: "Generate metadata for a coding agent based on the user prom...",
      lastActivityAt: "2026-04-30T12:05:00.000Z",
      firstPrompt:
        "Generate metadata for a coding agent based on the user prompt.\nTitle: short descriptive label (<= 40 chars).",
    }),
    makeImportableSession({
      sessionId: "real-session",
      nativeHandle: "real-handle",
      cwd,
      title: "Real session",
      lastActivityAt: "2026-04-30T12:00:00.000Z",
      firstPrompt: "hey hey",
    }),
  ];

  const result = await listImportableProviderSessions({
    request: makeRequest({ cwd, providers: ["codex"] }),
    agentManager: {
      listAgents: () => [],
      listImportableSessions: async () => sessions,
    } satisfies Pick<AgentManager, "listAgents" | "listImportableSessions">,
    agentStorage: {
      list: async () => [],
    } satisfies Pick<AgentStorage, "list">,
    providerSnapshotManager: { getProviderLabel: () => "Codex" },
  });

  expect(result.entries).toHaveLength(1);
  expect(result.entries[0].providerHandleId).toBe("real-handle");
  expect(result.filteredAlreadyImportedCount).toBe(0);
});

test("listImportableProviderSessions keeps realpath-equivalent cwd matches while paging", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-import-cwd-"));
  const realCwd = path.join(root, "real-project");
  const linkedCwd = path.join(root, "linked-project");
  mkdirSync(realCwd, { recursive: true });
  symlinkSync(realCwd, linkedCwd, directorySymlinkType);
  const persistedCwd = realpathSync(linkedCwd);

  const result = await listImportableProviderSessions({
    request: makeRequest({ cwd: linkedCwd, providers: ["codex"] }),
    agentManager: {
      listAgents: () => [],
      listImportableSessions: async () => [],
      openImportableSessionPager: async () => ({
        next: async () => ({
          sessions: [
            makeImportableSession({
              sessionId: "codex-session",
              nativeHandle: "codex-handle",
              cwd: persistedCwd,
              title: "Codex session",
              lastActivityAt: "2026-04-30T12:00:00.000Z",
              firstPrompt: "remember this",
            }),
          ],
          nextCursor: null,
        }),
        close: async () => {},
      }),
    },
    agentStorage: {
      list: async () => [],
    } satisfies Pick<AgentStorage, "list">,
    providerSnapshotManager: { getProviderLabel: () => "Codex" },
  });

  expect(result.entries.map((entry) => entry.providerHandleId)).toEqual(["codex-handle"]);
  expect(result.nextCursor).toBeNull();
});

test("listImportableProviderSessions rejects invalid since values", async () => {
  await expect(
    listImportableProviderSessions({
      request: makeRequest({ since: "not-a-date" }),
      agentManager: {
        listAgents: () => [],
        listImportableSessions: async () => [],
      } satisfies Pick<AgentManager, "listAgents" | "listImportableSessions">,
      agentStorage: {
        list: async () => [],
      } satisfies Pick<AgentStorage, "list">,
      providerSnapshotManager: { getProviderLabel: () => "" },
    }),
  ).rejects.toMatchObject(
    new ImportSessionsRequestError("invalid_since", "Invalid recent provider sessions since"),
  );
});

test("normalizeImportAgentRequest accepts new and legacy import handle shapes", () => {
  expect(
    normalizeImportAgentRequest({
      type: "import_agent_request",
      requestId: "new-shape",
      providerId: "custom-codex",
      providerHandleId: "thread-1",
    }),
  ).toEqual({
    requestId: "new-shape",
    provider: "custom-codex",
    providerHandleId: "thread-1",
  });

  expect(
    normalizeImportAgentRequest({
      type: "import_agent_request",
      requestId: "legacy-shape",
      provider: "codex",
      sessionId: "thread-2",
    }),
  ).toEqual({
    requestId: "legacy-shape",
    provider: "codex",
    providerHandleId: "thread-2",
  });

  expect(
    normalizeImportAgentRequest({
      type: "import_agent_request",
      requestId: "project-shape",
      providerId: "codex",
      providerHandleId: "thread-3",
      projectId: "lpu",
    }),
  ).toEqual({
    requestId: "project-shape",
    provider: "codex",
    providerHandleId: "thread-3",
    projectId: "lpu",
  });

  expect(
    normalizeImportAgentRequest({
      type: "import_agent_request",
      requestId: "ambiguous-target",
      providerId: "codex",
      providerHandleId: "thread-4",
      workspaceId: "workspace",
      projectId: "lpu",
    }),
  ).toEqual({ error: "Import cannot target both a workspace and a project" });
});

function exactProjectScopeResolver(exactCwds: string[]): ProjectImportScopeResolver {
  const matchers = exactCwds.map((cwd) => createRealpathAwarePathMatcher(cwd));
  return {
    resolve: vi.fn(async (projectId: string) => ({
      projectId,
      exactCwds,
      matchesCwd: async (candidate: string) => matchers.some((matches) => matches(candidate)),
    })),
  };
}

function makeStoredProviderSession(input: {
  id: string;
  cwd: string;
  sessionId: string;
  nativeHandle?: string;
  workspaceId?: string;
  labels?: Record<string, string>;
  archivedAt?: string | null;
}): StoredAgentRecord {
  return {
    id: input.id,
    provider: "codex",
    cwd: input.cwd,
    workspaceId: input.workspaceId ?? "ws-archived",
    createdAt: "2026-04-30T10:00:00.000Z",
    updatedAt: "2026-04-30T11:00:00.000Z",
    lastActivityAt: "2026-04-30T10:30:00.000Z",
    lastUserMessageAt: null,
    labels: input.labels ?? {},
    config: { provider: "codex", cwd: input.cwd },
    persistence: {
      provider: "codex",
      sessionId: input.sessionId,
      nativeHandle: input.nativeHandle ?? input.sessionId,
      metadata: { provider: "codex", cwd: input.cwd },
    },
    archivedAt: input.archivedAt === undefined ? "2026-04-30T12:00:00.000Z" : input.archivedAt,
  };
}

class ProviderImportHarness {
  readonly storage: AgentStorage;
  readonly manager: ImportSessionAgentManager;
  readonly snapshot: ManagedAgent;
  readonly freshImports: unknown[] = [];
  readonly closedAgentIds: string[] = [];
  timeline: AgentTimelineItem[] = [];
  activeAgent: ManagedAgent | null = null;
  resumeError: Error | null = null;
  resumeAttempts = 0;
  private unarchiveWait: Promise<void> | null = null;
  private releaseUnarchive: (() => void) | null = null;

  private constructor(input: { storage: AgentStorage; snapshot: ManagedAgent }) {
    this.storage = input.storage;
    this.snapshot = input.snapshot;
    this.manager = {
      importProviderSession: async (request: unknown) => {
        this.freshImports.push(request);
        this.activeAgent = this.snapshot;
        return this.snapshot;
      },
      unarchiveSnapshot: async (
        agentId: string,
        updates?: { workspaceId?: string; labels?: Record<string, string | null> },
      ) => {
        if (this.unarchiveWait) {
          await this.unarchiveWait;
        }
        const record = await this.storage.get(agentId);
        if (!record?.archivedAt) {
          return false;
        }
        const labels = { ...record.labels };
        for (const [key, value] of Object.entries(updates?.labels ?? {})) {
          if (value === null) {
            delete labels[key];
          } else {
            labels[key] = value;
          }
        }
        await this.storage.upsert({
          ...record,
          workspaceId: updates?.workspaceId ?? record.workspaceId,
          labels,
          archivedAt: null,
        });
        return true;
      },
      notifyAgentState: () => {},
      getAgent: () => this.activeAgent,
      getRegisteredProviderIds: () => ["codex"],
      createAgent: async () => {
        throw new Error("Stored provider imports must resume their persisted session");
      },
      resumeAgentFromPersistence: async (
        _handle: unknown,
        _overrides: unknown,
        _agentId?: string,
        _options?: unknown,
      ) => {
        this.resumeAttempts += 1;
        if (this.resumeError) {
          this.activeAgent = this.snapshot;
          throw this.resumeError;
        }
        this.activeAgent = this.snapshot;
        return this.snapshot;
      },
      hydrateTimelineFromProvider: async () => {},
      getTimeline: () => this.timeline,
      closeAgent: async (agentId: string) => {
        this.closedAgentIds.push(agentId);
        this.activeAgent = null;
      },
      archiveSnapshot: async (agentId: string, archivedAt: string) => {
        const record = await this.storage.get(agentId);
        if (!record) {
          throw new Error("Agent not found: " + agentId);
        }
        const archived = { ...record, archivedAt };
        await this.storage.upsert(archived);
        return archived;
      },
    } satisfies ImportSessionAgentManager;
  }

  static async create(
    input: {
      id?: string;
      cwd?: string;
      sessionId?: string;
      nativeHandle?: string;
    } = {},
  ): Promise<ProviderImportHarness> {
    const directory = mkdtempSync(path.join(tmpdir(), "provider-import-"));
    importTestDirectories.push(directory);
    const storage = new AgentStorage(path.join(directory, "agents"), createTestLogger());
    await storage.initialize();
    const cwd = input.cwd ?? "/tmp/imported-agent";
    const sessionId = input.sessionId ?? "thread-imported";
    const snapshot = makeManagedAgent({
      id: input.id,
      provider: "codex",
      cwd,
      sessionId,
      nativeHandle: input.nativeHandle,
    });
    return new ProviderImportHarness({ storage, snapshot });
  }

  async seed(record: StoredAgentRecord): Promise<void> {
    await this.storage.upsert(record);
  }

  blockUnarchive(): () => void {
    this.unarchiveWait = new Promise<void>((resolve) => {
      this.releaseUnarchive = resolve;
    });
    return () => {
      this.releaseUnarchive?.();
      this.unarchiveWait = null;
      this.releaseUnarchive = null;
    };
  }

  import(input: { providerHandleId: string; cwd?: string; labels?: Record<string, string> }) {
    return importProviderSession({
      request: {
        requestId: "import-thread",
        provider: "codex",
        providerHandleId: input.providerHandleId,
        cwd: input.cwd,
        labels: input.labels,
      },
      workspaceProvisioning: createImportWorkspace("ws-restored"),
      agentManager: this.manager,
      agentStorage: this.storage,
      logger: createTestLogger(),
    });
  }
}

test("importProviderSession uses the provider import path with the requested labels", async () => {
  const harness = await ProviderImportHarness.create();
  harness.timeline = [
    { type: "user_message", text: "Trace recent provider sessions" },
    { type: "assistant_message", text: "I will inspect the provider listing." },
  ];

  const result = await harness.import({
    providerHandleId: "thread-imported",
    cwd: "/tmp/imported-agent",
    labels: { source: "import" },
  });

  expect(harness.freshImports).toEqual([
    {
      provider: "codex",
      providerHandleId: "thread-imported",
      cwd: "/tmp/imported-agent",
      workspaceId: "ws-restored",
      labels: { source: "import" },
    },
  ]);
  expect(result).toEqual({
    snapshot: harness.snapshot,
    timelineSize: 2,
    createdWorkspace: null,
  });
});

test("importProviderSession forwards the requested project to workspace provisioning", async () => {
  const harness = await ProviderImportHarness.create();
  const baseProvisioning = createImportWorkspace("ws-project-import");
  const runInImportWorkspace = vi.fn(baseProvisioning.runInImportWorkspace);

  await importProviderSession({
    request: {
      requestId: "import-project-thread",
      provider: "codex",
      providerHandleId: "thread-imported",
      cwd: "/tmp/imported-agent",
      projectId: "lpu",
    },
    workspaceProvisioning: { runInImportWorkspace },
    agentManager: harness.manager,
    agentStorage: harness.storage,
    logger: createTestLogger(),
  });

  expect(runInImportWorkspace).toHaveBeenCalledWith(
    {
      cwd: "/tmp/imported-agent",
      requestedWorkspaceId: undefined,
      requestedProjectId: "lpu",
    },
    expect.any(Function),
  );
});

test("importProviderSession rejects a provider session with an active stored owner", async () => {
  const harness = await ProviderImportHarness.create({ sessionId: "thread-active" });
  await harness.seed(
    makeStoredProviderSession({
      id: harness.snapshot.id,
      cwd: harness.snapshot.cwd,
      sessionId: "thread-active",
      archivedAt: null,
    }),
  );

  await expect(
    harness.import({ providerHandleId: "thread-active", cwd: harness.snapshot.cwd }),
  ).rejects.toThrow("Provider session is already imported: thread-active");
  expect(harness.freshImports).toEqual([]);
});

test("importProviderSession restores an archived session as the same standalone agent", async () => {
  const harness = await ProviderImportHarness.create({ sessionId: "thread-archived" });
  harness.timeline = [{ type: "user_message", text: "restored" }];
  const archived = makeStoredProviderSession({
    id: harness.snapshot.id,
    cwd: harness.snapshot.cwd,
    sessionId: "thread-archived",
    labels: { existing: "label", [PARENT_AGENT_ID_LABEL]: "archived-parent" },
  });
  await harness.seed(archived);

  const result = await harness.import({
    providerHandleId: "thread-archived",
    cwd: harness.snapshot.cwd,
    labels: { source: "reimport" },
  });

  expect(result).toEqual({
    snapshot: harness.snapshot,
    timelineSize: 1,
    createdWorkspace: null,
  });
  expect(await harness.storage.get(harness.snapshot.id)).toMatchObject({
    id: harness.snapshot.id,
    workspaceId: "ws-restored",
    labels: { existing: "label", source: "reimport" },
    archivedAt: null,
  });
  expect((await harness.storage.get(harness.snapshot.id))?.labels).not.toHaveProperty(
    PARENT_AGENT_ID_LABEL,
  );
  expect(harness.resumeAttempts).toBe(1);
  expect(harness.freshImports).toEqual([]);
});

test("importProviderSession rejects an archived session from a different cwd before restoring", async () => {
  const harness = await ProviderImportHarness.create({ sessionId: "thread-other-cwd" });
  const archived = makeStoredProviderSession({
    id: harness.snapshot.id,
    cwd: "/tmp/other-agent",
    sessionId: "thread-other-cwd",
  });
  await harness.seed(archived);

  await expect(
    harness.import({ providerHandleId: "thread-other-cwd", cwd: "/tmp/target-agent" }),
  ).rejects.toThrow("Provider session cwd does not match import cwd: thread-other-cwd");
  expect(await harness.storage.get(harness.snapshot.id)).toEqual(archived);
  expect(harness.resumeAttempts).toBe(0);
});

test("importProviderSession restores storage and closes a partial runtime when loading fails", async () => {
  const harness = await ProviderImportHarness.create({ sessionId: "thread-stale" });
  const archived = makeStoredProviderSession({
    id: harness.snapshot.id,
    cwd: harness.snapshot.cwd,
    sessionId: "thread-stale",
  });
  await harness.seed(archived);
  harness.resumeError = new Error("provider session is unavailable");

  await expect(
    harness.import({ providerHandleId: "thread-stale", cwd: harness.snapshot.cwd }),
  ).rejects.toThrow("provider session is unavailable");

  expect(await harness.storage.get(harness.snapshot.id)).toEqual(archived);
  expect(harness.activeAgent).toBeNull();
  expect(harness.closedAgentIds).toEqual([harness.snapshot.id]);
});

test("importProviderSession serializes legacy and native aliases for one archived session", async () => {
  const harness = await ProviderImportHarness.create({
    sessionId: "legacy-thread",
    nativeHandle: "native-thread",
  });
  await harness.seed(
    makeStoredProviderSession({
      id: harness.snapshot.id,
      cwd: harness.snapshot.cwd,
      sessionId: "legacy-thread",
      nativeHandle: "native-thread",
    }),
  );
  const releaseUnarchive = harness.blockUnarchive();

  const winningRestore = harness.import({
    providerHandleId: "native-thread",
    cwd: harness.snapshot.cwd,
  });
  const duplicateRestore = harness.import({
    providerHandleId: "legacy-thread",
    cwd: harness.snapshot.cwd,
  });
  releaseUnarchive();

  await expect(winningRestore).resolves.toMatchObject({
    snapshot: { id: harness.snapshot.id },
    timelineSize: 0,
  });
  await expect(duplicateRestore).rejects.toThrow(
    "Provider session is already imported: legacy-thread",
  );
  expect(harness.resumeAttempts).toBe(1);
  expect(harness.closedAgentIds).toEqual([]);
});

test("importProviderSession requires cwd from the selected provider row", async () => {
  const harness = await ProviderImportHarness.create();

  await expect(harness.import({ providerHandleId: "thread-imported" })).rejects.toThrow(
    "Import requires cwd from the selected provider session",
  );
});
