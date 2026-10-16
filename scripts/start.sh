#!/usr/bin/env bash
#
# Start Couchmode: the bridge, for the project in the current directory.
#
#   cd ~/some/project
#   /path/to/couchmode/scripts/start.sh                 # Claude
#   /path/to/couchmode/scripts/start.sh --agent kiro
#   /path/to/couchmode/scripts/start.sh --fake          # recorded session, no tokens
#
# Every option goes straight to the bridge; `--help` lists them. On the way it
# switches to Node 22 through nvm if the current Node is older, installs
# dependencies when they are missing or stale, and builds.
#
# It also keeps one pair code in ~/.couchmode/pair-code, so a TV that has
# paired once connects by itself on every later run instead of asking for a
# new code. Pass `--code` to set it, or delete the file for a fresh one.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODE_FILE="$HOME/.couchmode/pair-code"

node_major() {
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

if [ "$(node_major)" -lt 22 ]; then
  NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  if [ ! -s "$NVM_SH" ]; then
    echo "error: Couchmode needs Node 22 or newer, found $(node -v 2>/dev/null || echo none)" >&2
    exit 1
  fi
  # nvm is not written for `set -u`.
  set +u
  # shellcheck source=/dev/null
  . "$NVM_SH"
  if ! nvm use --silent 22 > /dev/null 2>&1; then
    echo "error: Couchmode needs Node 22 or newer. Install it with: nvm install 22" >&2
    exit 1
  fi
  set -u
fi

# Corepack runs the pnpm version package.json pins, with nothing to install.
# It reads that pin from the current directory, not from --dir, so every pnpm
# call below runs from inside the repo.
if command -v corepack > /dev/null 2>&1; then
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  PNPM=(corepack pnpm)
else
  PNPM=(pnpm)
fi

if [ ! -f "$REPO/node_modules/.modules.yaml" ] ||
  [ "$REPO/pnpm-lock.yaml" -nt "$REPO/node_modules/.modules.yaml" ]; then
  echo "==> installing dependencies"
  (cd "$REPO" && "${PNPM[@]}" install --frozen-lockfile)
fi

# About a second, so always: a pull or an edit is never left unbuilt.
if ! BUILD_LOG="$(cd "$REPO" && "${PNPM[@]}" build 2>&1)"; then
  echo "$BUILD_LOG" >&2
  echo "error: build failed" >&2
  exit 1
fi

ARGS=("$@")
CODE=""
for ((i = 0; i < ${#ARGS[@]}; i++)); do
  if [ "${ARGS[$i]}" = "--code" ]; then CODE="${ARGS[$((i + 1))]:-}"; fi
done

if [ -z "$CODE" ]; then
  if [ -s "$CODE_FILE" ]; then
    CODE="$(cat "$CODE_FILE")"
  else
    CODE="$(printf '%06d' $(($(od -An -N4 -tu4 /dev/urandom) % 1000000)))"
    echo "==> new pair code, kept in $CODE_FILE for next time"
  fi
  ARGS+=(--code "$CODE")
fi

if [[ "$CODE" =~ ^[0-9]{6}$ ]]; then
  mkdir -p "$(dirname "$CODE_FILE")"
  (umask 077 && printf '%s\n' "$CODE" > "$CODE_FILE")
fi

exec node "$REPO/packages/bridge/dist/cli.js" "${ARGS[@]}"
