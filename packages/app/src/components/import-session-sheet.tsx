import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, type PressableStateCallbackType, Text, View } from "react-native";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  DaemonClient,
  FetchRecentProviderSessionEntry,
} from "@getpaseo/client/internal/daemon-client";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { ChevronDown, Inbox, Layers, RotateCw } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { getProviderIcon } from "@/components/provider-icons";
import { formatTimeAgo } from "@/utils/time";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostFeature } from "@/runtime/host-features";
import { i18n } from "@/i18n/i18next";
import {
  aggregateSessionEntries,
  ALL_FILTER_VALUE,
  buildProviderLabelMap,
  collectNextPageTargets,
  collectErroredProviderLabels,
  computeEmptyState,
  getPromptPreview,
  getSessionTitle,
  mergeSessionPages,
  type NextPageTarget,
  PER_PROVIDER_LIMIT,
  resolveProvidersToFetch,
  requiresImportSessionsHostUpgrade,
  sumFilteredAlreadyImportedCount,
} from "@/components/import-session-sheet-view-model";

const IMPORT_SHEET_SNAP_POINTS = ["70%", "92%"];
const DISABLED_ACCESSIBILITY_STATE = { disabled: true };

type RecentProviderSessionsClient = Pick<
  DaemonClient,
  "fetchRecentProviderSessions" | "importAgent"
>;

type ImportedAgent = Awaited<ReturnType<RecentProviderSessionsClient["importAgent"]>>;

export type ImportSessionTarget =
  | { kind: "host" }
  | { kind: "workspace"; cwd: string; workspaceId: string }
  | { kind: "project"; projectId: string; providerContextCwd: string };

interface ImportSessionSheetProps {
  visible: boolean;
  client: RecentProviderSessionsClient | null;
  serverId: string | null;
  target: ImportSessionTarget;
  onClose: () => void;
  onImportedAgent?: (agentId: string) => void;
  onImported?: (agent: ImportedAgent) => void;
}

type RecentSessionsResponse = Awaited<
  ReturnType<RecentProviderSessionsClient["fetchRecentProviderSessions"]>
>;

interface SessionsQueryConfig {
  queryKey: ReadonlyArray<string | null>;
  enabled: boolean;
  queryFn: () => Promise<RecentSessionsResponse>;
}

interface LoadMoreTarget extends NextPageTarget {
  queryKey: ReadonlyArray<string | null>;
}

interface LoadMoreVariables {
  client: RecentProviderSessionsClient;
  generation: number;
  requestScope: SessionsRequestScope;
  scopeKey: string;
  targets: LoadMoreTarget[];
}

interface SessionsRequestScope {
  cwd?: string;
  projectId?: string;
}

interface ImportSessionVariables {
  client: RecentProviderSessionsClient | null;
  entry: FetchRecentProviderSessionEntry;
  generation: number;
  scopeKey: string;
  target: ImportSessionTarget;
}

function requireTargetValue(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new Error(`Import session ${label} must not be empty`);
  }
  return value;
}

function getProviderContextCwd(target: ImportSessionTarget): string | undefined {
  if (target.kind === "workspace") return requireTargetValue(target.cwd, "workspace cwd");
  if (target.kind === "project") {
    return requireTargetValue(target.providerContextCwd, "provider context cwd");
  }
  return undefined;
}

function getSessionsRequestScope(target: ImportSessionTarget): SessionsRequestScope {
  if (target.kind === "workspace") {
    return { cwd: requireTargetValue(target.cwd, "workspace cwd") };
  }
  if (target.kind === "project") {
    return { projectId: requireTargetValue(target.projectId, "project id") };
  }
  return {};
}

function getTargetQueryParts(target: ImportSessionTarget): readonly string[] {
  if (target.kind === "workspace") return [target.kind, target.workspaceId, target.cwd];
  if (target.kind === "project") {
    return [target.kind, target.projectId, target.providerContextCwd];
  }
  return [target.kind];
}

