package com.couchmode.tv

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import java.util.concurrent.Executors

/**
 * The whole Fire TV app: a fullscreen WebView pointed at the bridge, plus a
 * first-run form asking where the bridge is.
 *
 * Deliberately thin. Everything the viewer sees is the web client at /tv, which
 * the bridge serves - so improving the TV experience means editing TypeScript,
 * not reinstalling an APK.
 */
class MainActivity : Activity() {

    private companion object {
        const val TAG = "Couchmode"
        const val MENU_LONG_PRESS_MS = 500L

        /**
         * How often to look for the bridge while it is not there.
         *
         * No backoff: a TCP connect on a LAN is cheap, and someone is sitting in
         * front of this waiting. Once the bridge is up, the page should be on
         * screen within a couple of seconds, not whenever a doubling timer next
         * comes round.
         */
        const val PROBE_INTERVAL_MS = 2_000L

        /** Say "Connecting…" only if the first look takes long enough to notice. */
        const val CONNECTING_REVEAL_MS = 600L

        /** One breath of the pulsing dot, each way. */
        const val PULSE_MS = 900L
    }

    private lateinit var webView: WebView
    private lateinit var errorPanel: LinearLayout
    private lateinit var offlineTitle: TextView
    private lateinit var offlineBody: TextView
    private lateinit var offlineStatus: TextView
    private var pulse: ObjectAnimator? = null

    private var settings = BridgeSettings("", "")
    private var showingSetup = false

    /** Set when MENU opened setup, so the matching ACTION_UP is not a short press. */
    private var menuWasLongPress = false

    /**
     * The last main-frame load failed.
     *
     * Needed because `onPageFinished` also fires for Chromium's *own* error
     * document. Without this flag that callback runs after `onReceivedError`,
     * hides the panel it just showed, and reveals a `net::ERR_CONNECTION_REFUSED`
     * page the remote can do nothing with.
     */
    private var loadFailed = false

    private val watchHandler = Handler(Looper.getMainLooper())
    private val prober = Executors.newSingleThreadExecutor()

    /** The page is not on screen yet: keep looking for the bridge until it is. */
    private var waitingForBridge = false

    /** A probe is in flight or scheduled. */
    private var watching = false

    /** Bumped by stopWatching, so a probe already in flight reports to no one. */
    private var watchGeneration = 0

    private val revealConnecting = Runnable { showOffline(R.string.offline_connecting_title, null) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        settings = BridgeSettings.load(this)
        if (settings.isComplete) showWebView() else showSetup()
    }

    override fun onResume() {
        super.onResume()
        applyImmersiveMode()
        pulse?.resume()
        // Coming back to the app is itself a reason to look again: the odds
        // that the bridge is up have just changed.
        if (waitingForBridge && !watching && !showingSetup) startWatching()
    }

    override fun onStop() {
        super.onStop()
        // Nothing to look for while the app is not on screen.
        stopWatching()
        pulse?.pause()
    }

    override fun onDestroy() {
        super.onDestroy()
        prober.shutdownNow()
    }

    // ---------------------------------------------------------------- setup

