#!/usr/bin/env bash
#
# Build the Fire TV shell and install it over adb.
#
#   TV_IP=192.168.1.42 scripts/install-tv.sh
#
# Enable ADB debugging on the device first:
#   Settings -> My Fire TV -> Developer Options -> ADB debugging
# The TV shows a confirmation prompt the first time you connect.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$REPO/apps/tv-shell"
APK="$APP/app/build/outputs/apk/debug/app-debug.apk"
PACKAGE="com.couchmode.tv"

: "${TV_IP:=}"
ADB_PORT="${TV_ADB_PORT:-5555}"

# Android Studio's bundled JDK is the one most likely to be present.
if [ -z "${JAVA_HOME:-}" ] && [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi
if [ -z "${ANDROID_HOME:-}" ] && [ -d "$HOME/Library/Android/sdk" ]; then
  export ANDROID_HOME="$HOME/Library/Android/sdk"
fi
export PATH="${ANDROID_HOME:-}/platform-tools:$PATH"

if [ -n "$TV_IP" ]; then
  echo "==> connecting to $TV_IP:$ADB_PORT"
  adb connect "$TV_IP:$ADB_PORT"
  TARGET=(-s "$TV_IP:$ADB_PORT")
else
  echo "==> TV_IP not set, using the only attached device"
  TARGET=()
fi

echo "==> building"
(cd "$APP" && ./gradlew --quiet assembleDebug)

echo "==> installing $(basename "$APK")"
# -r reinstalls in place; -d allows a downgrade while iterating on versionCode.
adb "${TARGET[@]}" install -r -d "$APK"

echo "==> launching"
adb "${TARGET[@]}" shell monkey -p "$PACKAGE" -c android.intent.category.LEANBACK_LAUNCHER 1 > /dev/null 2>&1 \
  || adb "${TARGET[@]}" shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 > /dev/null

cat <<'NEXT'

Installed. On first launch the TV asks for:

  Address    the host:port the bridge printed, e.g. 192.168.1.10:7777
  Pair code  the six digits the bridge printed

Press and hold MENU on the remote to change them later.

Useful while iterating:
  adb logcat -s Couchmode chromium          # page console output
  adb shell am force-stop com.couchmode.tv
NEXT