function getImportPlacement(target: ImportSessionTarget): {
  projectId?: string;
  workspaceId?: string;
} {
  if (target.kind === "workspace") {
    return { workspaceId: requireTargetValue(target.workspaceId, "workspace id") };
  }
  if (target.kind === "project") {
    return { projectId: requireTargetValue(target.projectId, "project id") };
  }
  return {};
}

interface LoadedPage {
  page: RecentSessionsResponse;
  target: LoadMoreTarget;
}

interface FailedPage {
  error: unknown;
  target: LoadMoreTarget;
}

interface LoadMoreResult {
  failedPages: FailedPage[];
  generation: number;
  loadedPages: LoadedPage[];
  scopeKey: string;
}

function isCurrentPaginationScope(
  value: { generation: number; scopeKey: string } | null | undefined,
  generation: number,
  scopeKey: string,
): boolean {
  return value?.generation === generation && value.scopeKey === scopeKey;
}

function hasCurrentLoadMoreError(input: {
  failedTargetCount: number;
  generation: number;
  isError: boolean;
  scopeKey: string;
  variables: LoadMoreVariables | undefined;
}): boolean {
  if (input.failedTargetCount > 0) return true;
  if (!input.isError) return false;
  return isCurrentPaginationScope(input.variables, input.generation, input.scopeKey);
}

function buildSessionsQueriesConfig(args: {
  providersToFetch: AgentProvider[] | null;
  sessionsQueryRoot: ReadonlyArray<string | null>;
  visible: boolean;
  client: RecentProviderSessionsClient | null;
  requestScope: SessionsRequestScope;
  hostDisconnectedMessage?: string;
}): SessionsQueryConfig[] {
  const {
    providersToFetch,
    sessionsQueryRoot,
    visible,
    client,
    requestScope,
    hostDisconnectedMessage,
  } = args;
  if (providersToFetch === null) return [];
  const enabled = visible && Boolean(client);
  return providersToFetch.map((provider) => ({
    queryKey: [...sessionsQueryRoot, provider],
    enabled,
    queryFn: async () => {
      if (!client) {
        throw new Error(hostDisconnectedMessage ?? i18n.t("workspace.terminal.hostDisconnected"));
      }
      return await client.fetchRecentProviderSessions({
        ...requestScope,
        providers: [provider],
        limit: PER_PROVIDER_LIMIT,
      });
    },
  }));
}

interface SheetStatusMessagesProps {
  isClientReady: boolean;
  isSnapshotUnsupported: boolean;
  hasNoImportableProviders: boolean;
  isLoadingSessions: boolean;
  hasRows: boolean;
  allQueriesErrored: boolean;
  erroredProviderLabels: ReadonlyArray<string>;
  importError: Error | null;
}

function SheetStatusMessages({
  isClientReady,
  isSnapshotUnsupported,
  hasNoImportableProviders,
  isLoadingSessions,
  hasRows,
  allQueriesErrored,
  erroredProviderLabels,
  importError,
}: SheetStatusMessagesProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  if (!isClientReady) {
    return <Text style={styles.statusText}>{t("importSession.status.connectHost")}</Text>;
  }
  if (isSnapshotUnsupported) {
    return <Text style={styles.statusText}>{t("importSession.status.updateHost")}</Text>;
  }
  return (
    <>
      {hasNoImportableProviders ? (
        <Text style={styles.statusText}>{t("importSession.status.noProviders")}</Text>
      ) : null}
      {isLoadingSessions && !hasRows ? (
        <View style={styles.statusRow}>
          <LoadingSpinner color={theme.colors.foregroundMuted} />
          <Text style={styles.statusText}>{t("importSession.status.loading")}</Text>
        </View>
      ) : null}
      {allQueriesErrored ? (
        <Text style={styles.statusText}>{t("importSession.status.failedAll")}</Text>
      ) : null}
      {!allQueriesErrored && erroredProviderLabels.length > 0 ? (
        <Text style={styles.statusText}>
          {t("importSession.status.failedProviders", {
            providers: erroredProviderLabels.join(", "),
          })}
        </Text>
      ) : null}
      {importError ? (
        <>
          <Text style={styles.statusText}>{t("importSession.status.failedImport")}</Text>
          <Text style={styles.statusText}>{importError.message}</Text>
        </>
      ) : null}
    </>
  );
}

