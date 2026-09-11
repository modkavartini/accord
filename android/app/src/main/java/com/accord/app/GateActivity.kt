package com.accord.app

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.view.View
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebChromeClient.FileChooserParams
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
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

    /** Pending file-chooser callback from the WebView. The system file picker
     *  hands the result back to {@link fileChooserLauncher}, which forwards it
     *  to this callback so the `<input type="file">` change event fires. */
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private lateinit var fileChooserLauncher: ActivityResultLauncher<Intent>

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

        // Register the file-picker launcher BEFORE configureWebView so the
        // WebChromeClient can safely reference it. ActivityResultLauncher
        // registration must happen before the activity enters STARTED state.
        fileChooserLauncher = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            val cb = fileChooserCallback
            fileChooserCallback = null
            if (cb == null) return@registerForActivityResult
            val uris: Array<Uri>? = if (result.resultCode == RESULT_OK) {
                val data = result.data
                when {
                    // Multi-select (clip data) — concatenate URIs.
                    data?.clipData != null -> {
                        val cd = data.clipData!!
                        Array(cd.itemCount) { i -> cd.getItemAt(i).uri }
                    }
                    data?.data != null -> arrayOf(data.data!!)
                    else -> null
                }
            } else null
            // WebView's contract: pass null on cancel/error so the input stays
            // empty; otherwise the WebView blocks future file inputs.
            cb.onReceiveValue(uris)
        }

        configureWebView(webView)
        webView.addJavascriptInterface(bridge, "AccordBridge")

        // Fetch a fresh Google ID token so the WebView's Firebase JS can sign
        // in (via signInWithCredential) — without it the embedded site has no
        // auth state and pages like /dashboard bounce to /. This used to gate
        // loadUrl behind silentSignIn (or a 900ms timeout), which put the
        // whole HTML/CSS/JS download serially behind Play Services on every
        // visit. Now the page loads immediately and the token is pushed in
        // when it lands; firebase-core.js waits on `bootstrapPending()` if it
        // asks before then.
        bridge.pendingBootstrapEmail = auth.currentUser?.email
        bridge.bootstrapInFlight = auth.currentUser != null
        webView.loadUrl(target)
        if (bridge.bootstrapInFlight) {
            auth.silentSignIn { idToken -> bridge.pushBootstrapToken(idToken) }
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
            // Needed for the WebView to read content:// URIs returned by the
            // SAF file picker (file inputs on Google Forms opened in-app).
            // Restricted to picker-granted URIs by the OS — page JS can't
            // enumerate other content providers.
            allowContentAccess        = true
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

            /**
             * Bridge `<input type="file">` in the WebView to the Android system
             * file picker. Without this override, file inputs are silently
             * dead in a WebView (e.g. a form's file-upload question when the
             * form is opened in-app).
             *
             * Best-effort opens the picker in Downloads (Android's picker
             * doesn't accept a sort-order extra, so we can only hint at the
             * starting directory).
             */
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>,
                params: FileChooserParams?
            ): Boolean {
                // Cancel any previous chooser so the WebView's state machine
                // doesn't deadlock if the user re-taps the input quickly.
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback

                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    // The web `accept` attr is a mix of MIME types and file
                    // extensions. Android's SAF filter only understands MIME
                    // types and *greys out* files whose system-detected MIME
                    // doesn't match — so passing ".mhtml" / ".html" makes
                    // every file in Downloads unclickable. Strip extension
                    // entries, then widen the MIME list to cover every type
                    // Android might tag a saved Chrome page with (real
                    // observed values: text/html, multipart/related,
                    // application/x-mimearchive, message/rfc822, and the
                    // catch-all application/octet-stream when the file has
                    // no recognised extension at all).
                    val mimeFromWeb = params?.acceptTypes
                        ?.map { it.trim() }
                        ?.filter { it.isNotEmpty() && it.contains('/') }
                        ?.toSet()
                        .orEmpty()
                    val mimes = (mimeFromWeb + setOf(
                        "text/html",
                        "text/plain",
                        "multipart/related",
                        "application/x-mimearchive",
                        "message/rfc822",
                        "application/octet-stream",
                    )).toTypedArray()
                    putExtra(Intent.EXTRA_MIME_TYPES, mimes)
                    if (params?.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                    // Hint at Downloads as the starting directory. The system
                    // picker may or may not honor this depending on OEM/SAF
                    // implementation, but it's the only knob the framework
                    // exposes for "start here."
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        runCatching {
                            val downloadsTree = Uri.parse(
                                "content://com.android.externalstorage.documents/document/primary%3ADownload"
                            )
                            putExtra(DocumentsContract.EXTRA_INITIAL_URI, downloadsTree)
                        }
                    }
                }

                return try {
                    fileChooserLauncher.launch(
                        Intent.createChooser(intent, "Select downloaded form file")
                    )
                    true
                } catch (e: Exception) {
                    fileChooserCallback = null
                    Toast.makeText(this@GateActivity,
                        "Couldn't open the file picker", Toast.LENGTH_SHORT).show()
                    false
                }
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

        fun intentForForm(ctx: android.content.Context, formId: String): Intent =
            Intent(ctx, GateActivity::class.java).putExtra(EXTRA_FORM_ID, formId)

        fun intentForUrl(ctx: android.content.Context, url: String): Intent =
            Intent(ctx, GateActivity::class.java).putExtra(EXTRA_URL, url)
    }
}
