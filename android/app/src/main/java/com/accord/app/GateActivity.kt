package com.accord.app

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

/**
 * Embedded gate. Loads the accord-ingly site for either:
 *   - /go/{formId}  — gate flow culminating in a prefilled Google Form URL
 *   - /dashboard    — for the in-app "Open dashboard" CTA
 * Web ↔ native is bridged via {@link AccordBridge}; the bridge handles Google
 * Sign-In (which Google blocks in WebViews) by deferring to the native picker
 * through {@link AuthHelper}.
 *
 * When the WebView navigates to docs.google.com/forms (the gate's final
 * redirect), we either keep it in-app or hand off to the user's browser
 * depending on {@link Prefs#openFormsInApp}.
 */
class GateActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar
    private lateinit var auth: AuthHelper
    private lateinit var bridge: AccordBridge

    /** Pending sign-in request from JS; tracked so we can deliver the result back. */
    private var pendingAuthRequestId: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_gate)

        webView  = findViewById(R.id.webView)
        progress = findViewById(R.id.progress)

        val target = resolveTarget(intent)
        if (target == null) {
            finish()
            return
        }

        auth = AuthHelper(this) { user, idToken, error ->
            val reqId = pendingAuthRequestId
            pendingAuthRequestId = null
            if (reqId != null) {
                // Hand the result back to JS so signInWithCredential resolves.
                bridge.deliverIdToken(reqId, idToken, error)
            } else if (user == null && error != null) {
                // Sign-in initiated outside JS (shouldn't happen on this screen)
                // — fail quietly.
            }
        }

        bridge = AccordBridge(
            appContext = applicationContext,
            webView    = webView,
            onRequestSignIn = { requestId, _ ->
                pendingAuthRequestId = requestId
                auth.signIn(forceAccountPicker = true)
            },
            onSignOut = { auth.signOut() },
        )

        configureWebView(webView)
        webView.addJavascriptInterface(bridge, "AccordBridge")

        // Prefetch a fresh Google ID token so the WebView's Firebase JS can
        // sign in (via signInWithCredential) on page load — without this, the
        // embedded site has no auth state and pages like /dashboard bounce to
        // /, triggering a popup→redirect chain that Google blocks in WebViews.
        // Don't block forever: if silentSignIn doesn't return within a budget,
        // load anyway (signed-out site is still usable).
        bridge.pendingBootstrapEmail = auth.currentUser?.email
        var loaded = false
        val loadOnce = Runnable {
            if (loaded) return@Runnable
            loaded = true
            webView.loadUrl(target)
        }
        val timeout = Runnable { loadOnce.run() }
        webView.postDelayed(timeout, BOOTSTRAP_TIMEOUT_MS)
        auth.silentSignIn { idToken ->
            bridge.pendingBootstrapToken = idToken
            webView.removeCallbacks(timeout)
            loadOnce.run()
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack()
                else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        resolveTarget(intent)?.let { webView.loadUrl(it) }
    }

    /** Decides the URL to load based on the incoming intent. */
    private fun resolveTarget(intent: Intent?): String? {
        val explicit = intent?.getStringExtra(EXTRA_URL)
        if (!explicit.isNullOrBlank()) return explicit

        val formId = intent?.getStringExtra(EXTRA_FORM_ID)
        if (!formId.isNullOrBlank()) return "$ACCORD_BASE/go/$formId"

        return null
    }

    private fun configureWebView(wv: WebView) {
        wv.settings.apply {
            javaScriptEnabled         = true
            domStorageEnabled         = true
            databaseEnabled           = true
            allowFileAccess           = false
            allowContentAccess        = false
            mediaPlaybackRequiresUserGesture = true
            mixedContentMode          = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode                 = WebSettings.LOAD_DEFAULT
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        wv.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
            }
        }

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                return handleNavigation(url)
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                progress.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                progress.visibility = View.GONE
            }
        }
    }

    /**
     * Returns true if we intercepted (don't let WebView handle), false to let
     * the WebView load it.
     *  - accord-ingly.netlify.app  -> keep in WebView
     *  - docs.google.com/forms/... -> respect openFormsInApp toggle
     *  - everything else           -> external app (rare)
     */
    private fun handleNavigation(url: Uri?): Boolean {
        if (url == null) return false
        val host = url.host ?: return false

        if (host.endsWith(ACCORD_HOST)) return false

        val isGoogleForm =
            host == "docs.google.com" && (url.path?.startsWith("/forms/") == true)

        if (isGoogleForm) {
            return if (Prefs.openFormsInApp(this)) {
                // Stay in-app: let WebView load the Google Form.
                false
            } else {
                // Hand off to the browser. Finish this activity so back-press
                // returns to MainActivity, not a now-blank WebView.
                openExternally(url)
                finish()
                true
            }
        }

        // Catch-all: open anything non-Accord in an external app.
        openExternally(url)
        return true
    }

    private fun openExternally(url: Uri) {
        runCatching {
            startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    override fun onDestroy() {
        // Defensive cleanup so a long-running JS timer can't reach a detached
        // bridge after onDestroy.
        webView.removeJavascriptInterface("AccordBridge")
        webView.stopLoading()
        webView.webChromeClient = null
        webView.webViewClient = WebViewClient()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_FORM_ID = "form_id"
        const val EXTRA_URL     = "url"
        const val ACCORD_BASE = "https://accord-ingly.netlify.app"
        const val ACCORD_HOST = "accord-ingly.netlify.app"
        private const val BOOTSTRAP_TIMEOUT_MS = 2500L

        fun intentForForm(ctx: android.content.Context, formId: String): Intent =
            Intent(ctx, GateActivity::class.java).putExtra(EXTRA_FORM_ID, formId)

        fun intentForUrl(ctx: android.content.Context, url: String): Intent =
            Intent(ctx, GateActivity::class.java).putExtra(EXTRA_URL, url)
    }
}
