package com.accord.app

import android.content.Intent
import android.content.pm.verify.domain.DomainVerificationManager
import android.content.pm.verify.domain.DomainVerificationUserState
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import androidx.annotation.RequiresApi
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private var setupCard: View? = null
    private var moreInfoContent: View? = null
    private var moreInfoToggle: Button? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Tapped a forms link directly (forms.gle or docs.google.com/forms/d/e/)
        if (intent.action == Intent.ACTION_VIEW) {
            val converted = intent.data?.let { convertFormUrl(it) }
            if (converted != null) {
                openInBrowser(converted)
                finish()
                return
            }
        }

        // Shared a link from another app (Chrome share, long-press a link, etc.)
        if (intent.action == Intent.ACTION_SEND) {
            val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: ""
            val converted = extractFormUri(text)?.let { convertFormUrl(it) }
            if (converted != null) {
                openInBrowser(converted)
                finish()
                return
            }
        }

        // Normal home-screen launch — show info screen
        setContentView(R.layout.activity_main)
        setupCard = findViewById(R.id.setupCard)
        moreInfoContent = findViewById(R.id.moreInfoContent)
        moreInfoToggle = findViewById(R.id.moreInfoToggle)

        findViewById<Button>(R.id.enableButton).setOnClickListener {
            openAppLinkSettings()
        }
        findViewById<Button>(R.id.openButton).setOnClickListener {
            openInBrowser(HOME_URL)
        }
        moreInfoToggle?.setOnClickListener { toggleMoreInfo() }
    }

    private fun toggleMoreInfo() {
        val expanded = moreInfoContent?.visibility == View.VISIBLE
        moreInfoContent?.visibility = if (expanded) View.GONE else View.VISIBLE
        moreInfoToggle?.text = if (expanded) "More info  ▾" else "Less info  ▴"
    }

    override fun onResume() {
        super.onResume()
        // Refresh on resume so the card disappears immediately when the user
        // returns from the Settings page after enabling the link
        setupCard?.visibility = if (isFormsGleEnabled()) View.GONE else View.VISIBLE
    }

    private fun isFormsGleEnabled(): Boolean {
        // Pre-Android-12 has no API to query this; assume the chooser path works
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return checkDomainEnabled()
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun checkDomainEnabled(): Boolean {
        val manager = getSystemService(DomainVerificationManager::class.java) ?: return true
        return runCatching {
            val state = manager
                .getDomainVerificationUserState(packageName)
                ?.hostToStateMap
                ?.get("forms.gle")
            state == DomainVerificationUserState.DOMAIN_STATE_SELECTED ||
                state == DomainVerificationUserState.DOMAIN_STATE_VERIFIED
        }.getOrDefault(false)
    }

    private fun openAppLinkSettings() {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Deep links straight to the per-app "Open by default" page on Android 12+
            Intent(
                Settings.ACTION_APP_OPEN_BY_DEFAULT_SETTINGS,
                Uri.parse("package:$packageName")
            )
        } else {
            // Older Android: best we can do is the app details page
            Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:$packageName")
            )
        }
        runCatching { startActivity(intent) }
    }

    private fun convertFormUrl(uri: Uri): String? {
        val url = uri.toString()
        return when {
            url.startsWith("https://docs.google.com/forms/d/e/") -> {
                // path: /forms/d/e/{ID}/viewform
                val segments = uri.pathSegments
                val eIdx = segments.indexOf("e")
                if (eIdx >= 0 && eIdx + 1 < segments.size)
                    "$ACCORD_BASE/go/${segments[eIdx + 1]}"
                else null
            }
            url.startsWith("https://forms.gle/") ->
                uri.lastPathSegment?.let { "$ACCORD_BASE/go/$it" }
            else -> null
        }
    }

    private fun extractFormUri(text: String): Uri? {
        for (prefix in listOf(
            "https://docs.google.com/forms/d/e/",
            "https://forms.gle/"
        )) {
            val idx = text.indexOf(prefix)
            if (idx >= 0) {
                val url = text.substring(idx).split(Regex("\\s")).first()
                return Uri.parse(url)
            }
        }
        return null
    }

    private fun openInBrowser(url: String) {
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }

    companion object {
        const val ACCORD_BASE = "https://accord-ingly.netlify.app"
        const val HOME_URL = "https://accord-ingly.netlify.app/"
    }
}
