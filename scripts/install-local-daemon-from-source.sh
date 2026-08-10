#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Build and install the standalone Paseo daemon from this checkout on this machine.

Usage:
  mise run install:local-daemon

Environment:
  PASEO_PASSWORD  Required when daemon auth is configured

The task bootstraps the current npm prefix when no Paseo CLI is installed. Use
install:macos for the desktop-managed daemon.
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

for command_name in node npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command not found: $command_name" >&2
    exit 1
  fi
done

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -d "$repo_root/node_modules" ]]; then
  echo "Dependencies are not installed. Run npm ci before this task." >&2
  exit 1
fi

npm_root="$(npm root -g)"
paseo_cli="$npm_root/@getpaseo/cli/bin/paseo"
source_cli="$repo_root/packages/cli/bin/paseo"

echo "Checking local prerequisites"
echo "Node:  $(command -v node) ($(node --version))"
echo "npm:   $(command -v npm) ($(npm --version))"
if [[ -x "$paseo_cli" ]]; then
  echo "Paseo: $paseo_cli ($("$paseo_cli" --version))"
else
  echo "Paseo: not installed in the current npm prefix; bootstrapping $paseo_cli"
fi

daemon_identity() {
  node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const status = JSON.parse(input);
      if (status.desktopManaged !== false) {
        const message = status.desktopManaged === true
          ? "install:local-daemon cannot replace a desktop-managed daemon. Use install:macos."
          : "Paseo CLI did not report daemon ownership.";
        console.error(message);
        process.exit(1);
      }

      const allowedStates = new Set(["running", "stopped", "stale_pid"]);
      if (!allowedStates.has(status.localDaemon)) {
        const message = status.localDaemon === "unresponsive"
          ? "The local daemon PID is live but unresponsive. Inspect the PID lock before restarting it."
          : "Unexpected local daemon state: " + String(status.localDaemon);
        console.error(message);
        process.exit(1);
      }

      if (status.connectedDaemon === "auth_required") {
        console.error("The local daemon requires a password. Set PASEO_PASSWORD before this task.");
        process.exit(1);
      }
      if (status.connectedDaemon === "auth_failed") {
        console.error("The local daemon rejected PASEO_PASSWORD. Set the correct password before this task.");
        process.exit(1);
      }
      if (status.localDaemon === "running" && status.connectedDaemon !== "reachable") {
        console.error("The local daemon is running but could not be verified as reachable.");
        process.exit(1);
      }
      if (status.localDaemon !== "running" && status.connectedDaemon === "reachable") {
        console.error("A daemon is reachable at the listen address but is not owned by the local PID lock.");
        process.exit(1);
      }

      if (typeof status.home !== "string" || status.home.length === 0) process.exit(1);
      if (typeof status.listen !== "string" || status.listen.length === 0) process.exit(1);
      if (status.pid !== null && typeof status.pid !== "number") process.exit(1);
      if (status.startedAt !== null && typeof status.startedAt !== "string") process.exit(1);

      process.stdout.write(JSON.stringify({
        home: status.home,
        listen: status.listen,
        localDaemon: status.localDaemon,
        connectedDaemon: status.connectedDaemon,
        pid: status.pid,
        startedAt: status.startedAt,
        desktopManaged: status.desktopManaged,
      }));
    });
  '
}

identity_field() {
  local identity="$1"
  local field="$2"

  node -e '
    const identity = JSON.parse(process.argv[1]);
    process.stdout.write(identity[process.argv[2]]);
  ' "$identity" "$field"
}

require_daemon_password() {
  local daemon_home="$1"
  local daemon_state="$2"

  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const configPath = path.join(process.argv[1], "config.json");
    const daemonState = process.argv[2];
    const repoRoot = process.argv[3];
    const rawPassword = process.env.PASEO_PASSWORD;
    if (rawPassword !== undefined && rawPassword !== rawPassword.trim()) {
      console.error("PASEO_PASSWORD must not contain leading or trailing whitespace.");
      process.exit(1);
    }
    if (!fs.existsSync(configPath)) process.exit(0);

    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const passwordHash = config?.daemon?.auth?.password;
    if (typeof passwordHash === "string" && passwordHash.length > 0) {
      if (!rawPassword) {
        console.error("Daemon configuration at " + configPath + " requires a password. Set PASEO_PASSWORD before this task.");
        process.exit(1);
      }
      if (daemonState !== "running") {
        const bcrypt = require(path.join(repoRoot, "node_modules", "bcryptjs"));
        if (!bcrypt.compareSync(rawPassword, passwordHash)) {
          console.error("PASEO_PASSWORD does not match the password in " + configPath + ".");
          process.exit(1);
        }
      }
    }
  ' "$daemon_home" "$daemon_state" "$repo_root"
}