function RefreshAction({ isRefreshing, onPress }: { isRefreshing: boolean; onPress: () => void }) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const pressableStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.refreshButton,
      pressed && styles.refreshButtonPressed,
    ],
    [],
  );
  return (
    <Pressable
      onPress={onPress}
      disabled={isRefreshing}
      accessibilityLabel={t("importSession.actions.refresh")}
      accessibilityRole="button"
      testID="import-session-refresh"
      style={pressableStyle}
    >
      <View style={styles.refreshIconSlot}>
        {isRefreshing ? (
          <LoadingSpinner color={theme.colors.foregroundMuted} />
        ) : (
          <RotateCw size={16} color={theme.colors.foregroundMuted} />
        )}
      </View>
    </Pressable>
  );
}

function SheetEmptyState({ title }: { title: string }) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.emptyState} testID="import-session-empty-state">
      <View style={styles.emptyStateIcon}>
        <Inbox size={theme.iconSize.lg} color={theme.colors.foregroundMuted} strokeWidth={1.5} />
      </View>
      <Text style={styles.emptyStateTitle}>{title}</Text>
    </View>
  );
}

function LoadMoreFooter({
  hasError,
  isLoading,
  isRefreshing,
  onPress,
}: {
  hasError: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  let actionLabel = t("sessions.actions.loadMore");
  if (isLoading) {
    actionLabel = t("common.loading");
  } else if (hasError) {
    actionLabel = t("common.actions.retry");
  }
  return (
    <View style={styles.loadMoreFooter}>
      {hasError ? (
        <Text style={styles.statusText}>{t("importSession.status.failedAll")}</Text>
      ) : null}
      <Button
        variant="ghost"
        onPress={onPress}
        disabled={isRefreshing}
        loading={isLoading}
        testID="import-session-load-more"
      >
        {actionLabel}
      </Button>
    </View>
  );
}

function ImportSessionSheetRow({
  entry,
  disabled,
  importing,
  showCwd,
  onImportSession,
}: {
  entry: FetchRecentProviderSessionEntry;
  disabled: boolean;
  importing: boolean;
  showCwd: boolean;
  onImportSession: (entry: FetchRecentProviderSessionEntry) => void;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const title = getSessionTitle(entry);
  const promptPreview = getPromptPreview(entry);
  const lastActivity = formatTimeAgo(new Date(entry.lastActivityAt));
  const ProviderIcon = getProviderIcon(entry.providerId);
  const accessibilityState = useMemo(
    () => (disabled ? DISABLED_ACCESSIBILITY_STATE : undefined),
    [disabled],
  );
  const handlePress = useCallback(() => {
    onImportSession(entry);
  }, [entry, onImportSession]);
  const pressableStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      Boolean(hovered) && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [],
  );

  return (
    <Pressable
      disabled={disabled}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      style={pressableStyle}
      testID={`import-session-session-${entry.providerId}-${entry.providerHandleId}`}
    >
      <View style={styles.rowIconWrap}>
        <ProviderIcon size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
      </View>
      <View style={styles.rowContent}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.rowMeta}>
            {importing ? t("importSession.row.importing") : lastActivity}
          </Text>
        </View>
        <Text style={styles.rowPreview} numberOfLines={2}>
          {promptPreview}
        </Text>
        {showCwd && entry.cwd ? (
          <Text style={styles.rowCwd} numberOfLines={1}>
            {entry.cwd}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export function ImportSessionSheet({
  visible,
  client,
  serverId,
  target: importTarget,
  onClose,
  onImportedAgent,
  onImported,
}: ImportSessionSheetProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { theme } = useUnistyles();

  const providerContextCwd = getProviderContextCwd(importTarget);
  const requestScope = useMemo<SessionsRequestScope>(
    () => getSessionsRequestScope(importTarget),
    [importTarget],
  );
  const targetQueryParts = useMemo(() => getTargetQueryParts(importTarget), [importTarget]);
  const operationScopeKey = JSON.stringify([serverId, ...targetQueryParts]);
  const currentOperationScopeKeyRef = useRef(operationScopeKey);
  currentOperationScopeKeyRef.current = operationScopeKey;
  const paginationGenerationRef = useRef(0);
  const importGenerationRef = useRef(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      paginationGenerationRef.current += 1;
      importGenerationRef.current += 1;
    };
  }, []);

  const { entries: snapshotEntries, supportsSnapshot } = useProvidersSnapshot(serverId, {
    cwd: providerContextCwd,
    enabled: visible,
  });
  const supportsWorkspaceTarget = useHostFeature(serverId, "importSessionWorkspaceTarget");
  const supportsProjectScope = useHostFeature(serverId, "importSessionProjectScope");
  const supportsPagination = useHostFeature(serverId, "importSessionPagination");
  const requiresHostUpgrade = requiresImportSessionsHostUpgrade({
    supportsSnapshot,
    targetKind: importTarget.kind,
    supportsProjectScope,
    supportsWorkspaceTarget,
  });

  const providersToFetch = useMemo(
    () => (requiresHostUpgrade ? null : resolveProvidersToFetch(supportsSnapshot, snapshotEntries)),
    [requiresHostUpgrade, supportsSnapshot, snapshotEntries],
  );

  const providerLabelById = useMemo(
    () => buildProviderLabelMap(snapshotEntries),
    [snapshotEntries],
  );

  const sessionsQueryRoot = useMemo(
    () => ["recent-provider-sessions", serverId, ...targetQueryParts] as const,
    [serverId, targetQueryParts],
  );

  const queriesConfig = useMemo(
    () =>
      buildSessionsQueriesConfig({
        providersToFetch,
        sessionsQueryRoot,
        visible,
        client,
        requestScope,
        hostDisconnectedMessage: t("workspace.terminal.hostDisconnected"),
      }),
    [providersToFetch, sessionsQueryRoot, visible, client, requestScope, t],
  );

  const queries = useQueries({ queries: queriesConfig });

  const aggregatedEntries = useMemo(() => aggregateSessionEntries(queries), [queries]);
  const totalAlreadyImportedCount = useMemo(
    () => sumFilteredAlreadyImportedCount(queries),
    [queries],
  );

  const filterProviders = useMemo(() => [...(providersToFetch ?? [])].sort(), [providersToFetch]);

  const [selectedProvider, setSelectedProvider] = useState<string>(ALL_FILTER_VALUE);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const filterAnchorRef = useRef<View>(null);

  useEffect(() => {
    if (
      !visible ||
      (selectedProvider !== ALL_FILTER_VALUE && !filterProviders.includes(selectedProvider))
    ) {
      setSelectedProvider(ALL_FILTER_VALUE);
    }
  }, [visible, filterProviders, selectedProvider]);

  const visibleEntries = useMemo(() => {
    if (selectedProvider === ALL_FILTER_VALUE) return aggregatedEntries;
    return aggregatedEntries.filter((entry) => entry.providerId === selectedProvider);
  }, [aggregatedEntries, selectedProvider]);

  const nextPageTargets = useMemo(
    () =>
      collectNextPageTargets({
        supportsPagination,
        selectedProvider,
        providers: providersToFetch ?? [],
        queries,
      }),
    [providersToFetch, queries, selectedProvider, supportsPagination],
  );

  const loadMoreMutation = useMutation({
    mutationFn: async ({
      client: requestClient,
      generation,
      requestScope: nextPageRequestScope,
      scopeKey,
      targets,
    }: LoadMoreVariables): Promise<LoadMoreResult> => {
      const settledPages = await Promise.allSettled(
        targets.map((target) =>
          requestClient.fetchRecentProviderSessions({
            ...nextPageRequestScope,
            providers: [target.provider],
            limit: PER_PROVIDER_LIMIT,
            cursor: target.cursor,
          }),
        ),
      );
      const loadedPages: LoadedPage[] = [];
      const failedPages: FailedPage[] = [];
      for (let index = 0; index < settledPages.length; index++) {
        const result = settledPages[index];
        const target = targets[index];
        if (result.status === "fulfilled") {
          loadedPages.push({ page: result.value, target });
        } else {
          failedPages.push({ error: result.reason, target });
        }
      }
      return { failedPages, generation, loadedPages, scopeKey };
    },
    onSuccess: (result) => {
      if (
        !isMountedRef.current ||
        result.generation !== paginationGenerationRef.current ||
        result.scopeKey !== currentOperationScopeKeyRef.current
      ) {
        return;
      }
      for (const { page, target } of result.loadedPages) {
        queryClient.setQueryData<RecentSessionsResponse>(target.queryKey, (current) =>
          current ? mergeSessionPages(current, page) : page,
        );
      }
    },
  });

  const activeLoadMoreResult = isCurrentPaginationScope(
    loadMoreMutation.data,
    paginationGenerationRef.current,
    operationScopeKey,
  )
    ? loadMoreMutation.data
    : null;
  const failedLoadMoreTargets = useMemo(
    () => activeLoadMoreResult?.failedPages.map((failure) => failure.target) ?? [],
    [activeLoadMoreResult],
  );
  const hasLoadMoreError = hasCurrentLoadMoreError({
    failedTargetCount: failedLoadMoreTargets.length,
    generation: paginationGenerationRef.current,
    isError: loadMoreMutation.isError,
    scopeKey: operationScopeKey,
    variables: loadMoreMutation.variables,
  });

  const previousPaginationScopeKeyRef = useRef(operationScopeKey);
  useEffect(() => {
    if (previousPaginationScopeKeyRef.current === operationScopeKey) return;
    previousPaginationScopeKeyRef.current = operationScopeKey;
    paginationGenerationRef.current += 1;
    loadMoreMutation.reset();
  }, [loadMoreMutation, operationScopeKey]);

  const handleLoadMore = useCallback(() => {
    if (!client || loadMoreMutation.isPending) return;
    const targets =
      failedLoadMoreTargets.length > 0
        ? failedLoadMoreTargets
        : nextPageTargets.map((target) => ({
            ...target,
            queryKey: [...sessionsQueryRoot, target.provider],
          }));
    if (targets.length === 0) return;
    loadMoreMutation.mutate({
      client,
      generation: paginationGenerationRef.current,
      requestScope,
      scopeKey: operationScopeKey,
      targets,
    });
  }, [
    client,
    failedLoadMoreTargets,
    loadMoreMutation,
    nextPageTargets,
    operationScopeKey,
    requestScope,
    sessionsQueryRoot,
  ]);

  const filterComboboxOptions = useMemo<ComboboxOption[]>(
    () => [
      { id: ALL_FILTER_VALUE, label: t("importSession.filters.all") },
      ...filterProviders.map((provider) => ({
        id: provider,
        label: providerLabelById.get(provider) ?? provider,
      })),
    ],
    [filterProviders, providerLabelById, t],
  );

  const selectedProviderLabel = useMemo(
    () =>
      filterComboboxOptions.find((opt) => opt.id === selectedProvider)?.label ??
      t("importSession.filters.all"),
    [filterComboboxOptions, selectedProvider, t],
  );

  const handleFilterOpen = useCallback(() => setIsFilterOpen(true), []);

  const filterTriggerStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.filterTrigger,
      Boolean(hovered) && styles.filterTriggerHovered,
      pressed && styles.filterTriggerPressed,
    ],
    [],
  );

  const handleFilterSelect = useCallback(
    (id: string) => {
      setSelectedProvider(id);
      setIsFilterOpen(false);
      loadMoreMutation.reset();
    },
    [loadMoreMutation],
  );

  const filterOptionIcons = useMemo(() => {
    const map = new Map<string, React.ReactNode>();
    map.set(ALL_FILTER_VALUE, <Layers size={14} color={theme.colors.foregroundMuted} />);
    for (const provider of filterProviders) {
      const ProviderIcon = getProviderIcon(provider);
      map.set(provider, <ProviderIcon size={14} color={theme.colors.foregroundMuted} />);
    }
    return map;
  }, [filterProviders, theme.colors.foregroundMuted]);

  const renderFilterOption = useCallback(
    ({
      option,
      selected,
      active,
      onPress,
    }: {
      option: ComboboxOption;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => (
      <ComboboxItem
        label={option.label}
        selected={selected}
        active={active}
        onPress={onPress}
        leadingSlot={filterOptionIcons.get(option.id)}
      />
    ),
    [filterOptionIcons],
  );

  const importMutation = useMutation({
    mutationFn: async (variables: ImportSessionVariables) => {
      if (!variables.client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      if (!variables.entry.cwd) {
        throw new Error("Session is missing a working directory");
      }
      return await variables.client.importAgent({
        providerId: variables.entry.providerId,
        providerHandleId: variables.entry.providerHandleId,
        cwd: variables.entry.cwd,
        ...getImportPlacement(variables.target),
      });
    },
    onSuccess: async (agent, variables) => {
      if (
        !isMountedRef.current ||
        !isCurrentPaginationScope(
          variables,
          importGenerationRef.current,
          currentOperationScopeKeyRef.current,
        )
      ) {
        return;
      }
      paginationGenerationRef.current += 1;
      loadMoreMutation.reset();
      await queryClient.resetQueries({ queryKey: sessionsQueryRoot });
      if (
        !isMountedRef.current ||
        !isCurrentPaginationScope(
          variables,
          importGenerationRef.current,
          currentOperationScopeKeyRef.current,
        )
      ) {
        return;
      }
      onClose();
      onImportedAgent?.(agent.id);
      onImported?.(agent);
    },
  });

  const previousImportScopeKeyRef = useRef(operationScopeKey);
  useEffect(() => {
    if (previousImportScopeKeyRef.current === operationScopeKey) return;
    previousImportScopeKeyRef.current = operationScopeKey;
    importGenerationRef.current += 1;
    importMutation.reset();
  }, [importMutation, operationScopeKey]);

  const isCurrentImportMutation = isCurrentPaginationScope(
    importMutation.variables,
    importGenerationRef.current,
    operationScopeKey,
  );
  const importingSessionKey =
    importMutation.isPending && importMutation.variables && isCurrentImportMutation
      ? `${importMutation.variables.entry.providerId}:${importMutation.variables.entry.providerHandleId}`
      : null;

  const handleImportSession = useCallback(
    (entry: FetchRecentProviderSessionEntry) => {
      importMutation.mutate({
        client,
        entry,
        generation: importGenerationRef.current,
        scopeKey: operationScopeKey,
        target: importTarget,
      });
    },
    [client, importMutation, importTarget, operationScopeKey],
  );

  const erroredProviderLabels = useMemo(
    () => collectErroredProviderLabels(providersToFetch, queries, providerLabelById),
    [queries, providersToFetch, providerLabelById],
  );

  const isRefreshing = queries.some((query) => query.isFetching);

  const handleRefresh = useCallback(() => {
    paginationGenerationRef.current += 1;
    loadMoreMutation.reset();
    void queryClient.resetQueries({ queryKey: sessionsQueryRoot });
  }, [loadMoreMutation, queryClient, sessionsQueryRoot]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("importSession.title"),
      actions: <RefreshAction isRefreshing={isRefreshing} onPress={handleRefresh} />,
    }),
    [isRefreshing, handleRefresh, t],
  );

  const isSnapshotUnsupported = requiresHostUpgrade;
  const isWaitingForSnapshot = supportsSnapshot && snapshotEntries === undefined;
  const hasNoImportableProviders = providersToFetch !== null && providersToFetch.length === 0;
  const isQueryingProviders = queries.length > 0;
  const isLoadingSessions =
    isWaitingForSnapshot ||
    (isQueryingProviders && queries.some((query) => query.isLoading || query.isPending));
  const allQueriesErrored = isQueryingProviders && queries.every((query) => query.isError);
  const allQueriesSettled =
    isQueryingProviders && queries.every((query) => !query.isLoading && !query.isPending);
  const { showEmptyState, emptyStateTitle } = computeEmptyState({
    isLoadingSessions,
    allQueriesErrored,
    isQueryingProviders,
    allQueriesSettled,
    selectedProvider,
    aggregatedCount: aggregatedEntries.length,
    visibleCount: visibleEntries.length,
    totalAlreadyImportedCount,
    providerLabelById,
  });
  const showFilter = filterProviders.length > 1;

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      testID="import-session-sheet"
      desktopMaxWidth={560}
      snapPoints={IMPORT_SHEET_SNAP_POINTS}
    >
      {showFilter ? (
        <View ref={filterAnchorRef} collapsable={false} style={styles.filterTriggerWrap}>
          <Pressable
            onPress={handleFilterOpen}
            style={filterTriggerStyle}
            testID="import-session-filter-trigger"
            accessibilityRole="button"
            accessibilityLabel={`Filter: ${selectedProviderLabel}`}
          >
            {selectedProvider === ALL_FILTER_VALUE ? (
              <Layers size={14} color={theme.colors.foregroundMuted} />
            ) : (
              (() => {
                const ProviderIcon = getProviderIcon(selectedProvider);
                return <ProviderIcon size={14} color={theme.colors.foregroundMuted} />;
              })()
            )}
            <Text style={styles.filterTriggerText} numberOfLines={1}>
              {selectedProviderLabel}
            </Text>
            <ChevronDown size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
          <Combobox
            options={filterComboboxOptions}
            value={selectedProvider}
            onSelect={handleFilterSelect}
            renderOption={renderFilterOption}
            searchable={false}
            title="Filter by provider"
            open={isFilterOpen}
            onOpenChange={setIsFilterOpen}
            anchorRef={filterAnchorRef}
            desktopPlacement="bottom-start"
            desktopPreventInitialFlash
          />
        </View>
      ) : null}
      <SheetStatusMessages
        isClientReady={Boolean(client)}
        isSnapshotUnsupported={isSnapshotUnsupported}
        hasNoImportableProviders={hasNoImportableProviders}
        isLoadingSessions={isLoadingSessions}
        hasRows={visibleEntries.length > 0}
        allQueriesErrored={allQueriesErrored}
        erroredProviderLabels={erroredProviderLabels}
        importError={isCurrentImportMutation ? importMutation.error : null}
      />
      {visibleEntries.length > 0 ? (
        <View style={styles.list}>
          {visibleEntries.map((entry) => (
            <ImportSessionSheetRow
              key={`${entry.providerId}:${entry.providerHandleId}`}
              entry={entry}
              disabled={importMutation.isPending && isCurrentImportMutation}
              importing={importingSessionKey === `${entry.providerId}:${entry.providerHandleId}`}
              showCwd={importTarget.kind !== "workspace"}
              onImportSession={handleImportSession}
            />
          ))}
        </View>
      ) : null}
      {nextPageTargets.length > 0 || failedLoadMoreTargets.length > 0 ? (
        <LoadMoreFooter
          hasError={hasLoadMoreError}
          isLoading={loadMoreMutation.isPending}
          isRefreshing={isRefreshing}
          onPress={handleLoadMore}
        />
      ) : null}
      {showEmptyState ? <SheetEmptyState title={emptyStateTitle} /> : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  filterTriggerWrap: {
    paddingBottom: theme.spacing[2],
  },
  filterTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    alignSelf: "flex-start",
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  filterTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  filterTriggerPressed: {
    backgroundColor: theme.colors.surface3,
  },
  filterTriggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  list: {
    gap: theme.spacing[1],
  },
  loadMoreFooter: {
    alignItems: "center",
    gap: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    marginHorizontal: -theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  rowIconWrap: {
    width: theme.iconSize.md,
    paddingTop: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  rowTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  rowMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  rowPreview: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  rowCwd: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[8],
    paddingHorizontal: theme.spacing[4],
  },
  emptyStateIcon: {
    opacity: 0.6,
    marginBottom: theme.spacing[1],
  },
  emptyStateTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  refreshButton: {
    padding: theme.spacing[2],
    marginRight: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
  },
  refreshButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  refreshIconSlot: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
}));
