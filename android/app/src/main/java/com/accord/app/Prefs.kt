package com.accord.app

import android.content.Context
import android.content.SharedPreferences

/**
 * Thin SharedPreferences wrapper. Two namespaces:
 *   - settings:  user preferences (open-in-app toggle, etc.)
 *   - state:     transient routing/intent state
 */
object Prefs {
    private const val SETTINGS = "accord.settings"
    private const val STATE    = "accord.state"

    private const val KEY_OPEN_IN_APP = "open_forms_in_app"
    private const val KEY_PENDING_FORM_ID = "pending_form_id"
    private const val KEY_LAST_UPDATE_CHECK = "last_update_check"
    private const val KEY_SKIPPED_UPDATE = "skipped_update_version"

    private fun settings(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(SETTINGS, Context.MODE_PRIVATE)

    private fun state(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(STATE, Context.MODE_PRIVATE)

    /** True if filled Google Forms should open inside Accord's WebView instead of the browser. */
    fun openFormsInApp(ctx: Context): Boolean =
        settings(ctx).getBoolean(KEY_OPEN_IN_APP, false)

    fun setOpenFormsInApp(ctx: Context, value: Boolean) {
        settings(ctx).edit().putBoolean(KEY_OPEN_IN_APP, value).apply()
    }

    /**
     * Form ID held over while the user signs in. When a form-link intent arrives
     * but no user is signed in, MainActivity stashes the ID here, prompts sign-in,
     * then resumes the GateActivity launch after auth succeeds.
     */
    fun pendingFormId(ctx: Context): String? =
        state(ctx).getString(KEY_PENDING_FORM_ID, null)

    fun setPendingFormId(ctx: Context, formId: String?) {
        state(ctx).edit().apply {
            if (formId == null) remove(KEY_PENDING_FORM_ID)
            else                putString(KEY_PENDING_FORM_ID, formId)
        }.apply()
    }

    // ─── Self-updater bookkeeping ───────────────────────────────────────────

    /** Wall-clock millis of the last update check; 0 if never. Throttles checks. */
    fun lastUpdateCheck(ctx: Context): Long =
        state(ctx).getLong(KEY_LAST_UPDATE_CHECK, 0L)

    fun setLastUpdateCheck(ctx: Context, whenMs: Long) {
        state(ctx).edit().putLong(KEY_LAST_UPDATE_CHECK, whenMs).apply()
    }

    /** versionCode the user chose to skip; -1 if none. Auto-prompt honours it; a
     *  forced (Settings) check ignores it. */
    fun skippedUpdateVersion(ctx: Context): Int =
        state(ctx).getInt(KEY_SKIPPED_UPDATE, -1)

    fun setSkippedUpdateVersion(ctx: Context, versionCode: Int) {
        state(ctx).edit().putInt(KEY_SKIPPED_UPDATE, versionCode).apply()
    }
}