expected_version="$(cd "$repo_root" && node -p 'require("./package.json").version')"
tmp_root="${TMPDIR:-/tmp}"
tmp_root="${tmp_root%/}"
pack_dir="$(mktemp -d "$tmp_root/paseo-local-daemon-packs.XXXXXX")"

cleanup() {
  local exit_status=$?

  if [[ -n "${pack_dir:-}" && "$pack_dir" == "$tmp_root"/paseo-local-daemon-packs.* ]]; then
    rm -rf -- "$pack_dir"
  fi

  return "$exit_status"
}
trap cleanup EXIT

echo "Building Paseo $expected_version source packages"
workspaces=(
  @getpaseo/highlight
  @getpaseo/relay
  @getpaseo/protocol
  @getpaseo/client
  @getpaseo/server
  @getpaseo/cli
)

for workspace in "${workspaces[@]}"; do
  (
    cd "$repo_root"
    npm pack \
      --workspace="$workspace" \
      --pack-destination "$pack_dir"
  )
done

if [[ ! -x "$source_cli" ]]; then
  echo "The source build did not produce an executable Paseo CLI at $source_cli" >&2
  exit 1
fi

source_version="$("$source_cli" --version)"
if [[ "$source_version" != "$expected_version" ]]; then
  echo "Source CLI version $source_version does not match $expected_version; nothing was installed." >&2
  exit 1
fi

before_status="$("$source_cli" daemon status --json)"
before_identity="$(printf '%s' "$before_status" | daemon_identity)"
daemon_home="$(identity_field "$before_identity" home)"
daemon_state="$(identity_field "$before_identity" localDaemon)"
daemon_listen="$(identity_field "$before_identity" listen)"
require_daemon_password "$daemon_home" "$daemon_state"

echo "Installing source packages with the current npm prefix"
npm install -g "$pack_dir"/*.tgz
hash -r

if [[ ! -x "$paseo_cli" ]]; then
  echo "npm did not install an executable Paseo CLI at $paseo_cli" >&2
  exit 1
fi

installed_version="$("$paseo_cli" --version)"
if [[ "$installed_version" != "$expected_version" ]]; then
  echo "Installed CLI version $installed_version does not match $expected_version; daemon was not restarted." >&2
  exit 1
fi

post_install_status="$("$paseo_cli" daemon status --home "$daemon_home" --json)"
post_install_identity="$(printf '%s' "$post_install_status" | daemon_identity)"
if [[ "$post_install_identity" != "$before_identity" ]]; then
  echo "The local daemon changed during npm installation; it was not restarted." >&2
  exit 1
fi
require_daemon_password "$daemon_home" "$daemon_state"

if [[ "$daemon_state" == "running" ]]; then
  lifecycle_action="restart"
else
  lifecycle_action="start"
fi

PASEO_DESKTOP_MANAGED=0 \
  "$paseo_cli" daemon "$lifecycle_action" --home "$daemon_home" --listen "$daemon_listen"

after_status=""
for _ in {1..10}; do
  if after_status="$("$paseo_cli" daemon status --home "$daemon_home" --json 2>/dev/null)" && \
    printf '%s' "$after_status" | node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        const status = JSON.parse(input);
        process.exit(
          status.localDaemon === "running" &&
          status.connectedDaemon === "reachable" &&
          status.desktopManaged === false
            ? 0
            : 1,
        );
      });
    '
  then
    break
  fi
  after_status=""
  sleep 1
done

if [[ -z "$after_status" ]]; then
  echo "The local daemon did not become reachable after $lifecycle_action." >&2
  exit 1
fi

# The single-quoted JavaScript contains a template literal, not a shell expansion.
# shellcheck disable=SC2016
printf '%s' "$after_status" | node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const status = JSON.parse(input);
    const expectedVersion = process.argv[1];
    if (status.daemonVersion !== expectedVersion) {
      console.error(
        `Local daemon reported ${status.daemonVersion ?? "unknown"}; expected ${expectedVersion}.`,
      );
      process.exit(1);
    }
    if (status.desktopManaged !== false) {
      console.error("The local daemon unexpectedly reported desktop-managed ownership.");
      process.exit(1);
    }
    console.log(
      `Local daemon ${status.daemonVersion} is reachable at ${status.listen} (PID ${status.pid}).`,
    );
  });
' "$expected_version"

echo "Installed Paseo $expected_version on this machine"
