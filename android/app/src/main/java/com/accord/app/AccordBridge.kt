package com.accord.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/**
 * JS interface exposed to the WebView. The web app detects this object (via
 * `window.AccordBridge`) and reroutes its Google Sign-In through the native
 * picker — Google blocks OAuth inside WebViews with 'disallowed_useragent'.
 *
 * All `@JavascriptInterface` methods run on a binder thread; touch the WebView
 * via `webView.post { evaluateJavascript(...) }` only.
 */
class AccordBridge(
    private val appContext: Context,
    private val webView: WebView,
    /** Kicks off native Google Sign-In. */
    private val onRequestSignIn: (requestId: String, mode: String) -> Unit,
    /** Native sign-out (clears Google Sign-In so the next prompt re-asks). */
    private val onSignOut: () -> Unit,
    /** Gate page has rendered its first card — drop the native loading screen. */
    private val onGateReady: () -> Unit = {},
) {

    /**
     * Fresh Google ID token pre-fetched (via silent sign-in) by GateActivity
     * before loadUrl. JS reads it at firebase.js init via {@link #bootstrapIdToken}
     * to call signInWithCredential, so the embedded site's auth state mirrors
     * the native session without prompting the user again.
     *
     * Volatile because it's written from the main thread (GateActivity) and
     * read from a binder thread (JavascriptInterface).
     */
    @Volatile var pendingBootstrapToken: String? = null

    /** Volatile email of the natively-signed-in user; null if signed out. */
    @Volatile var pendingBootstrapEmail: String? = null

    /**
     * True while native silent sign-in is still running. The page no longer
     * waits for it before loading (see GateActivity): if JS asks for the
     * token before it exists, it checks this flag and, if set, waits for
     * {@link #pushBootstrapToken} to call `window.__accordBootstrap`.
     */
    @Volatile var bootstrapInFlight: Boolean = false

    /**
     * Web calls this synchronously at firebase.js init. Returns the empty
     * string if no token is available (no native session, or silent sign-in
     * failed) so JS can fall through to its normal sign-in path.
     */
    @JavascriptInterface
    fun bootstrapIdToken(): String = pendingBootstrapToken.orEmpty()

    /** Used by JS to short-circuit bootstrap if it's already signed in as this email. */
    @JavascriptInterface
    fun bootstrapEmail(): String = pendingBootstrapEmail.orEmpty()

    /** True while the native silent sign-in that produces the bootstrap token is still running. */
    @JavascriptInterface
    fun bootstrapPending(): Boolean = bootstrapInFlight

    /**
     * Called (main thread) when silent sign-in completes. Stores the token
     * for any later synchronous {@link #bootstrapIdToken} read and pushes
     * it to a page that is already waiting. A null token (no cached account,
     * silent flow failed) still fires the callback so JS stops waiting.
     */
    fun pushBootstrapToken(idToken: String?) {
        pendingBootstrapToken = idToken
        bootstrapInFlight = false
        val safe = idToken.orEmpty().escapeForJsSingleQuoted()
        val js = "try { window.__accordBootstrap && window.__accordBootstrap('$safe'); } catch(_) {}"
        webView.post { webView.evaluateJavascript(js, null) }
    }

    /**
     * Web calls this when it needs an ID token (sign-in or re-auth).
     * `mode` is "signin" | "reauth"; we always force the account picker either way.
     */
    @JavascriptInterface
    fun requestIdToken(requestId: String, mode: String?) {
        onRequestSignIn(requestId, mode ?: "signin")
    }

    @JavascriptInterface
    fun signOut() {
        onSignOut()
    }

    /**
     * gate.js calls this when its preloader goes away (the confirm / sign-in /
     * not-found card is on screen). GateActivity hides the native loading
     * overlay — until then the user only sees the native screen with its
     * "proceed without Accord" escape hatch.
     */
    @JavascriptInterface
    fun gateReady() {
        onGateReady()
    }

    /**
     * Open a URL in the user's default browser without touching the WebView.
     * The contribute flow uses this so the visitor's "Proceed to form" tap
     * doesn't trigger the WebView's navigation handler (which would call
     * finish() and drop them back to the app's home screen). After this
     * fires, the gate page stays right where it was — the user switches
     * back to the Accord app, sees the contribute card still expanded,
     * and uploads the downloaded form file.
     */
    @JavascriptInterface
    fun openInBrowser(url: String?) {
        if (url.isNullOrBlank()) return
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return
        val intent = Intent(Intent.ACTION_VIEW, uri)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { appContext.startActivity(intent) }
    }

    /**
     * Web calls this just before redirecting to the prefilled Google Form URL.
     * Adds the form to on-device history so it shows up under "Fill again".
     */
    @JavascriptInterface
    fun recordFill(name: String?, formId: String?, url: String?) {
        if (formId.isNullOrBlank()) return
        History.add(
            ctx    = appContext,
            name   = name.orEmpty(),
            formId = formId,
            url    = url.orEmpty(),
        )
    }

    /** Resolves a pending sign-in Promise back in JS land. */
    fun deliverIdToken(requestId: String, idToken: String?, error: String?) {
        val payload = JSONObject().apply {
            if (idToken != null) put("idToken", idToken)
            if (error   != null) put("error",   error)
        }.toString()

        val safePayload   = payload.escapeForJsSingleQuoted()
        val safeRequestId = requestId.escapeForJsSingleQuoted()
        val js =
            "try { window.__accordAuth && window.__accordAuth('$safeRequestId', '$safePayload'); } catch(_) {}"

        webView.post { webView.evaluateJavascript(js, null) }
    }

    /** Escape a string so it's safe inside a single-quoted JS string literal. */
    private fun String.escapeForJsSingleQuoted(): String {
        val sb = StringBuilder(length + 16)
        for (c in this) {
            when (c) {
                '\\'        -> sb.append("\\\\")
                '\''        -> sb.append("\\'")
                '\n'        -> sb.append("\\n")
                '\r'        -> sb.append("\\r")
                // U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR are JS
                // line terminators — leaving them raw would break the literal.
                ' '    -> sb.append("\\u2028")
                ' '    -> sb.append("\\u2029")
                else        -> sb.append(c)
            }
        }
        return sb.toString()
    }
}
