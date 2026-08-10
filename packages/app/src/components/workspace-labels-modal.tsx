import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { Trash2 } from "lucide-react-native";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useAppSettings } from "@/hooks/use-settings";
import { useSessionStore } from "@/stores/session-store";
import { useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { Theme } from "@/styles/theme";
import {
  filterWorkspaceLabelSuggestions,
  mergeWorkspaceLabelSuggestions,
  normalizeWorkspaceLabels,
  recordRecentWorkspaceLabels,
  resolveWorkspaceLabelDraftLabels,
} from "@/workspace/workspace-labels";

export interface WorkspaceLabelsModalProps {
  visible: boolean;
  serverId?: string;
  initialLabels: readonly string[];
  onClose: () => void;
  onSubmit: (labels: string[]) => Promise<void> | void;
  testID?: string;
}

const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const ThemedTrash2 = withUnistyles(Trash2);

function selectKnownWorkspaceLabels(
  state: ReturnType<typeof useSessionStore.getState>,
  serverId: string | undefined,
): string[] {
  const labels = new Set<string>();
  for (const workspace of state.sessions[serverId ?? ""]?.workspaces.values() ?? []) {
    for (const label of workspace.labels ?? []) {
      const normalized = label.trim();
      if (normalized) labels.add(normalized);
    }
  }
  return Array.from(labels).sort((left, right) => left.localeCompare(right));
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function WorkspaceLabelOption({
  label,
  selected,
  disabled,
  first,
  onToggle,
  onDelete,
  testID,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  first: boolean;
  onToggle: (label: string) => void;
  onDelete?: (label: string) => void;
  testID?: string;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const handlePress = useCallback(() => onToggle(label), [label, onToggle]);
  const handleDelete = useCallback(() => onDelete?.(label), [label, onDelete]);
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);
  const accessibilityState = useMemo(() => ({ checked: selected, disabled }), [disabled, selected]);
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.optionSelect,
      (hovered || pressed) && styles.optionRowActive,
    ],
    [hovered],
  );

  return (
    <View style={[styles.optionRow, !first && styles.optionRowBorder, disabled && styles.disabled]}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={label}
        accessibilityState={accessibilityState}
        disabled={disabled}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
        onPress={handlePress}
        style={rowStyle}
        testID={testID}
      >
        <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
          {selected ? <Text style={styles.checkmark}>✓</Text> : null}
        </View>
        <Text style={styles.optionLabel} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
      {onDelete ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("sidebar.workspace.labels.deleteAccessibility", { label })}
          disabled={disabled}
          onPress={handleDelete}
          style={styles.deleteButton}
          testID={testID ? `${testID}-delete` : undefined}
        >
          <ThemedTrash2 size={16} uniProps={destructiveColorMapping} />
        </Pressable>
      ) : null}
    </View>
  );
}

function AddLabelsOption({
  labels,
  first,
  disabled,
  onPress,
  testID,
}: {
  labels: readonly string[];
  first: boolean;
  disabled: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.addOptionRow,
      !first && styles.optionRowBorder,
      (hovered || pressed) && styles.optionRowActive,
      disabled && styles.disabled,
    ],
    [disabled, first, hovered],
  );

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      onPress={onPress}
      style={rowStyle}
      testID={testID}
    >
      <View style={styles.checkbox}>
        <Text style={styles.addIcon}>+</Text>
      </View>
      <Text style={styles.optionLabel} numberOfLines={1}>
        {t("sidebar.workspace.labels.create", { labels: labels.join(", ") })}
      </Text>
    </Pressable>
  );
}

