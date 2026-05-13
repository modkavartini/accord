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
}