    private fun showSetup(error: String? = null) {
        showingSetup = true
        stopWatching()
        pulse?.cancel()
        pulse = null
        setContentView(R.layout.activity_setup)

        val hostInput = findViewById<EditText>(R.id.hostInput)
        val codeInput = findViewById<EditText>(R.id.codeInput)
        val connect = findViewById<Button>(R.id.connectButton)
        val errorView = findViewById<TextView>(R.id.setupError)

        hostInput.setText(settings.host)
        codeInput.setText(settings.code)

        if (error != null) {
            errorView.text = error
            errorView.visibility = View.VISIBLE
        }

        val submit = {
            val host = BridgeSettings.normaliseHost(hostInput.text.toString())
            val code = codeInput.text.toString().trim()
            when {
                host.isEmpty() -> {
                    errorView.text = getString(R.string.error_host_required)
                    errorView.visibility = View.VISIBLE
                    hostInput.requestFocus()
                }
                code.isEmpty() -> {
                    errorView.text = getString(R.string.error_code_required)
                    errorView.visibility = View.VISIBLE
                    codeInput.requestFocus()
                }
                else -> {
                    settings = BridgeSettings(host, code)
                    BridgeSettings.save(this, settings)
                    showWebView()
                }
            }
        }

        connect.setOnClickListener { submit() }
        codeInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                submit()
                true
            } else {
                false
            }
        }

        hostInput.requestFocus()
        applyImmersiveMode()
    }

    // -------------------------------------------------------------- webview

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWebView() {
        showingSetup = false
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        errorPanel = findViewById(R.id.errorPanel)
        offlineTitle = findViewById(R.id.offlineTitle)
        offlineBody = findViewById(R.id.offlineBody)
        offlineStatus = findViewById(R.id.offlineStatus)
        pulse = ObjectAnimator.ofFloat(findViewById(R.id.offlinePulse), View.ALPHA, 1f, 0.2f).apply {
            duration = PULSE_MS
            repeatMode = ValueAnimator.REVERSE
            repeatCount = ValueAnimator.INFINITE
        }

        findViewById<Button>(R.id.settingsButton).setOnClickListener { showSetup() }

        // Debug builds only: lets `adb forward` + chrome://inspect reach the page,
        // which is how the TV acceptance test drives a real device.
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        webView.setBackgroundColor(Color.parseColor("#07090C"))
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // The bridge serves plain HTTP on the LAN; see network_security_config.
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            mediaPlaybackRequiresUserGesture = false
            // /tv is laid out on a fixed 1920px canvas. Fire TV reports a 960dp
            // viewport at density 320, so without these the page lays out at
            // 960 CSS px and everything renders at double size. useWideViewPort
            // honours the page's `width=1920` meta viewport and overview mode
            // scales that canvas down to fit the screen - which on a 1080p
            // panel lands back on 1:1 physical pixels.
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
            builtInZoomControls = false
            cacheMode = WebSettings.LOAD_NO_CACHE
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                loadFailed = false
            }

            override fun onPageFinished(view: WebView, url: String) {
                // Chromium's error page finishes loading too. Revealing the
                // WebView here regardless is what put `ERR_CONNECTION_REFUSED`
                // on the television instead of the shell's own panel.
                if (loadFailed) return
                waitingForBridge = false
                stopWatching()
                hideOffline()
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                // Subresource failures are not worth a full-screen error.
                if (!request.isForMainFrame) return
                Log.i(TAG, "load failed: ${error.errorCode} ${error.description}")
                loadFailed = true
                if (errorPanel.visibility != View.VISIBLE) revealConnecting.run()
                // A probe just found the port open, so look again after the
                // usual pause rather than at once: something that accepts
                // connections but cannot serve the page would otherwise spin.
                startWatching(PROBE_INTERVAL_MS)
            }
        }

        startWatching()
    }

    /**
     * Load the page. If the panel is up it stays up, over an invisible WebView,
     * until the page has finished: the bridge coming back swaps one complete
     * screen for another, with no blank frame in between.
     */
    private fun loadBridge() {
        loadFailed = false
        if (errorPanel.visibility != View.VISIBLE) {
            webView.visibility = View.VISIBLE
            webView.requestFocus()
        }
        webView.loadUrl(settings.tvUrl())
    }

    // ------------------------------------------------------------- watching

    /**
     * Look for the bridge until it answers, then load the page.
     *
     * The bridge lives on a laptop that gets closed, slept and reopened, often
     * in another room, so "not there yet" is a state to wait in, not an error
     * to dismiss. Nothing on the remote can fix it, so the useful behaviour is
     * to keep looking, say plainly what is wrong, and load the page the moment
     * it can - with no key press, because the person who fixed it may be on
     * the other side of the house.
     */
    private fun startWatching(delayMs: Long = 0) {
        stopWatching()
        waitingForBridge = true
        watching = true
        val generation = watchGeneration
        if (errorPanel.visibility != View.VISIBLE) {
            watchHandler.postDelayed(revealConnecting, CONNECTING_REVEAL_MS)
        }
        watchHandler.postDelayed({ probe(generation) }, delayMs)
    }

    private fun stopWatching() {
        watchGeneration += 1
        watching = false
        watchHandler.removeCallbacksAndMessages(null)
    }

    private fun probe(generation: Int) {
        val host = settings.host
        prober.execute {
            val reach = BridgeReach.probe(host)
            watchHandler.post { onProbe(generation, reach) }
        }
    }

    private fun onProbe(generation: Int, reach: BridgeReach) {
        if (generation != watchGeneration) return
        watchHandler.removeCallbacks(revealConnecting)
        when (reach) {
            BridgeReach.UP -> {
                stopWatching()
                loadBridge()
                return
            }
            BridgeReach.NOT_RUNNING ->
                showOffline(R.string.offline_not_running_title, R.string.offline_not_running_body)
            BridgeReach.UNREACHABLE ->
                showOffline(R.string.offline_unreachable_title, R.string.offline_unreachable_body)
        }
        watchHandler.postDelayed({ probe(generation) }, PROBE_INTERVAL_MS)
    }

    private fun showOffline(title: Int, body: Int?) {
        offlineTitle.setText(title)
        if (body != null) offlineBody.setText(body)
        offlineBody.visibility = if (body != null) View.VISIBLE else View.GONE
        offlineStatus.text = getString(R.string.offline_looking, settings.host)
        if (errorPanel.visibility == View.VISIBLE) return
        // INVISIBLE, not GONE: the page keeps its full size to load into behind
        // the panel, and still cannot take focus from the panel's button.
        webView.visibility = View.INVISIBLE
        errorPanel.visibility = View.VISIBLE
        pulse?.start()
        findViewById<Button>(R.id.settingsButton).requestFocus()
    }

    private fun hideOffline() {
        pulse?.cancel()
        errorPanel.visibility = View.GONE
        webView.visibility = View.VISIBLE
        webView.requestFocus()
    }

    // ----------------------------------------------------------------- keys

    /**
     * MENU is two buttons in one: long press opens the setup form, so the
     * address can be changed without clearing app data, and short press is the
     * page's agent picker.
     *
     * Handled in dispatchKeyEvent rather than onKeyDown: the WebView has focus
     * and consumes MENU before the activity's onKeyDown fallback ever runs.
     * Intercepting at dispatch is the only point that reliably sees the key.
     *
     * Long press is detected from the event itself. A held remote key sets
     * FLAG_LONG_PRESS on a repeat, and `input keyevent --longpress` sets it on
     * a single event, so counting repeats by hand never fires for either.
     *
     * The short press is forwarded on ACTION_UP the same way Back is, via a
     * hook the page owns. Doing it on UP is what keeps the two apart: by then
     * a long press has already opened setup and set `menuWasLongPress`, so the
     * picker does not also appear behind the form.
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_MENU) {
            when (event.action) {
                KeyEvent.ACTION_DOWN -> {
                    val heldLongEnough = event.eventTime - event.downTime >= MENU_LONG_PRESS_MS
                    if (event.isLongPress || heldLongEnough) {
                        Log.i(TAG, "MENU long press: reopening setup")
                        menuWasLongPress = true
                        showSetup()
                    }
                }
                KeyEvent.ACTION_UP -> {
                    val wasLong = menuWasLongPress
                    menuWasLongPress = false
                    if (!wasLong && !showingSetup && ::webView.isInitialized) {
                        Log.i(TAG, "MENU short press: handing to the page")
                        webView.evaluateJavascript(
                            "(function(){ try { return !!(window.couchmodeMenu &&" +
                                " window.couchmodeMenu()); } catch (e) { return false; } })()",
                        ) { result -> Log.i(TAG, "MENU: page handled = $result") }
                    }
                }
            }
            // Swallow MENU either way: letting it through pops Fire OS's own
            // menu over the app.
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    /**
     * Back asks the page first.
     *
     * The web client owns what "back" means - close the composer, answer a
     * permission request with its deny option, return focus to the top of the
     * screen - so the shell calls `window.couchmodeBack()` and only leaves the
     * app when the page reports it had nothing open.
     *
     * `evaluateJavascript` is asynchronous, so the decision cannot be returned
     * from this call. The activity finishes from the callback instead.
     */
    @Deprecated("Fire OS 8 predates the predictive-back APIs this would use.")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (showingSetup) {
            // Leaving setup without an address would show a blank WebView.
            if (settings.isComplete) showWebView() else finish()
            return
        }
        if (!::webView.isInitialized || errorPanel.visibility == View.VISIBLE) {
            finish()
            return
        }
        webView.evaluateJavascript(
            "(function(){ try { return !!(window.couchmodeBack && window.couchmodeBack()); }" +
                " catch (e) { return false; } })()",
        ) { result ->
            Log.i(TAG, "BACK: page handled = $result")
            if (result != "true") finish()
        }
    }

    // ------------------------------------------------------------ immersive

    private fun applyImmersiveMode() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )
    }
}