export function WorkspaceLabelsModal({
  visible,
  serverId,
  initialLabels,
  onClose,
  onSubmit,
  testID,
}: WorkspaceLabelsModalProps) {
  const { t } = useTranslation();
  const {
    settings: { workspaceLabelHistory },
    updateSettings,
  } = useAppSettings();
  const supportsLabelDeletion = useHostFeature(serverId ?? "", "workspaceLabelDeletion");
  const selectHostLabels = useCallback(
    (state: ReturnType<typeof useSessionStore.getState>) =>
      selectKnownWorkspaceLabels(state, serverId),
    [serverId],
  );
  const knownLabels = useStoreWithEqualityFn(useSessionStore, selectHostLabels, stringArraysEqual);
  const normalizedInitialLabels = useMemo(
    () => normalizeWorkspaceLabels(initialLabels),
    [initialLabels],
  );
  const initialLabelsKey = normalizedInitialLabels.join("\u0000");
  const [selectedLabels, setSelectedLabels] = useState(normalizedInitialLabels);
  const [searchQuery, setSearchQuery] = useState("");
  const [inputResetKey, setInputResetKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [deletingLabel, setDeletingLabel] = useState<string | null>(null);
  const [deletedLabels, setDeletedLabels] = useState<Set<string>>(() => new Set());
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!visible) return;
    setSelectedLabels(normalizedInitialLabels);
    setSearchQuery("");
    setInputResetKey((value) => value + 1);
    setError(null);
    setIsPending(false);
    setDeletingLabel(null);
    setDeletedLabels(new Set());
    const timeout = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timeout);
  }, [initialLabelsKey, normalizedInitialLabels, visible]);

  const suggestions = useMemo(
    () =>
      mergeWorkspaceLabelSuggestions({
        recentLabels: workspaceLabelHistory,
        selectedLabels,
        knownLabels,
      }).filter((label) => !deletedLabels.has(label)),
    [deletedLabels, knownLabels, selectedLabels, workspaceLabelHistory],
  );
  const filteredSuggestions = useMemo(
    () => filterWorkspaceLabelSuggestions(suggestions, searchQuery),
    [searchQuery, suggestions],
  );
  const draftLabels = useMemo(
    () => resolveWorkspaceLabelDraftLabels(searchQuery, suggestions),
    [searchQuery, suggestions],
  );
  const labelsToAdd = useMemo(
    () => draftLabels.filter((label) => !selectedLabels.includes(label)),
    [draftLabels, selectedLabels],
  );

  const handleToggleLabel = useCallback((label: string) => {
    setSelectedLabels((current) =>
      current.includes(label) ? current.filter((value) => value !== label) : [...current, label],
    );
    setError(null);
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    setError(null);
  }, []);

  const isBusy = isPending || deletingLabel !== null;

  const handleDeleteLabel = useCallback(
    async (label: string) => {
      if (!serverId || !supportsLabelDeletion || isBusy) return;
      const confirmed = await confirmDialog({
        title: t("sidebar.workspace.labels.deleteTitle"),
        message: t("sidebar.workspace.labels.deleteMessage", { label }),
        confirmLabel: t("sidebar.workspace.labels.deleteConfirm"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!confirmed) return;

      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) {
        setError(t("sidebar.workspace.toasts.hostDisconnected"));
        return;
      }

      setDeletingLabel(label);
      setError(null);
      try {
        await client.deleteWorkspaceLabel(label);
        setDeletedLabels((current) => new Set(current).add(label));
        setSelectedLabels((current) => current.filter((candidate) => candidate !== label));
        try {
          await updateSettings({
            workspaceLabelHistory: workspaceLabelHistory.filter((candidate) => candidate !== label),
          });
        } catch (historyError) {
          console.error(
            "[WorkspaceLabels] Failed to remove deleted label from history:",
            historyError,
          );
        }
      } catch (deleteError) {
        setError(
          deleteError instanceof Error && deleteError.message
            ? deleteError.message
            : t("sidebar.workspace.labels.deleteFailed"),
        );
      } finally {
        setDeletingLabel(null);
      }
    },
    [isBusy, serverId, supportsLabelDeletion, t, updateSettings, workspaceLabelHistory],
  );

  const handleAddDraftLabels = useCallback(() => {
    if (labelsToAdd.length === 0 || isBusy) return;
    setSelectedLabels((current) => normalizeWorkspaceLabels([...current, ...labelsToAdd]));
    setSearchQuery("");
    setInputResetKey((value) => value + 1);
    setError(null);
  }, [isBusy, labelsToAdd]);

  const handleCancel = useCallback(() => {
    if (!isBusy) onClose();
  }, [isBusy, onClose]);

  const handleSubmit = useCallback(async () => {
    if (isBusy || stringArraysEqual(selectedLabels, normalizedInitialLabels)) return;
    try {
      setIsPending(true);
      await onSubmit(selectedLabels);
      const nextHistory = recordRecentWorkspaceLabels(workspaceLabelHistory, selectedLabels);
      try {
        await updateSettings({ workspaceLabelHistory: nextHistory });
      } catch (historyError) {
        console.error("[WorkspaceLabels] Failed to save recent labels:", historyError);
      }
      setIsPending(false);
      onClose();
    } catch (submitError) {
      setIsPending(false);
      setError(
        submitError instanceof Error && submitError.message
          ? submitError.message
          : t("common.errors.unableToSave"),
      );
    }
  }, [
    isBusy,
    normalizedInitialLabels,
    onClose,
    onSubmit,
    selectedLabels,
    t,
    updateSettings,
    workspaceLabelHistory,
  ]);

  const handleSubmitVoid = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);
  const sheetHeader = useMemo<SheetHeader>(
    () => ({ title: t("sidebar.workspace.labels.title") }),
    [t],
  );
  const submitDisabled = isBusy || stringArraysEqual(selectedLabels, normalizedInitialLabels);
  const showCreateOption = searchQuery.trim().length > 0 && labelsToAdd.length > 0;
  const showEmpty = filteredSuggestions.length === 0 && !showCreateOption;
  const sheetFooter = useMemo(
    () => (
      <View style={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          style={styles.actionButton}
          onPress={handleCancel}
          disabled={isBusy}
          testID={testID ? `${testID}-cancel` : undefined}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          size="sm"
          style={styles.actionButton}
          onPress={handleSubmitVoid}
          disabled={submitDisabled}
          testID={testID ? `${testID}-submit` : undefined}
        >
          {isPending ? t("renameModal.saving") : t("sidebar.workspace.labels.submit")}
        </Button>
      </View>
    ),
    [handleCancel, handleSubmitVoid, isBusy, isPending, submitDisabled, t, testID],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={handleCancel}
      header={sheetHeader}
      footer={sheetFooter}
      testID={testID}
    >
      <View style={styles.body}>
        <AdaptiveTextInput
          ref={inputRef}
          initialValue=""
          resetKey={inputResetKey}
          onChangeText={handleSearchChange}
          placeholder={t("sidebar.workspace.labels.inputPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isBusy}
          onSubmitEditing={handleAddDraftLabels}
          style={styles.input}
          testID={testID ? `${testID}-input` : undefined}
        />
        <View style={styles.labelList}>
          {filteredSuggestions.map((label, index) => (
            <WorkspaceLabelOption
              key={label}
              label={label}
              selected={selectedLabels.includes(label)}
              disabled={isBusy}
              first={index === 0}
              onToggle={handleToggleLabel}
              onDelete={supportsLabelDeletion ? handleDeleteLabel : undefined}
              testID={testID ? `${testID}-option-${label}` : undefined}
            />
          ))}
          {showCreateOption ? (
            <AddLabelsOption
              labels={labelsToAdd}
              first={filteredSuggestions.length === 0}
              disabled={isBusy}
              onPress={handleAddDraftLabels}
              testID={testID ? `${testID}-create` : undefined}
            />
          ) : null}
          {showEmpty ? (
            <Text style={styles.emptyText}>{t("sidebar.workspace.labels.noMatches")}</Text>
          ) : null}
        </View>
        {error ? (
          <Text style={styles.errorText} testID={testID ? `${testID}-error` : undefined}>
            {error}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  input: {
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  labelList: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
  },
  optionRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.surface1,
  },
  optionSelect: {
    minHeight: 44,
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  addOptionRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  optionRowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  optionRowActive: {
    backgroundColor: theme.colors.surface2,
  },
  deleteButton: {
    width: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  checkboxSelected: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  checkmark: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.xs,
    lineHeight: 14,
  },
  addIcon: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 16,
  },
  optionLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[4],
    textAlign: "center",
  },
  disabled: {
    opacity: theme.opacity[50],
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionButton: {
    flex: 1,
  },
}));
