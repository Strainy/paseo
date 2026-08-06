import { useCallback, useMemo, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Terminal } from "lucide-react-native";
import type { HostProfile } from "@/types/host-connection";
import { useHostMutations, useHosts } from "@/runtime/host-runtime";
import { Button } from "@/components/ui/button";
import { DaemonConnectionTestError } from "@/utils/test-daemon-connection";
import { AdaptiveModalSheet, AdaptiveTextInput, type SheetHeader } from "./adaptive-modal-sheet";

const FLEX_ONE_STYLE = { flex: 1 } as const;
const ThemedTerminal = withUnistyles(Terminal);

const styles = StyleSheet.create((theme) => ({
  helper: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  field: {
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
}));

interface RemoteSshDraft {
  host: string;
  port: string;
  identityFile: string;
}

type RemoteSshDraftAction =
  | { type: "host"; value: string }
  | { type: "port"; value: string }
  | { type: "identityFile"; value: string }
  | { type: "reset" };

const EMPTY_DRAFT: RemoteSshDraft = { host: "", port: "", identityFile: "" };

function reduceDraft(state: RemoteSshDraft, action: RemoteSshDraftAction): RemoteSshDraft {
  if (action.type === "reset") return EMPTY_DRAFT;
  return { ...state, [action.type]: action.value };
}

export interface AddRemoteSshHostModalProps {
  visible: boolean;
  onClose: () => void;
  onCancel?: () => void;
  onSaved?: (result: {
    profile: HostProfile;
    serverId: string;
    hostname: string | null;
    isNewHost: boolean;
  }) => void;
}

export function AddRemoteSshHostModal({
  visible,
  onClose,
  onCancel,
  onSaved,
}: AddRemoteSshHostModalProps) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const { probeAndUpsertRemoteSshConnection } = useHostMutations();
  const [draft, dispatch] = useReducer(reduceDraft, EMPTY_DRAFT);
  const [resetKey, bumpResetKey] = useReducer((value: number) => value + 1, 0);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const header = useMemo<SheetHeader>(() => ({ title: t("pairing.remoteSsh.title") }), [t]);

  const clear = useCallback(() => {
    dispatch({ type: "reset" });
    bumpResetKey();
    setErrorMessage("");
  }, []);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    clear();
    onClose();
  }, [clear, isSaving, onClose]);

  const handleCancel = useCallback(() => {
    if (isSaving) return;
    clear();
    (onCancel ?? onClose)();
  }, [clear, isSaving, onCancel, onClose]);

  const handleSave = useCallback(async () => {
    if (isSaving) return;
    const host = draft.host.trim();
    if (!host) {
      setErrorMessage(t("pairing.remoteSsh.errors.hostRequired"));
      return;
    }
    if (/\s/.test(host) || host.startsWith("-")) {
      setErrorMessage(t("pairing.remoteSsh.errors.invalidHost"));
      return;
    }
    const rawPort = draft.port.trim();
    const sshPort = rawPort ? Number(rawPort) : undefined;
    if (sshPort !== undefined && (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535)) {
      setErrorMessage(t("pairing.remoteSsh.errors.invalidPort"));
      return;
    }

    try {
      setIsSaving(true);
      setErrorMessage("");
      const result = await probeAndUpsertRemoteSshConnection({
        host,
        ...(sshPort !== undefined ? { sshPort } : {}),
        ...(draft.identityFile.trim() ? { identityFile: draft.identityFile.trim() } : {}),
      });
      onSaved?.({
        ...result,
        isNewHost: !hosts.some((profile) => profile.serverId === result.serverId),
      });
      clear();
      onClose();
    } catch (error) {
      const message =
        error instanceof DaemonConnectionTestError
          ? t("pairing.remoteSsh.errors.failedToConnect", { detail: error.message })
          : t("common.errors.unableToSave");
      setErrorMessage(message);
    } finally {
      setIsSaving(false);
    }
  }, [clear, draft, hosts, isSaving, onClose, onSaved, probeAndUpsertRemoteSshConnection, t]);

  const handleSubmit = useCallback(() => void handleSave(), [handleSave]);
  const handleHostChange = useCallback((value: string) => dispatch({ type: "host", value }), []);
  const handlePortChange = useCallback((value: string) => dispatch({ type: "port", value }), []);
  const handleIdentityFileChange = useCallback(
    (value: string) => dispatch({ type: "identityFile", value }),
    [],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleClose}
      testID="add-remote-ssh-host-modal"
    >
      <Text style={styles.helper}>{t("pairing.remoteSsh.helper")}</Text>

      <View style={styles.field}>
        <Text style={styles.label}>{t("pairing.remoteSsh.fields.host")}</Text>
        <AdaptiveTextInput
          testID="remote-ssh-host-input"
          initialValue={draft.host}
          resetKey={`remote-ssh-host-${resetKey}`}
          onChangeText={handleHostChange}
          placeholder="user@example.com"
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSaving}
          returnKeyType="next"
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>{t("pairing.remoteSsh.fields.port")}</Text>
        <AdaptiveTextInput
          testID="remote-ssh-port-input"
          initialValue={draft.port}
          resetKey={`remote-ssh-port-${resetKey}`}
          onChangeText={handlePortChange}
          placeholder={t("pairing.remoteSsh.fields.optional")}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="number-pad"
          editable={!isSaving}
          returnKeyType="next"
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>{t("pairing.remoteSsh.fields.identityFile")}</Text>
        <AdaptiveTextInput
          testID="remote-ssh-identity-input"
          initialValue={draft.identityFile}
          resetKey={`remote-ssh-identity-${resetKey}`}
          onChangeText={handleIdentityFileChange}
          placeholder={t("pairing.remoteSsh.fields.optional")}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSaving}
          returnKeyType="done"
          onSubmitEditing={handleSubmit}
        />
        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
      </View>

      <View style={styles.actions}>
        <Button
          style={FLEX_ONE_STYLE}
          variant="secondary"
          onPress={handleCancel}
          disabled={isSaving}
        >
          {t("pairing.remoteSsh.actions.cancel")}
        </Button>
        <Button
          style={FLEX_ONE_STYLE}
          onPress={handleSubmit}
          disabled={isSaving}
          leftIcon={ThemedTerminal}
          testID="remote-ssh-submit"
        >
          {isSaving
            ? t("pairing.remoteSsh.actions.connecting")
            : t("pairing.remoteSsh.actions.connect")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}
