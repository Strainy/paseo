import type { FetchRecentProviderSessionEntry } from "@getpaseo/client/internal/daemon-client";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { i18n } from "@/i18n/i18next";

export const PER_PROVIDER_LIMIT = 15;
export const ALL_FILTER_VALUE = "__all__";

export function requiresImportSessionsHostUpgrade(input: {
  supportsSnapshot: boolean;
  targetKind: "host" | "project" | "workspace";
  supportsProjectScope: boolean;
  supportsWorkspaceTarget: boolean;
}): boolean {
  if (!input.supportsSnapshot) return true;
  if (input.targetKind === "project") return !input.supportsProjectScope;
  if (input.targetKind === "workspace") return !input.supportsWorkspaceTarget;
  return false;
}

export interface SessionsPageData {
  entries: FetchRecentProviderSessionEntry[];
  filteredAlreadyImportedCount?: number;
  nextCursor?: string | null;
}

export interface SessionsQueryResult {
  data: SessionsPageData | undefined;
  isError: boolean;
  isLoading: boolean;
  isPending: boolean;
}

function dedupeAndSortSessionEntries(
  entryGroups: ReadonlyArray<ReadonlyArray<FetchRecentProviderSessionEntry>>,
): FetchRecentProviderSessionEntry[] {
  const seen = new Set<string>();
  const collected: FetchRecentProviderSessionEntry[] = [];
  for (const entries of entryGroups) {
    for (const entry of entries) {
      const key = `${entry.providerId}:${entry.providerHandleId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(entry);
    }
  }
  collected.sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );
  return collected;
}

export function mergeSessionPages<T extends SessionsPageData>(
  current: SessionsPageData,
  next: T,
): T {
  const hasFilteredCount =
    current.filteredAlreadyImportedCount !== undefined ||
    next.filteredAlreadyImportedCount !== undefined;
  return {
    ...next,
    entries: dedupeAndSortSessionEntries([current.entries, next.entries]),
    ...(hasFilteredCount
      ? {
          filteredAlreadyImportedCount:
            (current.filteredAlreadyImportedCount ?? 0) + (next.filteredAlreadyImportedCount ?? 0),
        }
      : {}),
  };
}

export interface NextPageTarget {
  provider: AgentProvider;
  cursor: string;
}

export function collectNextPageTargets(input: {
  supportsPagination: boolean;
  selectedProvider: string;
  providers: readonly AgentProvider[];
  queries: ReadonlyArray<SessionsQueryResult>;
}): NextPageTarget[] {
  if (!input.supportsPagination) return [];

  const targets: NextPageTarget[] = [];
  for (let index = 0; index < input.providers.length; index++) {
    const provider = input.providers[index];
    if (input.selectedProvider !== ALL_FILTER_VALUE && provider !== input.selectedProvider) {
      continue;
    }
    const cursor = input.queries[index]?.data?.nextCursor;
    if (typeof cursor === "string" && cursor.length > 0) {
      targets.push({ provider, cursor });
    }
  }
  return targets;
}

export function resolveProvidersToFetch(
  supportsSnapshot: boolean,
  snapshotEntries: ReadonlyArray<{ provider: string; enabled?: boolean }> | undefined,
): AgentProvider[] | null {
  // COMPAT(providersSnapshot): the import-recent-sessions feature ships alongside
  // providersSnapshot (v0.1.48, 2026-04-05). Daemons older than that lack both —
  // we render an "update host" empty state instead of degrading. Drop this gate
  // when the supported daemon floor is >= v0.1.48 (target: 2026-10-05).
  if (!supportsSnapshot) return null;
  if (!snapshotEntries) return null;
  return snapshotEntries.filter((entry) => entry.enabled !== false).map((entry) => entry.provider);
}

export function buildProviderLabelMap(
  snapshotEntries: ReadonlyArray<{ provider: string; label?: string }> | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!snapshotEntries) return map;
  for (const entry of snapshotEntries) {
    if (entry.label) {
      map.set(entry.provider, entry.label);
    }
  }
  return map;
}

export function aggregateSessionEntries(
  queries: ReadonlyArray<SessionsQueryResult>,
): FetchRecentProviderSessionEntry[] {
  return dedupeAndSortSessionEntries(
    queries.flatMap((query) => (query.data ? [query.data.entries] : [])),
  );
}

export function sumFilteredAlreadyImportedCount(
  queries: ReadonlyArray<SessionsQueryResult>,
): number {
  let total = 0;
  for (const query of queries) {
    total += query.data?.filteredAlreadyImportedCount ?? 0;
  }
  return total;
}

export function collectErroredProviderLabels(
  providersToFetch: AgentProvider[] | null,
  queries: ReadonlyArray<SessionsQueryResult>,
  providerLabelById: ReadonlyMap<string, string>,
): string[] {
  if (providersToFetch === null) return [];
  const labels: string[] = [];
  for (let index = 0; index < queries.length; index++) {
    if (queries[index]?.isError) {
      const provider = providersToFetch[index];
      labels.push(providerLabelById.get(provider) ?? provider);
    }
  }
  return labels;
}

export function getSessionTitle(entry: FetchRecentProviderSessionEntry): string {
  const title = entry.title?.trim();
  if (title) {
    return title;
  }
  const firstPromptPreview = entry.firstPromptPreview?.trim();
  if (firstPromptPreview) {
    return firstPromptPreview;
  }
  return i18n.t("importSession.preview.untitledSession");
}

export function getPromptPreview(entry: FetchRecentProviderSessionEntry): string {
  return (
    entry.lastPromptPreview?.trim() ||
    entry.firstPromptPreview?.trim() ||
    i18n.t("importSession.preview.noPrompt")
  );
}

export interface EmptyStateInputs {
  isLoadingSessions: boolean;
  allQueriesErrored: boolean;
  isQueryingProviders: boolean;
  allQueriesSettled: boolean;
  selectedProvider: string;
  aggregatedCount: number;
  visibleCount: number;
  totalAlreadyImportedCount: number;
  providerLabelById: ReadonlyMap<string, string>;
}

export function computeEmptyState(input: EmptyStateInputs): {
  showEmptyState: boolean;
  emptyStateTitle: string;
} {
  const showEmptyState =
    !input.isLoadingSessions &&
    !input.allQueriesErrored &&
    input.isQueryingProviders &&
    input.allQueriesSettled &&
    input.visibleCount === 0;
  if (!showEmptyState) {
    return { showEmptyState, emptyStateTitle: "" };
  }
  const isFilteredEmpty = input.selectedProvider !== ALL_FILTER_VALUE && input.aggregatedCount > 0;
  if (isFilteredEmpty) {
    const label = input.providerLabelById.get(input.selectedProvider) ?? input.selectedProvider;
    return {
      showEmptyState,
      emptyStateTitle: i18n.t("importSession.empty.noProviderSessions", { provider: label }),
    };
  }
  if (input.totalAlreadyImportedCount > 0) {
    return {
      showEmptyState,
      emptyStateTitle: i18n.t("importSession.empty.alreadyImported"),
    };
  }
  return { showEmptyState, emptyStateTitle: i18n.t("importSession.empty.noRecent") };
}
