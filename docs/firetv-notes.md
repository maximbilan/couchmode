# Fire TV notes

Friction log for running a web-based ACP client on Fire OS. Every entry below
was reproduced on real hardware.

## Device under test

|         |                                                         |
| ------- | ------------------------------------------------------- |
| Device  | Fire TV Stick (`AFTBR92D74`, `ginzaeu`)                 |
| Fire OS | 8.1.8.2 (RS8182/3811) — Android 11, API 30              |
| Panel   | physical 3840×2160, **override 1920×1080**, density 320 |
| WebView | `com.amazon.webview.chromium` — **Chromium 148**        |
| `adb`   | `adb connect <tv-ip>:5555` after enabling ADB debugging |

Two things this settles up front:

- **API 30 is the floor**, which is why the shell sets `minSdk = 30`.
- The WebView is modern. `color-mix()`, `-webkit-line-clamp`, `:has()` and
  everything else the TV stylesheet uses are supported. Amazon's fork is not
  the ancient WebView it once was.

## The page rendered at double size

**Symptom:** everything on `/tv` was roughly twice the intended size. Only a
couple of feed rows fit on screen.

**Cause:** at density 320 the WebView reports a 960dp-wide viewport, so a page
without an honoured viewport meta lays out at 960 CSS px. `/tv` is a fixed
1920px canvas, so every value was effectively doubled.

The original settings made it worse by being confidently wrong:

```kotlin
useWideViewPort = false      // ignores the page's width=1920
loadWithOverviewMode = false // and never scales the canvas to fit
```

**Fix:** honour the meta viewport and let the WebView scale the canvas down to
the screen — which on a 1080p panel lands back on 1:1 physical pixels.

```kotlin
useWideViewPort = true
loadWithOverviewMode = true
```

`tv.html` also had to drop `initial-scale=1`, which pins the page at 1:1
CSS-to-dp and defeats `width=1920`:

```html
<meta name="viewport" content="width=1920" />
```

**Verified:** the device now reports `innerWidth 1920`, `innerHeight 1080`, and
a feed/diff split of 1107/737 — identical to a desktop browser.

## There is no key that means "submit" while typing

**Symptom:** a prompt typed on the TV could not be sent. Neither OK nor Enter
did anything.

**Cause:** while the on-screen keyboard is attached, every key is routed
through the input method and reaches the page as `keyCode 229` /
`key: "Unidentified"` — the standard Android "IME is composing" marker. OK and
Enter are indistinguishable from any other key:

```
KEYCODE_DPAD_CENTER -> keydown kc=229, beforeinput insertText, input, keyup kc=229
KEYCODE_ENTER       -> keydown kc=229, beforeinput insertText, input, keyup kc=229
```

No `submit` event is raised, so wrapping the input in a `<form>` does not help
either — that was an attempted fix that failed on device.

**What actually works:** dismissing the keyboard commits the text, and _that_
reaches the page as a real `Enter`. So the working flow on a remote is:

> OK on the prompt bar → keyboard opens → type → **Back** → prompt is submitted.

Back there means "I have finished typing", not "cancel" — which is the Fire OS
convention for text fields, even though it reads oddly written down.

`/tv` keeps an explicit **Send** button as well, reachable with the D-pad once
the keyboard is gone, so there is a visible affordance and a route that does not
depend on IME behaviour.

**Testing gotcha:** `adb shell input text` injects text _without_ raising the
IME, so a test that uses it exercises a different path from a human typing.

## BACK and MENU never reach the page

Neither key produces a DOM event at all. Both are consumed before the WebView,
which is exactly why the shell handles them natively.

- **BACK** → `Activity.onBackPressed` → `evaluateJavascript("window.couchmodeBack()")`.
  The page decides what Back means and reports whether it consumed it; the
  activity only calls `finish()` when the page says it had nothing open.
  `evaluateJavascript` is asynchronous, so the decision happens in its callback.
- **MENU** → see below.

## MENU long-press needed dispatchKeyEvent, not onKeyDown

**Symptom:** long-pressing MENU did nothing, with no log line.

**Two separate causes, found in order:**

1. `Activity.onKeyDown` is a _fallback_ — it only runs if the focused view
   declines the key. The WebView has focus and consumes MENU, so the override
   never ran. Intercepting in `dispatchKeyEvent` is the only point that
   reliably sees it.
2. Detecting a long press by timing repeats does not work. Both a held remote
   key and an injected `input keyevent --longpress` arrive as a single event
   carrying `FLAG_LONG_PRESS`, so the repeat counter never reached its
   threshold. Read `event.isLongPress` instead.

MENU is swallowed either way: letting a short press through pops Fire OS's own
menu over the app.

## The setup form needed explicit focus traversal

**Symptom:** typing the address, pressing DOWN, then typing the pair code put
the code on the end of the address: `10.0.2.2:7777246810`.

**Cause:** DPAD_DOWN inside a multi-line-capable `EditText` moves the caret
rather than leaving the field, so focus never reached the next input.

**Fix:** `android:maxLines="1"` plus explicit `nextFocusDown` / `nextFocusUp`
on both fields and the button. On a remote, focus traversal has to be stated,
not inferred from layout order.

