#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Build, smoke-test, and install Paseo.app from this checkout.

Usage:
  mise run install:macos

Environment:
  PASEO_MACOS_INSTALL_DIR  Application directory (default: /Applications)
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 0 ]]; then
  usage >&2
  exit 2
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "install:macos can only run on macOS." >&2
  exit 1
fi

for command_name in node npm codesign ditto open osascript pgrep; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command not found: $command_name" >&2
    exit 1
  fi
done

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
install_dir="${PASEO_MACOS_INSTALL_DIR:-/Applications}"
target_app="$install_dir/Paseo.app"

if [[ "$install_dir" != /* || ! -d "$install_dir" ]]; then
  echo "PASEO_MACOS_INSTALL_DIR must be an existing absolute directory: $install_dir" >&2
  exit 1
fi

cleanup_stage() {
  if [[ -n "${stage_dir:-}" && "$stage_dir" == "$install_dir"/.paseo-source-install.* ]]; then
    rm -rf -- "$stage_dir"
  fi
}

paseo_app_running() {
  # macOS pgrep skips its own ancestors unless -a is set, which hides the app
  # from a run inside a Paseo agent or terminal.
  pgrep -ax Paseo >/dev/null 2>&1
}

paseo_app_is_ancestor() {
  local pid="$$" ppid name
  while [[ "$pid" -gt 1 ]]; do
    read -r ppid name < <(ps -o ppid=,ucomm= -p "$pid") || return 1
    if [[ "$name" == "Paseo" ]]; then
      return 0
    fi
    pid="$ppid"
  done
  return 1
}

replace_installed_app() {
  local stage_app="$stage_dir/Paseo.app"

  if paseo_app_running; then
    echo "Quitting the installed Paseo app before replacement"
    osascript -e 'tell application id "sh.paseo.desktop" to quit'

    # Paseo stops its built-in daemon before it exits, which can take ~25s.
    for _ in {1..120}; do
      if ! paseo_app_running; then
        break
      fi
      sleep 0.5
    done

    if paseo_app_running; then
      echo "Paseo did not quit. Quit it manually, then rerun the task." >&2
      exit 1
    fi
  fi

  local backup_app=""
  if [[ -e "$target_app" ]]; then
    backup_app="$HOME/.Trash/Paseo previous $(date +%Y%m%d-%H%M%S)-$$.app"
    mkdir -p "$HOME/.Trash"
    echo "Moving the previous app to $backup_app"
    mv "$target_app" "$backup_app"
  fi

  if ! mv "$stage_app" "$target_app"; then
    if [[ -n "$backup_app" && -e "$backup_app" && ! -e "$target_app" ]]; then
      mv "$backup_app" "$target_app"
    fi
    echo "Failed to install Paseo.app into $install_dir" >&2
    exit 1
  fi

  rmdir "$stage_dir"
  trap - EXIT

  echo "Installed $target_app"
  if [[ -n "$backup_app" ]]; then
    echo "The previous app is recoverable from $backup_app"
  fi

  open "$target_app"
  echo "Opened Paseo"
}

# Set only for the detached handoff below.
if [[ -n "${PASEO_MACOS_INSTALL_STAGE_DIR:-}" ]]; then
  stage_dir="$PASEO_MACOS_INSTALL_STAGE_DIR"
  if [[ "$stage_dir" != "$install_dir"/.paseo-source-install.* || ! -d "$stage_dir/Paseo.app" ]]; then
    echo "Unexpected staged app directory: $stage_dir" >&2
    exit 1
  fi
  trap cleanup_stage EXIT
  echo "$(date '+%Y-%m-%d %H:%M:%S') Installing $stage_dir/Paseo.app"
  replace_installed_app
  exit 0
fi

for dependency_command in tsc cross-env expo electron-builder; do
  if [[ ! -x "$repo_root/node_modules/.bin/$dependency_command" ]]; then
    echo "Dependencies are missing or incomplete. Run mise exec -- npm ci before this task." >&2
    exit 1
  fi
done

if [[ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" == "1" ]]; then
  electron_arch="arm64"
  app_output_dir="mac-arm64"
else
  electron_arch="x64"
  app_output_dir="mac"
fi

built_app="$repo_root/packages/desktop/release/$app_output_dir/Paseo.app"

echo "Building Paseo.app for $electron_arch from $repo_root"
(
  cd "$repo_root"
  PASEO_DESKTOP_SMOKE=1 \
    CSC_IDENTITY_AUTO_DISCOVERY=false \
    npm run build:desktop -- \
      --mac \
      "--$electron_arch" \
      --dir \
      -c.mac.notarize=false \
      -c.mac.hardenedRuntime=false
)

if [[ ! -d "$built_app" ]]; then
  echo "Desktop build did not produce $built_app" >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$built_app"

stage_dir="$(mktemp -d "$install_dir/.paseo-source-install.XXXXXX")"
trap cleanup_stage EXIT

ditto "$built_app" "$stage_dir/Paseo.app"
codesign --verify --deep --strict --verbose=2 "$stage_dir/Paseo.app"

if paseo_app_is_ancestor; then
  # Quitting Paseo stops its built-in daemon, which ends the agent or terminal
  # running this task. Finish from a new session outside Paseo's process tree.
  handoff_log="$HOME/Library/Logs/Paseo/source-install.log"
  mkdir -p "$(dirname -- "$handoff_log")"
  PASEO_MACOS_INSTALL_STAGE_DIR="$stage_dir" node -e '
    const { spawn } = require("node:child_process");
    const { openSync } = require("node:fs");
    const log = openSync(process.argv[2], "a");
    spawn(process.argv[1], { detached: true, stdio: ["ignore", log, log] }).unref();
  ' "$repo_root/scripts/install-macos-from-source.sh" "$handoff_log"
  trap - EXIT
  echo "This task runs inside Paseo. Paseo will quit, install the new app, and reopen."
  echo "Installer log: $handoff_log"
  exit 0
fi

replace_installed_app
