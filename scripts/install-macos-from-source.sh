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

for command_name in npm codesign ditto open osascript pgrep; do
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
stage_app="$stage_dir/Paseo.app"

cleanup_stage() {
  if [[ -n "${stage_dir:-}" && "$stage_dir" == "$install_dir"/.paseo-source-install.* ]]; then
    rm -rf -- "$stage_dir"
  fi
}
trap cleanup_stage EXIT

ditto "$built_app" "$stage_app"
codesign --verify --deep --strict --verbose=2 "$stage_app"

if pgrep -x Paseo >/dev/null 2>&1; then
  echo "Quitting the installed Paseo app before replacement"
  osascript -e 'tell application id "sh.paseo.desktop" to quit'

  for _ in {1..30}; do
    if ! pgrep -x Paseo >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done

  if pgrep -x Paseo >/dev/null 2>&1; then
    echo "Paseo did not quit. Quit it manually, then rerun the task." >&2
    exit 1
  fi
fi

backup_app=""
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
