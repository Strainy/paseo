/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  DaemonClient,
  FetchRecentProviderSessionEntry,
} from "@getpaseo/client/internal/daemon-client";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportSessionSheet, type ImportSessionTarget } from "@/components/import-session-sheet";

const DEFAULT_WORKSPACE_TARGET: ImportSessionTarget = {
  kind: "workspace",
  cwd: "/repo/paseo",
  workspaceId: "workspace-1",
};
const HOST_TARGET: ImportSessionTarget = { kind: "host" };
const PROJECT_ONE_TARGET: ImportSessionTarget = {
  kind: "project",
  projectId: "project-one",
  providerContextCwd: "/repo/project-one",
};
const PROJECT_TWO_TARGET: ImportSessionTarget = {
  kind: "project",
  projectId: "project-two",
  providerContextCwd: "/repo/project-two",
};

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 6: 24 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 6, lg: 8, full: 9999 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    iconSize: { sm: 14, md: 16 },
    opacity: { 50: 0.5 },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      border: "#444",
      borderAccent: "#555",
    },
  },
}));

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({
      uniProps,
      ...rest
    }: {
      uniProps?: (theme: unknown) => Record<string, unknown>;
    } & Record<string, unknown>) => {
      const themed = uniProps ? uniProps(theme) : {};
      return React.createElement(Component, { ...rest, ...themed });
    },
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));

vi.mock("@/components/provider-icons", () => ({
  getProviderIcon: () => () => null,
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => {
    const Icon = () => React.createElement("span", { "data-icon": name });
    Icon.displayName = name;
    return Icon;
  };
  return {
    ChevronDown: icon("ChevronDown"),
    Inbox: icon("Inbox"),
    Layers: icon("Layers"),
    RotateCw: icon("RotateCw"),
  };
});

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () =>
    React.createElement("span", { "data-testid": "import-session-loading-spinner" }),
}));

vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({
    options,
    value,
    onSelect,
    open,
  }: {
    options: ReadonlyArray<{ id: string; label: string }>;
    value: string;
    onSelect: (id: string) => void;
    open?: boolean;
  }) => {
    if (!open) return null;
    return React.createElement(
      "div",
      { "data-testid": "import-session-combobox" },
      options.map((option) =>
        React.createElement(
          "button",
          {
            key: option.id,
            type: "button",
            "data-testid": `import-session-filter-${option.id === "__all__" ? "all" : option.id}`,
            "data-selected": value === option.id,
            onClick: () => onSelect(option.id),
          },
          option.label,
        ),
      ),
    );
  },
  ComboboxItem: ({ label }: { label: string }) => React.createElement("span", null, label),
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    visible,
    header,
    children,
    testID,
  }: {
    visible: boolean;
    header?: { title: string; actions?: ReactNode };
    children: ReactNode;
    testID?: string;
  }) =>
    visible ? (
      <section data-testid={testID}>
        <h1>{header?.title}</h1>
        {header?.actions}
        {children}
      </section>
    ) : null,
}));

vi.mock("react-native", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("react-native");
  return actual;
});

const mockSnapshot = vi.hoisted(() => ({
  current: {
    entries: undefined as ProviderSnapshotEntry[] | undefined,
    supportsSnapshot: false,
  },
}));

const mockHostFeatures = vi.hoisted(() => ({
  importSessionPagination: false,
  importSessionProjectScope: false,
  importSessionWorkspaceTarget: true,
}));

const mockUseProvidersSnapshot = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string | null, feature: keyof typeof mockHostFeatures) =>
    mockHostFeatures[feature] ?? false,
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: (...args: unknown[]) => {
    mockUseProvidersSnapshot(...args);
    return {
      entries: mockSnapshot.current.entries,
      isLoading: false,
      isFetching: false,
      isRefreshing: false,
      error: null,
      supportsSnapshot: mockSnapshot.current.supportsSnapshot,
      refresh: vi.fn(),
      refetchIfStale: vi.fn(),
    };
  },
}));

interface RenderOptions {
  visible?: boolean;
  onClose?: () => void;
  onImportedAgent?: (agentId: string) => void;
  onImported?: (agent: Awaited<ReturnType<DaemonClient["importAgent"]>>) => void;
  target?: ImportSessionTarget;
  snapshot?: {
    entries?: ProviderSnapshotEntry[];
    supportsSnapshot?: boolean;
  };
}

function renderSheet(
  client: Pick<DaemonClient, "fetchRecentProviderSessions" | "importAgent">,
  options?: RenderOptions,
) {
  mockSnapshot.current = {
    entries: options?.snapshot?.entries,
    supportsSnapshot: options?.snapshot?.supportsSnapshot ?? false,
  };

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const target = options?.target ?? DEFAULT_WORKSPACE_TARGET;

  return render(
    <QueryClientProvider client={queryClient}>
      <ImportSessionSheet
        visible={options?.visible ?? true}
        client={client}
        serverId="server-1"
        target={target}
        onClose={options?.onClose ?? vi.fn()}
        onImportedAgent={options?.onImportedAgent ?? vi.fn()}
        onImported={options?.onImported}
      />
    </QueryClientProvider>,
  );
}

function createRecentSessionsClient(
  fetchRecentProviderSessions: Pick<
    DaemonClient,
    "fetchRecentProviderSessions"
  >["fetchRecentProviderSessions"],
  importAgent: Pick<DaemonClient, "importAgent">["importAgent"],
): Pick<DaemonClient, "fetchRecentProviderSessions" | "importAgent"> {
  return { fetchRecentProviderSessions, importAgent };
}

function createImportedAgentSnapshot(id: string): Awaited<ReturnType<DaemonClient["importAgent"]>> {
  return {
    id,
    provider: "custom-provider",
    cwd: "/repo/paseo",
    model: null,
    createdAt: "2026-04-30T10:00:00.000Z",
    updatedAt: "2026-04-30T10:00:00.000Z",
    lastUserMessageAt: "2026-04-30T10:00:00.000Z",
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    labels: {},
  };
}

