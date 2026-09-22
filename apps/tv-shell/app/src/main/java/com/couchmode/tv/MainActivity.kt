package com.couchmode.tv

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
         * Reload backoff after a failed page load.
         *
         * The bridge lives on a laptop that gets closed, slept and reopened, so
         * "the page would not load" is a normal state to pass through rather
         * than a dead end. Capped low: someone is sitting in front of this
         * waiting for it to come back, not reading logs.
         */
        const val RELOAD_MIN_MS = 2_000L
        const val RELOAD_MAX_MS = 15_000L
    }

    private lateinit var webView: WebView
    private lateinit var errorPanel: LinearLayout
    private lateinit var errorText: TextView

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

    private val reloadHandler = Handler(Looper.getMainLooper())
    private var reloadDelayMs = RELOAD_MIN_MS
    private var reloadAtMs = 0L
    private var reloadTick: Runnable? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        settings = BridgeSettings.load(this)
        if (settings.isComplete) showWebView() else showSetup()
    }

    override fun onResume() {
        super.onResume()
        applyImmersiveMode()
        // Coming back to the app is itself a "try now": whatever the backoff had
        // settled on, the odds that the bridge is up have just changed.
        if (loadFailed && !showingSetup) reloadNow()
    }

    override fun onStop() {
        super.onStop()
        // Nothing to retry into while the app is not on screen.
        cancelReload()
    }

    // ---------------------------------------------------------------- setup

    private fun showSetup(error: String? = null) {
        showingSetup = true
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
        errorText = findViewById(R.id.errorText)

        findViewById<Button>(R.id.retryButton).setOnClickListener { reloadNow() }
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
                // on the television instead of the panel with the Retry button.
                if (loadFailed) return
                reloadDelayMs = RELOAD_MIN_MS
                cancelReload()
                errorPanel.visibility = View.GONE
                webView.visibility = View.VISIBLE
                webView.requestFocus()
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
                scheduleReload()
            }
        }

        loadBridge()
    }

    private fun loadBridge() {
        cancelReload()
        loadFailed = false
        errorPanel.visibility = View.GONE
        webView.visibility = View.VISIBLE
        webView.loadUrl(settings.tvUrl())
        webView.requestFocus()
    }

    /** Try again immediately, from the shortest backoff. The Retry button, and onResume. */
    private fun reloadNow() {
        reloadDelayMs = RELOAD_MIN_MS
        loadBridge()
    }

    /**
     * Keep trying, and say so.
     *
     * The page failing to load is not a state a remote can fix - there is
     * nothing to type and nowhere to go - so the only useful behaviour is to
     * keep trying and tell the room what it is waiting for. The bridge coming
     * back then needs no press at all, which matters when it is a laptop lid
     * being reopened in another room.
     */
    private fun scheduleReload() {
        cancelReload()
        reloadAtMs = System.currentTimeMillis() + reloadDelayMs
        reloadDelayMs = (reloadDelayMs * 2).coerceAtMost(RELOAD_MAX_MS)

        val tick = object : Runnable {
            override fun run() {
                val remaining = reloadAtMs - System.currentTimeMillis()
                if (remaining <= 0) {
                    showRetrying()
                    loadFailed = false
                    webView.loadUrl(settings.tvUrl())
                    return
                }
                showLoadError(((remaining + 999) / 1000).toInt())
                reloadHandler.postDelayed(this, 1_000)
            }
        }
        reloadTick = tick
        tick.run()
    }

    private fun cancelReload() {
        reloadTick?.let { reloadHandler.removeCallbacks(it) }
        reloadTick = null
    }

    private fun showLoadError(retryInSeconds: Int) {
        errorText.text = getString(R.string.error_load_failed, settings.host, retryInSeconds)
        revealErrorPanel()
    }

    private fun showRetrying() {
        errorText.text = getString(R.string.error_load_retrying, settings.host)
        revealErrorPanel()
    }

    private fun revealErrorPanel() {
        if (errorPanel.visibility == View.VISIBLE) return
        webView.visibility = View.GONE
        errorPanel.visibility = View.VISIBLE
        findViewById<Button>(R.id.retryButton).requestFocus()
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
