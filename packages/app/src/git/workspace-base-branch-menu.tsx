import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SearchInput } from "@/components/ui/combobox";
import { filterBranches } from "@/git/workspace-base-branch-filter";
import {
  DropdownMenuHint,
  DropdownMenuItem,
  DropdownMenuSeparator,
  useDropdownMenuClose,
  useDropdownMenuPresentation,
} from "@/components/ui/dropdown-menu";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";

export interface WorkspaceBaseBranchMenuConfig {
  effectiveBaseBranch: string | null;
  baseBranchOverride: string | null;
  branches: string[];
  branchesError: string | null;
  branchesLoading: boolean;
  onRetryBranches: () => void;
  onSelect: (baseBranch: string | null) => Promise<void>;
}

interface WorkspaceBaseBranchControl {
  comparisonBaseRef: string | null | undefined;
  menuConfig: WorkspaceBaseBranchMenuConfig | undefined;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
}

interface PendingBaseBranchSelection {
  baseBranch: string | null;
}

export function formatWorkspaceBaseBranchLabel(baseBranch: string | null): string | null {
  if (!baseBranch) return null;
  return baseBranch.replace(/^refs\/(heads|remotes)\//, "").trim();
}

function resolveQueryError(error: Error | null, fallback: string): string | null {
  if (!error) return null;
  return error.message || fallback;
}

export function useWorkspaceBaseBranchControl(input: {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
}): WorkspaceBaseBranchControl {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(input.serverId);
  const isConnected = useHostRuntimeIsConnected(input.serverId);
  const supported = useSessionStore(
    (state) => state.sessions[input.serverId]?.serverInfo?.features?.workspaceBaseBranch === true,
  );
  const workspaceBaseBranch = useWorkspaceFields(
    input.serverId,
    input.workspaceId ?? null,
    (workspace) => ({
      baseBranch: workspace.baseBranch,
      baseBranchOverride: workspace.baseBranchOverride,
    }),
  );
  const comparisonBaseRef =
    supported && workspaceBaseBranch?.baseBranch !== undefined
      ? workspaceBaseBranch.baseBranch
      : undefined;
  const [menuOpen, setMenuOpen] = useState(false);
  const branchesQuery = useFetchQuery<string[]>({
    queryKey: ["workspaceBaseBranchSuggestions", input.serverId, input.workspaceId, input.cwd],
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const result = await client.getBranchSuggestions({ cwd: input.cwd, limit: 200 });
      if (result.error) {
        throw new Error(result.error);
      }
      return result.branches;
    },
    enabled: menuOpen && supported && Boolean(input.workspaceId) && Boolean(client) && isConnected,
    retry: false,
    staleTimeMs: 15_000,
    dataShape: "list",
  });
  const retryBranches = branchesQuery.refetch;
  const handleRetryBranches = useCallback(() => {
    void retryBranches();
  }, [retryBranches]);
  const handleSelect = useCallback(
    async (nextBaseBranch: string | null) => {
      if (!client || !input.workspaceId) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      await client.setWorkspaceBaseBranch(input.workspaceId, nextBaseBranch);
    },
    [client, input.workspaceId, t],
  );
  const menuConfig = useMemo<WorkspaceBaseBranchMenuConfig | undefined>(() => {
    if (!supported || !input.workspaceId || workspaceBaseBranch?.baseBranchOverride === undefined) {
      return undefined;
    }
    return {
      effectiveBaseBranch: comparisonBaseRef ?? null,
      baseBranchOverride: workspaceBaseBranch.baseBranchOverride,
      branches: branchesQuery.data ?? [],
      branchesError: resolveQueryError(
        branchesQuery.error,
        t("workspace.git.diff.baseBranch.loadFailed"),
      ),
      branchesLoading: branchesQuery.isPending || branchesQuery.isFetching,
      onRetryBranches: handleRetryBranches,
      onSelect: handleSelect,
    };
  }, [
    branchesQuery.data,
    branchesQuery.error,
    branchesQuery.isFetching,
    branchesQuery.isPending,
    comparisonBaseRef,
    handleRetryBranches,
    handleSelect,
    input.workspaceId,
    supported,
    t,
    workspaceBaseBranch,
  ]);

  return { comparisonBaseRef, menuConfig, menuOpen, setMenuOpen };
}

/**
 * Below this many branches the list fits without hunting, and a search field costs more attention
 * than it saves.
 */
const SEARCH_THRESHOLD = 8;

function BaseBranchOption({
  branch,
  selected,
  disabled,
  pending,
  pendingLabel,
  onSelect,
}: {
  branch: string;
  selected: boolean;
  disabled: boolean;
  pending: boolean;
  pendingLabel: string;
  onSelect: (branch: string) => void;
}) {
  const handleSelect = useCallback(() => onSelect(branch), [branch, onSelect]);
  return (
    <DropdownMenuItem
      selected={selected}
      showSelectedCheck
      closeOnSelect={false}
      disabled={disabled}
      status={pending ? "pending" : "idle"}
      pendingLabel={pendingLabel}
      testID={`changes-diff-base-branch-${branch}`}
      onSelect={handleSelect}
    >
      {branch}
    </DropdownMenuItem>
  );
}

