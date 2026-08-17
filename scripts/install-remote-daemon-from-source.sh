#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Build and install the Paseo daemon from this checkout on a remote SSH server.

Usage:
  mise run install:remote-daemon -- <ssh-target>

The SSH target may be a host alias or user@host from ~/.ssh/config. The remote
server must already have Node.js, npm, and an npm-installed Paseo daemon.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 2
fi

ssh_target="$1"
if [[ "$ssh_target" == -* || ! "$ssh_target" =~ ^[A-Za-z0-9_.@:-]+$ ]]; then
  echo "Invalid SSH target: $ssh_target" >&2
  exit 2
fi

target_host="${ssh_target##*@}"
case "$target_host" in
  localhost | localhost.* | 127.0.0.1 | ::1 | "[::1]")
    echo "install:remote-daemon refuses local SSH targets." >&2
    exit 2
    ;;
esac

for command_name in node npm ssh scp; do
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

expected_version="$(cd "$repo_root" && node -p 'require("./package.json").version')"
tmp_root="${TMPDIR:-/tmp}"
tmp_root="${tmp_root%/}"
pack_dir="$(mktemp -d "$tmp_root/paseo-remote-daemon-packs.XXXXXX")"
remote_dir=""

cleanup() {
  local exit_status=$?

  if [[ -n "$remote_dir" && "$remote_dir" == /tmp/paseo-source-install.* ]]; then
    ssh "$ssh_target" /bin/rm -rf -- "$remote_dir" >/dev/null 2>&1 || true
  fi

  if [[ -n "$pack_dir" && "$pack_dir" == "$tmp_root"/paseo-remote-daemon-packs.* ]]; then
    rm -rf -- "$pack_dir"
  fi

  return "$exit_status"
}
trap cleanup EXIT

echo "Checking remote prerequisites on $ssh_target"
ssh "$ssh_target" /bin/bash -s <<'REMOTE_PREFLIGHT'
set -euo pipefail

load_remote_profile() {
  if [[ -r "$HOME/.profile" ]]; then
    # Non-interactive SSH does not load the account's login environment.
    # Profile scripts are not required to support the installer's nounset mode.
    # shellcheck disable=SC1090
    set +u
    source "$HOME/.profile"
    set -u
  fi
}

load_remote_profile

for command_name in node npm paseo; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Remote prerequisite not found after loading ~/.profile: $command_name" >&2
    exit 1
  fi
done

echo "Remote Node:  $(command -v node) ($(node --version))"
echo "Remote npm:   $(command -v npm) ($(npm --version))"
echo "Remote Paseo: $(command -v paseo) ($(paseo --version))"
paseo daemon status --json >/dev/null
REMOTE_PREFLIGHT

echo "Building Paseo $expected_version source packages"
workspaces=(
  @getpaseo/highlight
  @getpaseo/relay
  @getpaseo/protocol
  @getpaseo/client
  @paseo/plugin
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

remote_dir="$(ssh "$ssh_target" mktemp -d /tmp/paseo-source-install.XXXXXX)"
if [[ "$remote_dir" != /tmp/paseo-source-install.* ]]; then
  echo "Remote mktemp returned an unexpected path: $remote_dir" >&2
  remote_dir=""
  exit 1
fi

echo "Transferring source packages to $ssh_target"
scp "$pack_dir"/*.tgz "$ssh_target:$remote_dir/"

echo "Installing and restarting the remote Paseo daemon"
ssh "$ssh_target" /bin/bash -s -- "$remote_dir" "$expected_version" <<'REMOTE_SCRIPT'
set -euo pipefail

pack_dir="$1"
expected_version="$2"

load_remote_profile() {
  if [[ -r "$HOME/.profile" ]]; then
    # shellcheck disable=SC1090
    set +u
    source "$HOME/.profile"
    set -u
  fi
}

load_remote_profile

if [[ "$pack_dir" != /tmp/paseo-source-install.* ]]; then
  echo "Unexpected remote package directory: $pack_dir" >&2
  exit 1
fi

before_status="$(paseo daemon status --json)"
daemon_home="$(printf '%s' "$before_status" | node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const value = JSON.parse(input).home;
    if (typeof value !== "string" || value.length === 0) process.exit(1);
    process.stdout.write(value);
  });
')"
daemon_listen="$(printf '%s' "$before_status" | node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const value = JSON.parse(input).listen;
    if (typeof value !== "string" || value.length === 0) process.exit(1);
    process.stdout.write(value);
  });
')"

echo "Installing source packages with the remote npm prefix"
npm install -g "$pack_dir"/*.tgz
hash -r

installed_version="$(paseo --version)"
if [[ "$installed_version" != "$expected_version" ]]; then
  echo "Installed CLI version $installed_version does not match $expected_version; daemon was not restarted." >&2
  exit 1
fi

paseo daemon restart --home "$daemon_home" --listen "$daemon_listen"

after_status=""
for _ in {1..10}; do
  if after_status="$(paseo daemon status --home "$daemon_home" --json 2>/dev/null)" && \
    printf '%s' "$after_status" | node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        const status = JSON.parse(input);
        process.exit(
          status.localDaemon === "running" && status.connectedDaemon === "reachable" ? 0 : 1,
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
  echo "The remote daemon did not become reachable after restart." >&2
  exit 1
fi

printf '%s' "$after_status" | node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const status = JSON.parse(input);
    const expectedVersion = process.argv[1];
    if (status.daemonVersion !== expectedVersion) {
      console.error(
        `Remote daemon reported ${status.daemonVersion ?? "unknown"}; expected ${expectedVersion}.`,
      );
      process.exit(1);
    }
    console.log(
      `Remote daemon ${status.daemonVersion} is reachable at ${status.listen} (PID ${status.pid}).`,
    );
  });
' "$expected_version"
REMOTE_SCRIPT

echo "Installed Paseo $expected_version on remote server $ssh_target"
