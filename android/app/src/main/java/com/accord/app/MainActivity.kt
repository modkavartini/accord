package com.accord.app

import android.content.Intent
import android.content.pm.verify.domain.DomainVerificationManager
import android.content.pm.verify.domain.DomainVerificationUserState
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.format.DateUtils
import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.RequiresApi
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.google.firebase.auth.FirebaseUser

/**
 * The app's single home. Three responsibilities:
 *  1. Route incoming forms-link intents (VIEW / SEND) to GateActivity, signing
 *     the user in first if necessary. The form ID is stashed in Prefs while
 *     auth runs so it survives the sign-in round trip.
 *  2. Render the signed-out (Continue with Google) and signed-in
 *     (dashboard / settings / history) states.
 *  3. Show the "forms.gle is the default app" setup card so users can fix
 *     intent routing without leaving Accord.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var auth: AuthHelper

    // Signed-out view
    private lateinit var signedOutView: View
    private lateinit var continueWithGoogleBtn: Button

    // Signed-in view
    private lateinit var signedInView: View
    private lateinit var avatarView: TextView
    private lateinit var nameView: TextView
    private lateinit var emailView: TextView
    private lateinit var dashboardBtn: Button
    private lateinit var settingsBtn: ImageButton
    private lateinit var signOutBtn: Button
    private lateinit var historyList: LinearLayout
    private lateinit var historyEmptyView: View

    // Setup card (forms.gle default app)
    private lateinit var setupCard: View

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        signedOutView         = findViewById(R.id.signedOutView)
        continueWithGoogleBtn = findViewById(R.id.continueWithGoogleBtn)
        signedInView          = findViewById(R.id.signedInView)
        avatarView            = findViewById(R.id.avatarView)
        nameView              = findViewById(R.id.nameView)
        emailView             = findViewById(R.id.emailView)
        dashboardBtn          = findViewById(R.id.dashboardBtn)
        settingsBtn           = findViewById(R.id.settingsBtn)
        signOutBtn            = findViewById(R.id.signOutBtn)
        historyList           = findViewById(R.id.historyList)
        historyEmptyView      = findViewById(R.id.historyEmptyView)
        setupCard             = findViewById(R.id.setupCard)

        auth = AuthHelper(this) { user, _, error ->
            continueWithGoogleBtn.isEnabled = true
            continueWithGoogleBtn.text = getString(R.string.continue_with_google)
            if (user != null) {
                renderState()
                consumePendingFormIntent()
            } else if (error != null) {
                snack(error)
            }
        }

        continueWithGoogleBtn.setOnClickListener {
            continueWithGoogleBtn.isEnabled = false
            continueWithGoogleBtn.text = getString(R.string.signing_in)
            auth.signIn(forceAccountPicker = true)
        }
        dashboardBtn.setOnClickListener {
            startActivity(GateActivity.intentForUrl(this, "${GateActivity.ACCORD_BASE}/dashboard"))
        }
        settingsBtn.setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
        signOutBtn.setOnClickListener { confirmSignOut() }
        findViewById<Button>(R.id.enableButton).setOnClickListener { openAppLinkSettings() }

        // If the activity was launched by a forms-link intent, stash the form
        // ID and either route immediately (signed in) or wait for sign-in.
        captureFormIntent(intent)
        renderState()
        consumePendingFormIntent()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        captureFormIntent(intent)
        consumePendingFormIntent()
    }

    override fun onResume() {
        super.onResume()
        // forms.gle default status may have changed in Settings — refresh card.
        setupCard.visibility = if (isFormsGleEnabled()) View.GONE else View.VISIBLE
        // History may have grown since last resume (after a fill).
        renderHistory()
    }

    // ─── Intent → form ID ──────────────────────────────────────────────────

    private fun captureFormIntent(intent: Intent?) {
        intent ?: return
        val formId = when (intent.action) {
            Intent.ACTION_VIEW -> intent.data?.let(::extractFormIdFromUri)
            Intent.ACTION_SEND -> {
                val text = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
                extractFormIdFromText(text)
            }
            else -> null
        }
        if (formId != null) Prefs.setPendingFormId(this, formId)
    }

    /**
     * If a form intent is queued AND the user is signed in, launch the gate
     * and clear the pending state. Otherwise leave it for the next sign-in.
     */
    private fun consumePendingFormIntent() {
        val formId = Prefs.pendingFormId(this) ?: return
        if (auth.currentUser == null) return
        Prefs.setPendingFormId(this, null)
        startActivity(GateActivity.intentForForm(this, formId))
    }

    // ─── State rendering ───────────────────────────────────────────────────

    private fun renderState() {
        val user = auth.currentUser
        if (user == null) {
            signedOutView.visibility = View.VISIBLE
            signedInView.visibility  = View.GONE
            return
        }
        signedOutView.visibility = View.GONE
        signedInView.visibility  = View.VISIBLE
        renderProfile(user)
        renderHistory()
    }

    private fun renderProfile(user: FirebaseUser) {
        nameView.text  = user.displayName.orEmpty().ifBlank { "Signed in" }
        emailView.text = user.email.orEmpty()
        val initialSource = user.displayName?.takeIf { it.isNotBlank() } ?: user.email.orEmpty()
        avatarView.text = initialSource.firstOrNull()?.uppercaseChar()?.toString() ?: "·"
    }

    private fun renderHistory() {
        val entries = History.list(this)
        historyList.removeAllViews()
        if (entries.isEmpty()) {
            historyEmptyView.visibility = View.VISIBLE
            historyList.visibility      = View.GONE
            return
        }
        historyEmptyView.visibility = View.GONE
        historyList.visibility      = View.VISIBLE
        val inflater = LayoutInflater.from(this)
        entries.forEach { entry ->
            val row = inflater.inflate(R.layout.item_history, historyList, false)
            row.findViewById<TextView>(R.id.itemName).text  = entry.name
            row.findViewById<TextView>(R.id.itemMeta).text  =
                DateUtils.getRelativeTimeSpanString(
                    entry.filledAt,
                    System.currentTimeMillis(),
                    DateUtils.MINUTE_IN_MILLIS,
                ).toString()
            row.findViewById<Button>(R.id.fillAgainBtn).setOnClickListener {
                startActivity(GateActivity.intentForForm(this, entry.formId))
            }
            historyList.addView(row)
        }
    }

    private fun confirmSignOut() {
        AlertDialog.Builder(this)
            .setTitle("Sign out?")
            .setMessage("Your on-device history will also be erased. Forms saved to your Accord (in the cloud) are not affected.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Sign out") { _, _ ->
                History.clear(this)
                Prefs.setPendingFormId(this, null)
                auth.signOut { renderState() }
            }
            .show()
    }

    // ─── forms.gle default-app card ────────────────────────────────────────

    private fun isFormsGleEnabled(): Boolean {
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
            Intent(
                Settings.ACTION_APP_OPEN_BY_DEFAULT_SETTINGS,
                Uri.parse("package:$packageName")
            )
        } else {
            Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:$packageName")
            )
        }
        runCatching { startActivity(intent) }
    }

    // ─── URL parsing ───────────────────────────────────────────────────────

    private fun extractFormIdFromUri(uri: Uri): String? {
        val url = uri.toString()
        return when {
            url.startsWith("https://docs.google.com/forms/d/e/") -> {
                val segments = uri.pathSegments
                val eIdx = segments.indexOf("e")
                if (eIdx >= 0 && eIdx + 1 < segments.size) segments[eIdx + 1] else null
            }
            url.startsWith("https://forms.gle/") -> uri.lastPathSegment
            else -> null
        }
    }

    private fun extractFormIdFromText(text: String): String? {
        for (prefix in listOf(
            "https://docs.google.com/forms/d/e/",
            "https://forms.gle/"
        )) {
            val idx = text.indexOf(prefix)
            if (idx >= 0) {
                val url = text.substring(idx).split(Regex("\\s")).first()
                return extractFormIdFromUri(Uri.parse(url))
            }
        }
        return null
    }

    private fun snack(message: String) {
        // Lightweight feedback; an actual Snackbar would need a CoordinatorLayout
        // anchor — Toast is fine for the auth-error path.
        android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_LONG).show()
    }
}