Two more form quirks, both fixed in the manifest and layout:

- `requestFocus()` on an `EditText` raises the keyboard immediately, hiding the
  whole form. `android:windowSoftInputMode="stateHidden|adjustResize"` stops it;
  on a TV, focus and typing are separate things.
- In landscape the IME defaults to fullscreen "extract mode" and covers the
  field being edited. `android:imeOptions="...|flagNoExtractUi"` keeps the form
  visible.

## `onPageFinished` fires for Chromium's error page too

The shell has always had its own "could not reach the bridge" panel with a retry
button, and it was never seen: `onReceivedError` showed it, and then
`onPageFinished` — which fires for the error document Chromium loads in place of
the page — hid it again and revealed a bare `net::ERR_CONNECTION_REFUSED` screen.
On a television that is a dead end; there is nothing to type and nowhere to go.

`onPageFinished` now returns early when a `loadFailed` flag is set, cleared on
`onPageStarted` for each new navigation.

The panel also retries by itself, 2s doubling to 15s, with the countdown on
screen and a "Try now" button for impatience. The bridge runs on a laptop that
gets closed and reopened, often in another room, so needing someone to walk to
the TV and press a button is the wrong recovery model. `onResume` retries
immediately — returning to the app is itself a reason to think the odds have
changed — and `onStop` cancels the timer.

`apps/tv-shell/scripts/ftv-offline-check.sh` covers both halves against a real
device: launch with nothing on the port, then start the bridge and assert the
page comes back with no key press.

## MENU has to be forwarded by hand

The shell intercepts `KEYCODE_MENU` in `dispatchKeyEvent` and returns `true` for
it unconditionally, because letting it through pops Fire OS's own menu over the
app. That is right, but it means **the page never sees MENU as a `keydown`**:
the focus manager's menu handler fires in a desktop browser and never on a
television, so the agent picker looked reachable in every browser test and was
unreachable on the device.

Short press is therefore forwarded explicitly on `ACTION_UP`, through a
`window.couchmodeMenu()` hook, the same shape as the existing
`window.couchmodeBack()`. Doing it on UP rather than DOWN is what keeps it apart
from the long press: by then a long press has already opened the setup form and
set a flag, so the picker does not also open behind it.

The lesson generalises — any key the shell swallows needs a hook, and a browser
test cannot tell you which keys those are. `apps/tv-shell/scripts/ftv-check.sh`
covers MENU and BACK with real `input keyevent`s for exactly this reason.

## Animation: move things, never scale them

The `/tv` motion (entrances, the permission modal, the answer stamp) was tuned
against frame timings recorded on the device: a `requestAnimationFrame` loop
counting frames over 25ms, attributed to whichever animation had just started,
across the whole `--fake` session driven with real `input keyevent`s.

Three things a laptop never showed:

- **Scaling costs a re-raster.** A 1.5% "pop" on a feed row dropped a frame
  nearly every time it played. Scaling the 1500px permission modal, or the
  answer line inside it, did the same at the moment that matters most. Every
  motion is now a translation plus opacity, and press feedback is a 4px nudge
  rather than a shrink.
- **A glow is not free just because only its opacity animates.** A blurred
  90px shadow around the modal, and then even a crisp ring with no blur, held
  the first permission request at 30fps for a second.
- **The worst moment is the one where everything arrives at once.** An edit's
  diff and its permission request land together, so the Changes panel appears
  and re-lays out the stage in the same frame as the modal starts to rise. A
  cascade of 30 diff lines meant 30 layers on top of that. The diff now moves as
  one block, and the panel's entrance is finished instantly when the modal
  opens, since the scrim is about to cover it anyway.

Net effect, same session, same device: dropped frames at the first permission
request went from 8-9 to 3-4, and the worst frame from 100ms to 50ms. `main`
before any motion dropped 1-2 there, invisibly, because nothing was moving.

**Testing gotcha:** don't judge motion from screenshots taken with the DevTools
animation playback rate slowed down. Doing that on the device showed text drawn
at a fraction of its size mid-animation; `adb shell screenrecord` at full speed
showed every frame correct. Record the real display instead.

## Debugging on the device

The shell enables WebView debugging in debug builds only, which makes the page
reachable from the development machine:

```sh
# the socket is named after the WebView process id
SOCK=$(adb shell "cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*'" | tr -d '\r' | head -1)
adb forward tcp:9223 "localabstract:$SOCK"
# then chrome://inspect, or scripts/ftv-acceptance.mjs
```

`apps/tv-shell/scripts/ftv-check.sh` wraps all of that and drives the device
with real key events.

**Gotcha:** the WebView is only _detached_ when the setup form replaces it, not
destroyed, so its devtools target survives. A test that infers "the WebView is
gone" from the target list will be wrong — ask `dumpsys activity top` what is
actually on screen instead.

## Still unverified

- The banner artwork on the Fire TV home row. The app was always launched
  through `adb`/`monkey`, never from the launcher shelf.
- Behaviour on an older Fire OS with a pre-Chromium-111 WebView, where
  `color-mix()` would fail and the palette would need static fallbacks.