function createProviderSessionEntry(
  overrides?: Partial<FetchRecentProviderSessionEntry>,
): FetchRecentProviderSessionEntry {
  return {
    providerId: "custom-provider",
    providerLabel: "Custom Agent",
    providerHandleId: "provider-thread-1",
    cwd: "/repo/paseo",
    title: "Import me",
    firstPromptPreview: "Import this external provider session",
    lastPromptPreview: "Import this external provider session",
    lastActivityAt: "2026-04-30T10:00:00.000Z",
    ...overrides,
  };
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

function createSnapshotEntry(
  provider: string,
  overrides?: Partial<ProviderSnapshotEntry>,
): ProviderSnapshotEntry {
  return {
    provider,
    status: "ready",
    enabled: true,
    label: PROVIDER_LABELS[provider] ?? provider,
    ...overrides,
  };
}

describe("ImportSessionSheet", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockHostFeatures.importSessionPagination = false;
    mockHostFeatures.importSessionProjectScope = false;
    mockHostFeatures.importSessionWorkspaceTarget = true;
  });

  it("shows an update-host message when the daemon does not support provider snapshots", async () => {
    const fetchRecentProviderSessions = vi.fn();
    const importAgent = vi.fn();

    renderSheet({ fetchRecentProviderSessions, importAgent } as Pick<
      DaemonClient,
      "fetchRecentProviderSessions" | "importAgent"
    >);

    await screen.findByText("Update the host to import sessions.");
    expect(fetchRecentProviderSessions).not.toHaveBeenCalled();
  });

  it("shows a loading state while provider snapshot is loading", async () => {
    const fetchRecentProviderSessions = vi.fn(
      () => new Promise<Awaited<ReturnType<DaemonClient["fetchRecentProviderSessions"]>>>(() => {}),
    );
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: { supportsSnapshot: true, entries: undefined },
      },
    );

    await screen.findByText("Loading recent sessions...");
    expect(fetchRecentProviderSessions).not.toHaveBeenCalled();
  });

  it("requires project-scope support before listing sessions for a project", async () => {
    const fetchRecentProviderSessions = vi.fn();
    const importAgent = vi.fn();

    renderSheet(createRecentSessionsClient(fetchRecentProviderSessions, importAgent), {
      target: {
        kind: "project",
        projectId: "project-lpu",
        providerContextCwd: "/repo/lpu-monorepo",
      },
      snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("codex")] },
    });

    await screen.findByText("Update the host to import sessions.");
    expect(fetchRecentProviderSessions).not.toHaveBeenCalled();
  });

  it("rejects an empty workspace scope instead of falling back to host-wide listing", () => {
    const fetchRecentProviderSessions = vi.fn();

    expect(() =>
      renderSheet(createRecentSessionsClient(fetchRecentProviderSessions, vi.fn()), {
        target: { kind: "workspace", cwd: "   ", workspaceId: "workspace-1" },
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("codex")] },
      }),
    ).toThrow("Import session workspace cwd must not be empty");
    expect(fetchRecentProviderSessions).not.toHaveBeenCalled();
  });

  it("uses project scope for listing, pagination, and import while keeping provider context local", async () => {
    mockHostFeatures.importSessionPagination = true;
    mockHostFeatures.importSessionProjectScope = true;
    const fetchRecentProviderSessions = vi.fn(
      async (options: Parameters<DaemonClient["fetchRecentProviderSessions"]>[0]) => ({
        requestId: options?.cursor ? "project-page-2" : "project-page-1",
        entries: [
          createProviderSessionEntry({
            providerId: "codex",
            providerLabel: "Codex",
            providerHandleId: options?.cursor ? "linked-worktree-2" : "linked-worktree-1",
            cwd: options?.cursor
              ? "/home/me/.codex/worktrees/b842/lpu-monorepo"
              : "/home/me/.codex/worktrees/a227/lpu-monorepo",
            title: options?.cursor ? "Second linked session" : "First linked session",
          }),
        ],
        nextCursor: options?.cursor ? null : "project-cursor-2",
      }),
    );
    const importAgent = vi.fn(async () => createImportedAgentSnapshot("agent-project-import"));

    renderSheet(createRecentSessionsClient(fetchRecentProviderSessions, importAgent), {
      target: {
        kind: "project",
        projectId: "project-lpu",
        providerContextCwd: "/repo/lpu-monorepo",
      },
      snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("codex")] },
    });

    await screen.findByText("First linked session");
    expect(mockUseProvidersSnapshot).toHaveBeenCalledWith("server-1", {
      cwd: "/repo/lpu-monorepo",
      enabled: true,
    });
    expect(fetchRecentProviderSessions).toHaveBeenNthCalledWith(1, {
      projectId: "project-lpu",
      providers: ["codex"],
      limit: 15,
    });
    expect(fetchRecentProviderSessions).not.toHaveBeenCalledWith(
      expect.objectContaining({ cwd: expect.anything() }),
    );
    await screen.findByText("/home/me/.codex/worktrees/a227/lpu-monorepo");

    fireEvent.click(screen.getByTestId("import-session-load-more"));
    await screen.findByText("Second linked session");
    expect(fetchRecentProviderSessions).toHaveBeenNthCalledWith(2, {
      projectId: "project-lpu",
      providers: ["codex"],
      limit: 15,
      cursor: "project-cursor-2",
    });

    fireEvent.click(screen.getByTestId("import-session-session-codex-linked-worktree-1"));
    await waitFor(() => {
      expect(importAgent).toHaveBeenCalledWith({
        providerId: "codex",
        providerHandleId: "linked-worktree-1",
        cwd: "/home/me/.codex/worktrees/a227/lpu-monorepo",
        projectId: "project-lpu",
      });
    });
  });

  it("shows an empty state when there are no recent provider sessions to import", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [],
    }));
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    await screen.findByText("No recent sessions to import.");
  });

  it("shows the all-already-imported empty state when filteredAlreadyImportedCount is positive", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [],
      filteredAlreadyImportedCount: 3,
    }));
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    await screen.findByText("All recent sessions are already imported.");
    expect(screen.queryByText("No recent sessions to import.")).toBeNull();
  });

  it("shows a fetch error state when recent provider sessions cannot be loaded", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => {
      throw new Error("recent sessions unavailable");
    });
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    await screen.findByText("Could not load recent sessions.");
  });

  it("loads recent provider sessions for the workspace and renders descriptor-owned labels", async () => {
    vi.setSystemTime(new Date("2026-04-30T12:00:00.000Z"));
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [
        createProviderSessionEntry({
          providerId: "claude",
          providerLabel: "Claude Code",
          title: null,
          firstPromptPreview: "Implement the importer sheet",
          lastPromptPreview: "Make the rows readable and provider opaque",
        }),
      ],
    }));
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    await waitFor(() => {
      expect(fetchRecentProviderSessions).toHaveBeenCalledWith({
        cwd: "/repo/paseo",
        providers: ["claude"],
        limit: 15,
      });
    });

    await screen.findByText("Implement the importer sheet");
    screen.getByText("2h ago");
    screen.getByText("Make the rows readable and provider opaque");
  });

  it("keeps cached rows visible and revalidates when reopened", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [
        createProviderSessionEntry({
          providerId: "claude",
          providerLabel: "Claude Code",
          title: "Cached importable session",
        }),
      ],
    }));
    const importAgent = vi.fn();
    const client = createRecentSessionsClient(fetchRecentProviderSessions, importAgent);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    mockSnapshot.current = {
      entries: [createSnapshotEntry("claude")],
      supportsSnapshot: true,
    };

    function TestSheet({ visible }: { visible: boolean }) {
      return (
        <QueryClientProvider client={queryClient}>
          <ImportSessionSheet
            visible={visible}
            client={client}
            serverId="server-1"
            target={DEFAULT_WORKSPACE_TARGET}
            onClose={vi.fn()}
            onImportedAgent={vi.fn()}
          />
        </QueryClientProvider>
      );
    }

    const { rerender } = render(<TestSheet visible />);

    await screen.findByText("Cached importable session");
    expect(fetchRecentProviderSessions).toHaveBeenCalledTimes(1);

    rerender(<TestSheet visible={false} />);
    fetchRecentProviderSessions.mockClear();
    rerender(<TestSheet visible />);

    await screen.findByText("Cached importable session");
    await waitFor(() => {
      expect(fetchRecentProviderSessions).toHaveBeenCalledWith({
        cwd: "/repo/paseo",
        providers: ["claude"],
        limit: 15,
      });
    });
  });

  it("imports a selected session by provider handle and reports the imported agent", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [
        createProviderSessionEntry({
          providerId: "claude",
          providerLabel: "Claude Code",
          cwd: "/repo/paseo-realpath",
        }),
      ],
    }));
    const importAgent = vi.fn(async () => createImportedAgentSnapshot("agent-imported"));
    const onClose = vi.fn();
    const onImportedAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        onClose,
        onImportedAgent,
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    fireEvent.click(await screen.findByTestId("import-session-session-claude-provider-thread-1"));

    await waitFor(() => {
      expect(importAgent).toHaveBeenCalledWith({
        providerId: "claude",
        providerHandleId: "provider-thread-1",
        cwd: "/repo/paseo-realpath",
        workspaceId: "workspace-1",
      });
    });
    expect(onImportedAgent).toHaveBeenCalledWith("agent-imported");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the provider error without closing when selected session import fails", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [createProviderSessionEntry({ providerId: "codex", providerLabel: "Codex" })],
    }));
    const importAgent = vi.fn(async () => {
      throw new Error(
        "This Codex session is still open in another Codex client. Close it there, then try again.",
      );
    });
    const onClose = vi.fn();
    const onImportedAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        onClose,
        onImportedAgent,
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("codex")] },
      },
    );

    fireEvent.click(await screen.findByTestId("import-session-session-codex-provider-thread-1"));

    await screen.findByText("Could not import selected session.");
    await screen.findByText(
      "This Codex session is still open in another Codex client. Close it there, then try again.",
    );
    expect(importAgent).toHaveBeenCalledWith({
      providerId: "codex",
      providerHandleId: "provider-thread-1",
      cwd: "/repo/paseo",
      workspaceId: "workspace-1",
    });
    expect(onImportedAgent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("fans out one request per enabled provider when snapshot is supported", async () => {
    const fetchRecentProviderSessions = vi.fn(
      async (options: { providers?: string[] } | undefined) => ({
        requestId: `recent-${options?.providers?.[0] ?? "all"}`,
        entries: [
          createProviderSessionEntry({
            providerId: options?.providers?.[0] ?? "custom-provider",
            providerLabel: options?.providers?.[0] ?? "Custom",
            providerHandleId: `${options?.providers?.[0] ?? "custom-provider"}-thread`,
            title: `Session ${options?.providers?.[0] ?? "all"}`,
            lastActivityAt: "2026-04-30T10:00:00.000Z",
          }),
        ],
      }),
    );
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: {
          supportsSnapshot: true,
          entries: [
            createSnapshotEntry("claude"),
            createSnapshotEntry("codex"),
            createSnapshotEntry("opencode", { enabled: false }),
            createSnapshotEntry("z-ai"),
          ],
        },
      },
    );

    await waitFor(() => {
      expect(fetchRecentProviderSessions).toHaveBeenCalledWith({
        cwd: "/repo/paseo",
        providers: ["claude"],
        limit: 15,
      });
    });
    expect(fetchRecentProviderSessions).toHaveBeenCalledWith({
      cwd: "/repo/paseo",
      providers: ["codex"],
      limit: 15,
    });
    expect(fetchRecentProviderSessions).not.toHaveBeenCalledWith(
      expect.objectContaining({ providers: ["opencode"] }),
    );
    expect(fetchRecentProviderSessions).toHaveBeenCalledWith({
      cwd: "/repo/paseo",
      providers: ["z-ai"],
      limit: 15,
    });

    await screen.findByText("Session claude");
    await screen.findByText("Session codex");
    await screen.findByText("Session z-ai");
  });

  it("shows partial-failure note when one provider request fails but others succeed", async () => {
    const fetchRecentProviderSessions = vi.fn(
      async (options: { providers?: string[] } | undefined) => {
        const provider = options?.providers?.[0];
        if (provider === "claude") {
          throw new Error("claude offline");
        }
        return {
          requestId: `recent-${provider ?? "all"}`,
          entries: [
            createProviderSessionEntry({
              providerId: provider ?? "custom-provider",
              providerHandleId: `${provider}-thread`,
              providerLabel: provider ?? "Custom",
              title: `Session ${provider}`,
            }),
          ],
        };
      },
    );
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: {
          supportsSnapshot: true,
          entries: [createSnapshotEntry("claude"), createSnapshotEntry("codex")],
        },
      },
    );

    await screen.findByText("Session codex");
    await screen.findByText("Could not load sessions for Claude Code.");
  });

  it("filters the merged list when a provider badge is selected and restores it on All", async () => {
    const fetchRecentProviderSessions = vi.fn(
      async (options: { providers?: string[] } | undefined) => {
        const provider = options?.providers?.[0] ?? "claude";
        return {
          requestId: `recent-${provider}`,
          entries: [
            createProviderSessionEntry({
              providerId: provider,
              providerLabel: provider === "claude" ? "Claude Code" : "Codex",
              providerHandleId: `${provider}-thread`,
              title: `Session ${provider}`,
              lastActivityAt:
                provider === "claude" ? "2026-04-30T09:00:00.000Z" : "2026-04-30T10:00:00.000Z",
            }),
          ],
        };
      },
    );
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: {
          supportsSnapshot: true,
          entries: [createSnapshotEntry("claude"), createSnapshotEntry("codex")],
        },
      },
    );

    await screen.findByText("Session claude");
    await screen.findByText("Session codex");

    fireEvent.click(screen.getByTestId("import-session-filter-trigger"));
    fireEvent.click(screen.getByTestId("import-session-filter-codex"));

    screen.getByText("Session codex");
    expect(screen.queryByText("Session claude")).toBeNull();

    fireEvent.click(screen.getByTestId("import-session-filter-trigger"));
    fireEvent.click(screen.getByTestId("import-session-filter-all"));

    screen.getByText("Session claude");
    screen.getByText("Session codex");
  });

  it("loads, merges, dedupes, and sorts the next page for a pagination-capable host", async () => {
    mockHostFeatures.importSessionPagination = true;
    const fetchRecentProviderSessions = vi.fn(
      async (options: { cursor?: string; providers?: string[] } | undefined) => {
        if (options?.cursor === "cursor-2") {
          return {
            requestId: "recent-codex-2",
            entries: [
              createProviderSessionEntry({
                providerId: "codex",
                providerLabel: "Codex",
                providerHandleId: "newest",
                title: "Newest session",
                lastActivityAt: "2026-04-30T12:00:00.000Z",
              }),
              createProviderSessionEntry({
                providerId: "codex",
                providerLabel: "Codex",
                providerHandleId: "duplicate",
                title: "Duplicate session",
                lastActivityAt: "2026-04-30T08:00:00.000Z",
              }),
            ],
            nextCursor: null,
          };
        }
        return {
          requestId: "recent-codex-1",
          entries: [
            createProviderSessionEntry({
              providerId: "codex",
              providerLabel: "Codex",
              providerHandleId: "middle",
              title: "Middle session",
              lastActivityAt: "2026-04-30T10:00:00.000Z",
            }),
            createProviderSessionEntry({
              providerId: "codex",
              providerLabel: "Codex",
              providerHandleId: "duplicate",
              title: "Duplicate session",
              lastActivityAt: "2026-04-30T09:00:00.000Z",
            }),
          ],
          nextCursor: "cursor-2",
        };
      },
    );

    renderSheet(createRecentSessionsClient(fetchRecentProviderSessions, vi.fn()), {
      snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("codex")] },
    });

    fireEvent.click(await screen.findByTestId("import-session-load-more"));

    await screen.findByText("Newest session");
    expect(fetchRecentProviderSessions).toHaveBeenNthCalledWith(2, {
      cwd: "/repo/paseo",
      providers: ["codex"],
      limit: 15,
      cursor: "cursor-2",
    });
    expect(screen.getAllByText("Duplicate session")).toHaveLength(1);
    const sheetText = screen.getByTestId("import-session-sheet").textContent ?? "";
    expect(sheetText.indexOf("Newest session")).toBeLessThan(sheetText.indexOf("Middle session"));
    expect(screen.queryByTestId("import-session-load-more")).toBeNull();
  });

  it("keeps successful provider pages and retries only failed providers", async () => {
    mockHostFeatures.importSessionPagination = true;
    let codexPageAttempts = 0;
    const fetchRecentProviderSessions = vi.fn(
      async (options: Parameters<DaemonClient["fetchRecentProviderSessions"]>[0]) => {
        const provider = options?.providers?.[0] ?? "claude";
        if (!options?.cursor) {
          return {
            requestId: `recent-${provider}-1`,
            entries: [
              createProviderSessionEntry({
                providerId: provider,
                providerLabel: provider === "claude" ? "Claude Code" : "Codex",
                providerHandleId: `${provider}-page-1`,
                title: `${provider} first page`,
              }),
            ],
            nextCursor: `${provider}-cursor-2`,
          };
        }
        if (provider === "codex") {
          codexPageAttempts += 1;
          if (codexPageAttempts === 1) {
            throw new Error("codex next page unavailable");
          }
          return {
            requestId: "recent-codex-2",
            entries: [
              createProviderSessionEntry({
                providerId: "codex",
                providerLabel: "Codex",
                providerHandleId: "codex-page-2",
                title: "Codex second page",
              }),
            ],
            nextCursor: null,
          };
        }
        if (options.cursor === "claude-cursor-3") {
          throw new Error("successful provider advanced during retry");
        }
        return {
          requestId: "recent-claude-2",
          entries: [
            createProviderSessionEntry({
              providerId: "claude",
              providerLabel: "Claude Code",
              providerHandleId: "claude-page-2",
              title: "Claude second page",
            }),
          ],
          nextCursor: "claude-cursor-3",
        };
      },
    );

    renderSheet(createRecentSessionsClient(fetchRecentProviderSessions, vi.fn()), {
      snapshot: {
        supportsSnapshot: true,
        entries: [createSnapshotEntry("claude"), createSnapshotEntry("codex")],
      },
    });

    await screen.findByText("claude first page");
    await screen.findByText("codex first page");
    fireEvent.click(screen.getByTestId("import-session-load-more"));

    await screen.findByText("Claude second page");
    await screen.findByText("Could not load recent sessions.");
    fireEvent.click(screen.getByTestId("import-session-load-more"));

    await screen.findByText("Codex second page");
    expect(
      fetchRecentProviderSessions.mock.calls.filter(
        ([options]) => options?.cursor === "claude-cursor-2",
      ),
    ).toHaveLength(1);
    expect(
      fetchRecentProviderSessions.mock.calls.filter(
        ([options]) => options?.cursor === "claude-cursor-3",
      ),
    ).toHaveLength(0);
    expect(
      fetchRecentProviderSessions.mock.calls.filter(
        ([options]) => options?.cursor === "codex-cursor-2",
      ),
    ).toHaveLength(2);
  });

  it("ignores pagination cursors from hosts without the pagination feature", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-codex",
      entries: [createProviderSessionEntry({ providerId: "codex", providerLabel: "Codex" })],
      nextCursor: "cursor-2",
    }));

    renderSheet(createRecentSessionsClient(fetchRecentProviderSessions, vi.fn()), {
      snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("codex")] },
    });

    await screen.findByText("Import me");
    expect(screen.queryByTestId("import-session-load-more")).toBeNull();
    expect(fetchRecentProviderSessions).toHaveBeenCalledTimes(1);
  });

  it("shows pending and retry states when loading the next page fails", async () => {
    mockHostFeatures.importSessionPagination = true;
    let rejectNextPage!: (error: Error) => void;
    const pendingNextPage = new Promise<never>((_resolve, reject) => {
      rejectNextPage = reject;
    });
    const fetchRecentProviderSessions = vi.fn(
      async (options: Parameters<DaemonClient["fetchRecentProviderSessions"]>[0]) => {
        if (!options?.cursor) {
          return {
            requestId: "recent-codex-1",
            entries: [createProviderSessionEntry({ providerId: "codex", providerLabel: "Codex" })],
            nextCursor: "cursor-2",
          };
        }
        if (fetchRecentProviderSessions.mock.calls.length === 2) {
          return await pendingNextPage;
        }
        return {
          requestId: "recent-codex-2",
          entries: [
            createProviderSessionEntry({
              providerId: "codex",
              providerLabel: "Codex",
              providerHandleId: "page-2",
              title: "Recovered session",
            }),
          ],
          nextCursor: null,
        };
      },
    );

    renderSheet(createRecentSessionsClient(fetchRecentProviderSessions, vi.fn()), {
      snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("codex")] },
    });

    fireEvent.click(await screen.findByTestId("import-session-load-more"));
    await screen.findByText("Loading...");
    rejectNextPage(new Error("next page unavailable"));

    await screen.findByText("Could not load recent sessions.");
    fireEvent.click(screen.getByTestId("import-session-load-more"));

    await screen.findByText("Recovered session");
    expect(fetchRecentProviderSessions).toHaveBeenNthCalledWith(3, {
      cwd: "/repo/paseo",
      providers: ["codex"],
      limit: 15,
      cursor: "cursor-2",
    });
  });

  it("refreshes from page one and discards accumulated pages", async () => {
    mockHostFeatures.importSessionPagination = true;
    let firstPageRequestCount = 0;
    const fetchRecentProviderSessions = vi.fn(
      async (options: Parameters<DaemonClient["fetchRecentProviderSessions"]>[0]) => {
        if (options?.cursor) {
          return {
            requestId: "recent-codex-2",
            entries: [
              createProviderSessionEntry({
                providerId: "codex",
                providerLabel: "Codex",
                providerHandleId: "page-2",
                title: "Second page session",
              }),
            ],
            nextCursor: null,
          };
        }
        firstPageRequestCount += 1;
        return {
          requestId: `recent-codex-first-${firstPageRequestCount}`,
          entries: [
            createProviderSessionEntry({
              providerId: "codex",
              providerLabel: "Codex",
              title: firstPageRequestCount === 1 ? "Original first page" : "Refreshed first page",
            }),
          ],
          nextCursor: firstPageRequestCount === 1 ? "cursor-2" : null,
        };
      },
    );

    renderSheet(createRecentSessionsClient(fetchRecentProviderSessions, vi.fn()), {
      snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("codex")] },
    });

    fireEvent.click(await screen.findByTestId("import-session-load-more"));
    await screen.findByText("Second page session");
    fireEvent.click(screen.getByTestId("import-session-refresh"));

    await screen.findByText("Refreshed first page");
    expect(screen.queryByText("Original first page")).toBeNull();
    expect(screen.queryByText("Second page session")).toBeNull();
    expect(fetchRecentProviderSessions).toHaveBeenNthCalledWith(3, {
      cwd: "/repo/paseo",
      providers: ["codex"],
      limit: 15,
    });
  });

  it("does not render filter badges when only one importable provider is enabled", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-codex",
      entries: [createProviderSessionEntry({ providerId: "codex", providerLabel: "Codex" })],
    }));
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: {
          supportsSnapshot: true,
          entries: [
            createSnapshotEntry("codex"),
            createSnapshotEntry("claude", { enabled: false }),
          ],
        },
      },
    );

    await waitFor(() => {
      expect(fetchRecentProviderSessions).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("import-session-filters")).toBeNull();
    expect(screen.queryByTestId("import-session-filter-all")).toBeNull();
  });

  it("shows a no-importable-providers message when snapshot has no enabled providers", async () => {
    const fetchRecentProviderSessions = vi.fn();
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: {
          supportsSnapshot: true,
          entries: [
            createSnapshotEntry("claude", { enabled: false }),
            createSnapshotEntry("codex", { enabled: false }),
            createSnapshotEntry("opencode", { enabled: false }),
            createSnapshotEntry("z-ai", { enabled: false }),
          ],
        },
      },
    );

    await screen.findByText("No importable providers are enabled.");
    expect(fetchRecentProviderSessions).not.toHaveBeenCalled();
  });

  it("omits cwd from host-wide fetches and renders each session cwd", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [
        createProviderSessionEntry({
          providerId: "claude",
          providerLabel: "Claude Code",
          cwd: "/home/me/work/other-project",
          title: "Cross-project session",
        }),
      ],
    }));
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        target: { kind: "host" },
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    await waitFor(() => {
      expect(fetchRecentProviderSessions).toHaveBeenCalledWith({
        providers: ["claude"],
        limit: 15,
      });
    });
    expect(fetchRecentProviderSessions).not.toHaveBeenCalledWith(
      expect.objectContaining({ cwd: expect.anything() }),
    );
    await screen.findByText("/home/me/work/other-project");
  });

  it("isolates host-wide session caches by server", async () => {
    const fetchServerOneSessions = vi.fn(async () => ({
      requestId: "server-one-sessions",
      entries: [
        createProviderSessionEntry({
          cwd: "/home/me/work/server-one-project",
          title: "Server one session",
        }),
      ],
    }));
    const fetchServerTwoSessions = vi.fn(async () => ({
      requestId: "server-two-sessions",
      entries: [
        createProviderSessionEntry({
          providerHandleId: "provider-thread-2",
          cwd: "/home/me/work/server-two-project",
          title: "Server two session",
        }),
      ],
    }));
    const importAgent = vi.fn();
    const serverOneClient = createRecentSessionsClient(fetchServerOneSessions, importAgent);
    const serverTwoClient = createRecentSessionsClient(fetchServerTwoSessions, importAgent);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
        mutations: { retry: false },
      },
    });
    mockSnapshot.current = {
      entries: [createSnapshotEntry("claude")],
      supportsSnapshot: true,
    };

    function TestSheet({
      serverId,
      client,
    }: {
      serverId: string;
      client: ReturnType<typeof createRecentSessionsClient>;
    }) {
      return (
        <QueryClientProvider client={queryClient}>
          <ImportSessionSheet
            visible
            client={client}
            serverId={serverId}
            target={HOST_TARGET}
            onClose={vi.fn()}
          />
        </QueryClientProvider>
      );
    }

    const { rerender } = render(<TestSheet serverId="server-1" client={serverOneClient} />);
    await screen.findByText("Server one session");

    rerender(<TestSheet serverId="server-2" client={serverTwoClient} />);

    await screen.findByText("Server two session");
    expect(screen.queryByText("Server one session")).toBeNull();
    expect(fetchServerOneSessions).toHaveBeenCalledTimes(1);
    expect(fetchServerTwoSessions).toHaveBeenCalledWith({
      providers: ["claude"],
      limit: 15,
    });
  });

  it("isolates project caches and clears failed pagination state when the target changes", async () => {
    mockHostFeatures.importSessionPagination = true;
    mockHostFeatures.importSessionProjectScope = true;
    const fetchRecentProviderSessions = vi.fn(
      async (options: Parameters<DaemonClient["fetchRecentProviderSessions"]>[0]) => {
        if (options?.projectId === "project-one" && options.cursor) {
          throw new Error("project one next page failed");
        }
        return {
          requestId: `recent-${options?.projectId}`,
          entries: [
            createProviderSessionEntry({
              providerHandleId: options?.projectId ?? "unknown",
              title: options?.projectId === "project-one" ? "Project one row" : "Project two row",
            }),
          ],
          nextCursor: options?.projectId === "project-one" ? "project-one-cursor" : null,
        };
      },
    );
    const client = createRecentSessionsClient(fetchRecentProviderSessions, vi.fn());
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
        mutations: { retry: false },
      },
    });
    mockSnapshot.current = {
      entries: [createSnapshotEntry("claude")],
      supportsSnapshot: true,
    };

    function TestSheet({ target }: { target: ImportSessionTarget }) {
      return (
        <QueryClientProvider client={queryClient}>
          <ImportSessionSheet
            visible
            client={client}
            serverId="server-1"
            target={target}
            onClose={vi.fn()}
          />
        </QueryClientProvider>
      );
    }

    const { rerender } = render(<TestSheet target={PROJECT_ONE_TARGET} />);
    await screen.findByText("Project one row");
    fireEvent.click(screen.getByTestId("import-session-load-more"));
    await screen.findByText("Could not load recent sessions.");

    rerender(<TestSheet target={PROJECT_TWO_TARGET} />);

    await screen.findByText("Project two row");
    expect(screen.queryByText("Project one row")).toBeNull();
    expect(screen.queryByText("Could not load recent sessions.")).toBeNull();
    expect(fetchRecentProviderSessions).toHaveBeenCalledWith({
      projectId: "project-two",
      providers: ["claude"],
      limit: 15,
    });
  });

  it("discards an in-flight pagination response after the project target changes", async () => {
    mockHostFeatures.importSessionPagination = true;
    mockHostFeatures.importSessionProjectScope = true;
    let resolveProjectOnePage!: (
      page: Awaited<ReturnType<DaemonClient["fetchRecentProviderSessions"]>>,
    ) => void;
    const projectOnePage = new Promise<
      Awaited<ReturnType<DaemonClient["fetchRecentProviderSessions"]>>
    >((resolve) => {
      resolveProjectOnePage = resolve;
    });
    const projectOnePageReturned = vi.fn();
    const fetchRecentProviderSessions = vi.fn(
      async (options: Parameters<DaemonClient["fetchRecentProviderSessions"]>[0]) => {
        if (options?.projectId === "project-one" && options.cursor) {
          const page = await projectOnePage;
          projectOnePageReturned();
          return page;
        }
        return {
          requestId: `recent-${options?.projectId}`,
          entries: [
            createProviderSessionEntry({
              providerHandleId: options?.projectId ?? "unknown",
              title: options?.projectId === "project-one" ? "Project one row" : "Project two row",
            }),
          ],
          nextCursor: options?.projectId === "project-one" ? "project-one-cursor" : null,
        };
      },
    );
    const client = createRecentSessionsClient(fetchRecentProviderSessions, vi.fn());
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
        mutations: { retry: false },
      },
    });
    mockSnapshot.current = {
      entries: [createSnapshotEntry("claude")],
      supportsSnapshot: true,
    };

    function TestSheet({ target }: { target: ImportSessionTarget }) {
      return (
        <QueryClientProvider client={queryClient}>
          <ImportSessionSheet
            visible
            client={client}
            serverId="server-1"
            target={target}
            onClose={vi.fn()}
          />
        </QueryClientProvider>
      );
    }

    const { rerender } = render(<TestSheet target={PROJECT_ONE_TARGET} />);
    await screen.findByText("Project one row");
    fireEvent.click(screen.getByTestId("import-session-load-more"));
    await screen.findByText("Loading...");

    rerender(<TestSheet target={PROJECT_TWO_TARGET} />);
    await screen.findByText("Project two row");
    resolveProjectOnePage({
      requestId: "stale-project-one-page",
      entries: [
        createProviderSessionEntry({
          providerHandleId: "stale-project-one",
          title: "Stale project one page",
        }),
      ],
      nextCursor: null,
    });

    await waitFor(() => expect(projectOnePageReturned).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(screen.queryByText("Stale project one page")).toBeNull();
    screen.getByText("Project two row");

    rerender(<TestSheet target={PROJECT_ONE_TARGET} />);
    await screen.findByText("Project one row");
    expect(screen.queryByText("Stale project one page")).toBeNull();
  });

  it("discards an in-flight host-wide page after the selected host changes", async () => {
    mockHostFeatures.importSessionPagination = true;
    let resolveServerOnePage!: (
      page: Awaited<ReturnType<DaemonClient["fetchRecentProviderSessions"]>>,
    ) => void;
    const serverOnePage = new Promise<
      Awaited<ReturnType<DaemonClient["fetchRecentProviderSessions"]>>
    >((resolve) => {
      resolveServerOnePage = resolve;
    });
    const serverOnePageReturned = vi.fn();
    const fetchServerOneSessions = vi.fn(
      async (options: Parameters<DaemonClient["fetchRecentProviderSessions"]>[0]) => {
        if (options?.cursor) {
          const page = await serverOnePage;
          serverOnePageReturned();
          return page;
        }
        return {
          requestId: "server-one-first-page",
          entries: [createProviderSessionEntry({ title: "Server one row" })],
          nextCursor: "server-one-cursor",
        };
      },
    );
    const fetchServerTwoSessions = vi.fn(async () => ({
      requestId: "server-two-first-page",
      entries: [
        createProviderSessionEntry({
          providerHandleId: "server-two",
          title: "Server two row",
        }),
      ],
      nextCursor: null,
    }));
    const serverOneClient = createRecentSessionsClient(fetchServerOneSessions, vi.fn());
    const serverTwoClient = createRecentSessionsClient(fetchServerTwoSessions, vi.fn());
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
        mutations: { retry: false },
      },
    });
    mockSnapshot.current = {
      entries: [createSnapshotEntry("claude")],
      supportsSnapshot: true,
    };

    function TestSheet({
      client,
      serverId,
    }: {
      client: ReturnType<typeof createRecentSessionsClient>;
      serverId: string;
    }) {
      return (
        <QueryClientProvider client={queryClient}>
          <ImportSessionSheet
            visible
            client={client}
            serverId={serverId}
            target={HOST_TARGET}
            onClose={vi.fn()}
          />
        </QueryClientProvider>
      );
    }

    const { rerender } = render(<TestSheet client={serverOneClient} serverId="server-1" />);
    await screen.findByText("Server one row");
    fireEvent.click(screen.getByTestId("import-session-load-more"));
    await screen.findByText("Loading...");

    rerender(<TestSheet client={serverTwoClient} serverId="server-2" />);
    await screen.findByText("Server two row");
    resolveServerOnePage({
      requestId: "stale-server-one-page",
      entries: [
        createProviderSessionEntry({
          providerHandleId: "stale-server-one",
          title: "Stale server one page",
        }),
      ],
      nextCursor: null,
    });

    await waitFor(() => expect(serverOnePageReturned).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(screen.queryByText("Stale server one page")).toBeNull();

    rerender(<TestSheet client={serverOneClient} serverId="server-1" />);
    await screen.findByText("Server one row");
    expect(screen.queryByText("Stale server one page")).toBeNull();
  });

  it("ignores a completed import after its server and project target change", async () => {
    mockHostFeatures.importSessionProjectScope = true;
    let resolveServerOneImport!: (agent: Awaited<ReturnType<DaemonClient["importAgent"]>>) => void;
    const serverOneImport = new Promise<Awaited<ReturnType<DaemonClient["importAgent"]>>>(
      (resolve) => {
        resolveServerOneImport = resolve;
      },
    );
    const serverOneImportReturned = vi.fn();
    const importOnServerOne = vi.fn(async () => {
      const agent = await serverOneImport;
      serverOneImportReturned();
      return agent;
    });
    const importOnServerTwo = vi.fn();
    const serverOneClient = createRecentSessionsClient(
      vi.fn(async () => ({
        requestId: "server-one-project",
        entries: [
          createProviderSessionEntry({
            providerId: "claude",
            providerHandleId: "server-one-project-row",
            title: "Server one project row",
          }),
        ],
      })),
      importOnServerOne,
    );
    const serverTwoClient = createRecentSessionsClient(
      vi.fn(async () => ({
        requestId: "server-two-project",
        entries: [
          createProviderSessionEntry({
            providerId: "claude",
            providerHandleId: "server-two-project-row",
            title: "Server two project row",
          }),
        ],
      })),
      importOnServerTwo,
    );
    const onClose = vi.fn();
    const onImported = vi.fn();
    const onImportedAgent = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    mockSnapshot.current = {
      entries: [createSnapshotEntry("claude")],
      supportsSnapshot: true,
    };

    function TestSheet({
      client,
      serverId,
      target,
    }: {
      client: ReturnType<typeof createRecentSessionsClient>;
      serverId: string;
      target: ImportSessionTarget;
    }) {
      return (
        <QueryClientProvider client={queryClient}>
          <ImportSessionSheet
            visible
            client={client}
            serverId={serverId}
            target={target}
            onClose={onClose}
            onImported={onImported}
            onImportedAgent={onImportedAgent}
          />
        </QueryClientProvider>
      );
    }

    const { rerender } = render(
      <TestSheet client={serverOneClient} serverId="server-1" target={PROJECT_ONE_TARGET} />,
    );
    fireEvent.click(
      await screen.findByTestId("import-session-session-claude-server-one-project-row"),
    );
    await waitFor(() => {
      expect(importOnServerOne).toHaveBeenCalledWith({
        providerId: "claude",
        providerHandleId: "server-one-project-row",
        cwd: "/repo/paseo",
        projectId: "project-one",
      });
    });

    rerender(
      <TestSheet client={serverTwoClient} serverId="server-2" target={PROJECT_TWO_TARGET} />,
    );
    await screen.findByText("Server two project row");
    resolveServerOneImport(createImportedAgentSnapshot("stale-import"));

    await waitFor(() => expect(serverOneImportReturned).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(onClose).not.toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
    expect(onImportedAgent).not.toHaveBeenCalled();
    expect(importOnServerTwo).not.toHaveBeenCalled();
    screen.getByText("Server two project row");
  });

  it("ignores a completed import after the target wrapper unmounts the sheet", async () => {
    mockHostFeatures.importSessionProjectScope = true;
    let resolveImport!: (agent: Awaited<ReturnType<DaemonClient["importAgent"]>>) => void;
    const pendingImport = new Promise<Awaited<ReturnType<DaemonClient["importAgent"]>>>(
      (resolve) => {
        resolveImport = resolve;
      },
    );
    const importReturned = vi.fn();
    const importAgent = vi.fn(async () => {
      const agent = await pendingImport;
      importReturned();
      return agent;
    });
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "project-before-unmount",
      entries: [
        createProviderSessionEntry({
          providerId: "claude",
          providerHandleId: "project-before-unmount",
          title: "Project row before unmount",
        }),
      ],
    }));
    const client = createRecentSessionsClient(fetchRecentProviderSessions, importAgent);
    const onClose = vi.fn();
    const onImported = vi.fn();
    const onImportedAgent = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
        mutations: { retry: false },
      },
    });
    mockSnapshot.current = {
      entries: [createSnapshotEntry("claude")],
      supportsSnapshot: true,
    };

    function TestSheet({ target }: { target: ImportSessionTarget | null }) {
      if (!target) return null;
      return (
        <ImportSessionSheet
          visible
          client={client}
          serverId="server-1"
          target={target}
          onClose={onClose}
          onImported={onImported}
          onImportedAgent={onImportedAgent}
        />
      );
    }

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <TestSheet target={PROJECT_ONE_TARGET} />
      </QueryClientProvider>,
    );
    fireEvent.click(
      await screen.findByTestId("import-session-session-claude-project-before-unmount"),
    );
    await waitFor(() => expect(importAgent).toHaveBeenCalledTimes(1));

    rerender(
      <QueryClientProvider client={queryClient}>
        <TestSheet target={null} />
      </QueryClientProvider>,
    );
    resolveImport(createImportedAgentSnapshot("stale-unmounted-import"));
    await waitFor(() => expect(importReturned).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));

    expect(onClose).not.toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
    expect(onImportedAgent).not.toHaveBeenCalled();

    rerender(
      <QueryClientProvider client={queryClient}>
        <TestSheet target={PROJECT_ONE_TARGET} />
      </QueryClientProvider>,
    );
    await screen.findByText("Project row before unmount");
    expect(fetchRecentProviderSessions).toHaveBeenCalledTimes(1);
  });

  it("ignores a completed page after the target wrapper unmounts the sheet", async () => {
    mockHostFeatures.importSessionPagination = true;
    mockHostFeatures.importSessionProjectScope = true;
    let resolvePage!: (
      page: Awaited<ReturnType<DaemonClient["fetchRecentProviderSessions"]>>,
    ) => void;
    const pendingPage = new Promise<
      Awaited<ReturnType<DaemonClient["fetchRecentProviderSessions"]>>
    >((resolve) => {
      resolvePage = resolve;
    });
    const pageReturned = vi.fn();
    const fetchRecentProviderSessions = vi.fn(
      async (options: Parameters<DaemonClient["fetchRecentProviderSessions"]>[0]) => {
        if (options?.cursor) {
          const page = await pendingPage;
          pageReturned();
          return page;
        }
        return {
          requestId: "page-before-unmount",
          entries: [
            createProviderSessionEntry({
              providerId: "claude",
              providerHandleId: "page-before-unmount",
              title: "First page before unmount",
            }),
          ],
          nextCursor: "page-before-unmount-cursor",
        };
      },
    );
    const client = createRecentSessionsClient(fetchRecentProviderSessions, vi.fn());
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
        mutations: { retry: false },
      },
    });
    mockSnapshot.current = {
      entries: [createSnapshotEntry("claude")],
      supportsSnapshot: true,
    };

    function TestSheet({ target }: { target: ImportSessionTarget | null }) {
      if (!target) return null;
      return (
        <ImportSessionSheet
          visible
          client={client}
          serverId="server-1"
          target={target}
          onClose={vi.fn()}
        />
      );
    }

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <TestSheet target={PROJECT_ONE_TARGET} />
      </QueryClientProvider>,
    );
    await screen.findByText("First page before unmount");
    fireEvent.click(screen.getByTestId("import-session-load-more"));
    await screen.findByText("Loading...");

    rerender(
      <QueryClientProvider client={queryClient}>
        <TestSheet target={null} />
      </QueryClientProvider>,
    );
    resolvePage({
      requestId: "stale-page-after-unmount",
      entries: [
        createProviderSessionEntry({
          providerId: "claude",
          providerHandleId: "stale-page-after-unmount",
          title: "Stale page after unmount",
        }),
      ],
      nextCursor: null,
    });
    await waitFor(() => expect(pageReturned).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));

    rerender(
      <QueryClientProvider client={queryClient}>
        <TestSheet target={PROJECT_ONE_TARGET} />
      </QueryClientProvider>,
    );
    await screen.findByText("First page before unmount");
    expect(screen.queryByText("Stale page after unmount")).toBeNull();
    expect(fetchRecentProviderSessions).toHaveBeenCalledTimes(2);
  });

  it("uses the session's cwd when importing from the host and fires onImported", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [
        createProviderSessionEntry({
          providerId: "claude",
          providerLabel: "Claude Code",
          cwd: "/home/me/work/other-project",
        }),
      ],
    }));
    const importAgent = vi.fn(async () => createImportedAgentSnapshot("agent-imported"));
    const onImported = vi.fn();
    const onImportedAgent = vi.fn();
    const onClose = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        target: { kind: "host" },
        onClose,
        onImported,
        onImportedAgent,
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    fireEvent.click(await screen.findByTestId("import-session-session-claude-provider-thread-1"));

    await waitFor(() => {
      expect(importAgent).toHaveBeenCalledWith({
        providerId: "claude",
        providerHandleId: "provider-thread-1",
        cwd: "/home/me/work/other-project",
      });
    });
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ id: "agent-imported" }));
    expect(onImportedAgent).toHaveBeenCalledWith("agent-imported");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("refetches sessions when the refresh button is clicked", async () => {
    const fetchRecentProviderSessions = vi.fn(async () => ({
      requestId: "recent-provider-sessions",
      entries: [
        createProviderSessionEntry({
          providerId: "claude",
          providerLabel: "Claude Code",
          title: "Refreshable session",
        }),
      ],
    }));
    const importAgent = vi.fn();

    renderSheet(
      { fetchRecentProviderSessions, importAgent } as Pick<
        DaemonClient,
        "fetchRecentProviderSessions" | "importAgent"
      >,
      {
        snapshot: { supportsSnapshot: true, entries: [createSnapshotEntry("claude")] },
      },
    );

    await screen.findByText("Refreshable session");
    expect(fetchRecentProviderSessions).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("import-session-refresh"));

    await waitFor(() => {
      expect(fetchRecentProviderSessions).toHaveBeenCalledTimes(2);
    });
  });
});
