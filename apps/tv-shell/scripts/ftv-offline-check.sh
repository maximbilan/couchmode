#!/usr/bin/env bash
#
# Fire TV offline-recovery check: what the app does when the bridge is not
# there, and what it does when the bridge comes back.
#
#   TV_IP=192.168.1.35 apps/tv-shell/scripts/ftv-offline-check.sh
#
# Owns the bridge lifecycle itself - that is the thing under test - so unlike
# ftv-check.sh it must NOT have one already running on the port.
#
# The bug this exists for: `onPageFinished` fires for Chromium's own error
# document too, so the shell's retry panel was shown by `onReceivedError` and
# then immediately hidden again, leaving a bare net::ERR_CONNECTION_REFUSED page
# on a television with no way out.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PACKAGE="com.couchmode.tv"
PORT="${COUCHMODE_PORT:-7777}"
CODE="${PAIR_CODE:-246810}"

: "${TV_IP:=}"
if [ -z "$TV_IP" ]; then
  echo "error: set TV_IP to your Fire TV's address" >&2
  exit 1
fi
DEVICE="$TV_IP:${TV_ADB_PORT:-5555}"

FAILED=0
check() {
  if [ "$2" = "1" ]; then echo "✓ $1${3:+ — $3}"; else echo "✗ $1${3:+ — $3}"; FAILED=1; fi
}

adb connect "$DEVICE" > /dev/null 2>&1
sleep 1

# The device must be pointed at this machine for the recovery half to mean
# anything; the app remembers its address, so just report what it will try.
echo "==> bridge port $PORT must be free to start"
lsof -ti "tcp:$PORT" | xargs -r kill -9 2>/dev/null
sleep 1

echo "==> launching with no bridge"
adb -s "$DEVICE" shell am force-stop "$PACKAGE"
sleep 2
adb -s "$DEVICE" logcat -c
adb -s "$DEVICE" shell monkey -p "$PACKAGE" -c android.intent.category.LEANBACK_LAUNCHER 1 > /dev/null 2>&1
sleep 7

TOP="$(adb -s "$DEVICE" shell dumpsys activity top 2>/dev/null)"
# A visible View prints "V" in the first flag column; a GONE one prints "G".
PANEL_VISIBLE=0
echo "$TOP" | grep -q 'id/errorPanel' && echo "$TOP" | grep 'id/errorPanel' | grep -qv 'G\.\.\.\.\.\.\.' && PANEL_VISIBLE=1
check "the shell shows its own panel, not Chromium's error page" "$PANEL_VISIBLE" \
  "$(echo "$TOP" | grep -o 'id/errorPanel' | head -1)"

LOGGED=0
adb -s "$DEVICE" logcat -d -s Couchmode | grep -q "load failed" && LOGGED=1
check "the load failure is logged" "$LOGGED"

RETRIES=$(adb -s "$DEVICE" logcat -d -s Couchmode | grep -c "load failed")
check "it keeps retrying on its own" "$([ "$RETRIES" -ge 2 ] && echo 1 || echo 0)" "$RETRIES attempts in 7s"

echo "==> starting the bridge; no remote input from here"
node "$REPO/packages/bridge/dist/cli.js" --fake --code "$CODE" --port "$PORT" \
  > "${TMPDIR:-/tmp}/couchmode-offline-check.log" 2>&1 &
BRIDGE=$!
trap 'kill $BRIDGE 2>/dev/null' EXIT
sleep 25

TOP="$(adb -s "$DEVICE" shell dumpsys activity top 2>/dev/null)"
WEBVIEW_BACK=0
echo "$TOP" | grep 'id/webView' | grep -qv 'G\.\.\.\.\.\.\.' && WEBVIEW_BACK=1
check "the page loads itself once the bridge is back, with no key press" "$WEBVIEW_BACK"

PAIRED=0
grep -q "pair ok tv" "${TMPDIR:-/tmp}/couchmode-offline-check.log" && PAIRED=1
check "and it re-pairs with the bridge" "$PAIRED"

echo ""
[ $FAILED -eq 0 ] && echo "Offline recovery passed." || echo "Offline recovery FAILED." >&2
exit $FAILED