function renderBranchOptions(input: {
  config: WorkspaceBaseBranchMenuConfig;
  branches: readonly string[];
  pendingSelection: PendingBaseBranchSelection | null;
  pendingLabel: string;
  loadingLabel: string;
  retryLabel: string;
  emptyLabel: string;
  onSelect: (branch: string) => void;
}): ReactNode {
  if (input.config.branchesLoading) {
    return <DropdownMenuItem disabled>{input.loadingLabel}</DropdownMenuItem>;
  }
  if (input.config.branchesError) {
    return (
      <>
        <DropdownMenuHint>{input.config.branchesError}</DropdownMenuHint>
        <DropdownMenuItem closeOnSelect={false} onSelect={input.config.onRetryBranches}>
          {input.retryLabel}
        </DropdownMenuItem>
      </>
    );
  }
  if (input.branches.length === 0) {
    return <DropdownMenuHint>{input.emptyLabel}</DropdownMenuHint>;
  }
  return input.branches.map((branch) => (
    <BaseBranchOption
      key={branch}
      branch={branch}
      selected={input.config.baseBranchOverride === branch}
      disabled={input.pendingSelection !== null && input.pendingSelection.baseBranch !== branch}
      pending={input.pendingSelection?.baseBranch === branch}
      pendingLabel={input.pendingLabel}
      onSelect={input.onSelect}
    />
  ));
}

export function WorkspaceBaseBranchMenuPage({ config }: { config: WorkspaceBaseBranchMenuConfig }) {
  const { t } = useTranslation();
  const closeMenu = useDropdownMenuClose();
  const presentation = useDropdownMenuPresentation();
  const [pendingSelection, setPendingSelection] = useState<PendingBaseBranchSelection | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const selectBaseBranch = useCallback(
    (baseBranch: string | null) => {
      if (pendingSelection !== null) return;
      setPendingSelection({ baseBranch });
      setSaveError(null);
      void config
        .onSelect(baseBranch)
        .then(closeMenu)
        .catch((error) => {
          setPendingSelection(null);
          setSaveError(
            error instanceof Error ? error.message : t("workspace.git.diff.baseBranch.saveFailed"),
          );
        });
    },
    [closeMenu, config, pendingSelection, t],
  );
  const selectRepositoryDefault = useCallback(() => selectBaseBranch(null), [selectBaseBranch]);
  const selectNamedBranch = useCallback(
    (branch: string) => selectBaseBranch(branch),
    [selectBaseBranch],
  );
  const isSaving = pendingSelection !== null;
  const visibleBranches = useMemo(
    () => filterBranches(config.branches, query),
    [config.branches, query],
  );
  const showSearch =
    !config.branchesLoading && !config.branchesError && config.branches.length >= SEARCH_THRESHOLD;
  const branchOptions = renderBranchOptions({
    config,
    branches: visibleBranches,
    pendingSelection,
    pendingLabel: t("workspace.git.diff.baseBranch.saving"),
    loadingLabel: t("workspace.git.diff.baseBranch.loadingBranches"),
    retryLabel: t("common.actions.retry"),
    emptyLabel: t("workspace.git.diff.baseBranch.noMatches"),
    onSelect: selectNamedBranch,
  });
  const repositoryDefaultLabel = t("workspace.git.diff.baseBranch.repositoryDefault");
  const showRepositoryDefault =
    !query.trim() || repositoryDefaultLabel.toLowerCase().includes(query.trim().toLowerCase());

  return (
    <>
      {showSearch ? (
        <SearchInput
          placeholder={t("workspace.git.diff.baseBranch.searchPlaceholder")}
          onChangeText={setQuery}
          // The sheet keeps its own keyboard-aware input, and autofocus fights the menu's
          // dismiss-keyboard-on-open.
          autoFocus={presentation === "popover"}
          useBottomSheetInput={presentation === "sheet"}
        />
      ) : null}
      {showRepositoryDefault ? (
        <>
          <DropdownMenuItem
            selected={config.baseBranchOverride === null}
            showSelectedCheck
            closeOnSelect={false}
            disabled={isSaving && pendingSelection?.baseBranch !== null}
            status={pendingSelection?.baseBranch === null ? "pending" : "idle"}
            pendingLabel={t("workspace.git.diff.baseBranch.saving")}
            description={
              config.baseBranchOverride === null
                ? (formatWorkspaceBaseBranchLabel(config.effectiveBaseBranch) ?? undefined)
                : undefined
            }
            testID="changes-diff-base-repository-default"
            onSelect={selectRepositoryDefault}
          >
            {repositoryDefaultLabel}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      ) : null}
      {branchOptions}
      {saveError ? <DropdownMenuHint>{saveError}</DropdownMenuHint> : null}
    </>
  );
}
