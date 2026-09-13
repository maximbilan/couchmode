#!/usr/bin/env bash
#
# Fire TV hardware acceptance: installs, launches, forwards the WebView
# devtools socket, and drives the device with real remote key events.
#
#   TV_IP=192.168.1.35 apps/tv-shell/scripts/ftv-check.sh
#
# Needs a bridge running in fake mode on this machine:
#   node packages/bridge/dist/cli.js --fake --code 246810 --port 7777
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APP="$REPO/apps/tv-shell"
OUT="${COUCHMODE_TV_OUT:-$APP/.ftv-check}"
PACKAGE="com.couchmode.tv"
CODE="${PAIR_CODE:-246810}"

: "${TV_IP:=}"
if [ -z "$TV_IP" ]; then
  echo "error: set TV_IP to your Fire TV's address" >&2
  exit 1
fi
DEVICE="$TV_IP:${TV_ADB_PORT:-5555}"

if [ -z "${JAVA_HOME:-}" ] && [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi
if [ -z "${ANDROID_HOME:-}" ] && [ -d "$HOME/Library/Android/sdk" ]; then
  export ANDROID_HOME="$HOME/Library/Android/sdk"
fi

mkdir -p "$OUT"
adb connect "$DEVICE" > /dev/null
sleep 2

echo "==> building and installing"
(cd "$APP" && ./gradlew --quiet assembleDebug) || exit 1
adb -s "$DEVICE" install -r "$APP/app/build/outputs/apk/debug/app-debug.apk" | tail -1

echo "==> launching"
adb -s "$DEVICE" shell am force-stop "$PACKAGE"
sleep 2
adb -s "$DEVICE" logcat -c
adb -s "$DEVICE" shell monkey -p "$PACKAGE" -c android.intent.category.LEANBACK_LAUNCHER 1 > /dev/null 2>&1
sleep 8

# The WebView's devtools socket is named after the process id, so look it up.
SOCK=$(adb -s "$DEVICE" shell "cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*'" | tr -d '\r' | head -1)
if [ -z "$SOCK" ]; then
  echo "error: no WebView devtools socket - is the app past the setup form?" >&2
  exit 1
fi
adb -s "$DEVICE" forward --remove-all > /dev/null 2>&1
adb -s "$DEVICE" forward tcp:9223 "localabstract:$SOCK" > /dev/null

echo "==> driving the remote"
TV_DEVICE="$DEVICE" COUCHMODE_CDP="http://localhost:9223" \
  node "$APP/scripts/ftv-acceptance.mjs" "$OUT/ftv.png"
STATUS=$?

adb -s "$DEVICE" forward --remove-all > /dev/null 2>&1
echo ""
[ $STATUS -eq 0 ] && echo "Fire TV acceptance passed. Screenshots in $OUT" \
  || echo "Fire TV acceptance FAILED. Screenshots in $OUT" >&2
exit $STATUS
