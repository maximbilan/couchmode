#!/usr/bin/env bash
#
# Runs the TV acceptance tests against a fake-mode bridge in headless Chrome.
#
#   packages/web/scripts/tv-check.sh
#
# A fresh browser and bridge are started per test: reusing one headless Chrome
# session across runs wedged it reliably.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPTS="$REPO/packages/web/scripts"
OUT="${COUCHMODE_TV_OUT:-$REPO/packages/web/.tv-check}"
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [ ! -x "$CHROME" ]; then
  echo "skip: no Chrome at $CHROME (set CHROME_BIN)" >&2
  exit 0
fi
if [ ! -f "$REPO/packages/web/dist/tv.html" ]; then
  echo "error: build first - pnpm build" >&2
  exit 1
fi

mkdir -p "$OUT"
FAILED=0

run_case() {
  local name="$1" fixture="$2" code="$3" port="$4" test="$5"

  pkill -9 -f "remote-debugging-port=9222" 2>/dev/null
  pkill -f "couchmode-tv-check" 2>/dev/null
  sleep 1
  rm -rf "$OUT/chrome-profile"

  COUCHMODE_TV_CHECK=1 node "$REPO/packages/bridge/dist/cli.js" \
    --fake "$fixture" --code "$code" --port "$port" > "$OUT/bridge-$port.log" 2>&1 &
  local bridge_pid=$!

  "$CHROME" --headless=new --remote-debugging-port=9222 --window-size=1920,1080 \
    --user-data-dir="$OUT/chrome-profile" --no-first-run --no-default-browser-check \
    --disable-gpu --disable-dev-shm-usage about:blank > "$OUT/chrome.log" 2>&1 &
  local chrome_pid=$!

  for _ in $(seq 1 40); do
    curl -s -m 2 http://localhost:9222/json/version > /dev/null && break
    sleep 0.5
  done

  echo ""
  echo "── $name ─────────────────────────────────────────────"
  node "$SCRIPTS/$test" "$port" "$code" "$OUT/$name.png"
  local status=$?
  [ $status -ne 0 ] && FAILED=1

  kill "$chrome_pid" "$bridge_pid" 2>/dev/null
  wait "$chrome_pid" "$bridge_pid" 2>/dev/null
  return 0
}

run_case "tv" \
  "$REPO/packages/bridge/fixtures/claude-readme-tests.jsonl" 123456 7801 tv-acceptance.mjs
run_case "tv-synthetic" \
  "$REPO/packages/bridge/fixtures/synthetic-plan-and-thoughts.jsonl" 777777 7802 tv-synthetic.mjs

pkill -9 -f "remote-debugging-port=9222" 2>/dev/null
echo ""
if [ $FAILED -eq 0 ]; then
  echo "TV acceptance passed. Screenshots in $OUT"
else
  echo "TV acceptance FAILED. Screenshots in $OUT" >&2
fi
exit $FAILED
