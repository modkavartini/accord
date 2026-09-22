package com.accord.app

import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity

/**
 * The user-facing side of [AppUpdater]: the "update available" prompt and the
 * download-progress dialog. Shared by MainActivity (silent auto-check on launch)
 * and SettingsActivity (manual "Check for updates").
 */
object UpdateUi {

    /**
     * Check for an update and, if one is offered, prompt for it.
     * @param force  true for a user-initiated check (Settings) — ignores the
     *   6-hour throttle and the "skip this version" choice, and toasts when
     *   already up to date. false for the quiet launch check.
     */
    fun check(activity: AppCompatActivity, force: Boolean) {
        AppUpdater.checkForUpdate(activity, force) { info ->
            if (activity.isFinishing || activity.isDestroyed) return@checkForUpdate
            if (info == null) {
                if (force) Toast.makeText(
                    activity, activity.getString(R.string.update_up_to_date), Toast.LENGTH_SHORT
                ).show()
                return@checkForUpdate
            }
            showPrompt(activity, info, allowSkip = !force)
        }
    }

    private fun showPrompt(activity: AppCompatActivity, info: AppUpdater.UpdateInfo, allowSkip: Boolean) {
        val message = buildString {
            append(activity.getString(R.string.update_available_body, info.versionName))
            if (info.notes.isNotBlank()) append("\n\n").append(info.notes)
        }
        val builder = AlertDialog.Builder(activity)
            .setTitle(R.string.update_available_title)
            .setMessage(message)
            .setPositiveButton(R.string.update_now) { _, _ -> startDownload(activity, info) }
            .setNegativeButton(R.string.update_later, null)
        if (allowSkip) {
            builder.setNeutralButton(R.string.update_skip) { _, _ -> AppUpdater.skip(activity, info) }
        }
        builder.show()
    }

    private fun startDownload(activity: AppCompatActivity, info: AppUpdater.UpdateInfo) {
        val progress = AlertDialog.Builder(activity)
            .setTitle(R.string.update_downloading_title)
            .setMessage(activity.getString(R.string.update_downloading_body, info.versionName, 0))
            .setCancelable(false)
            .create()
        progress.show()
        AppUpdater.downloadAndInstall(activity, info) { pct ->
            if (activity.isFinishing || activity.isDestroyed) { progress.dismiss(); return@downloadAndInstall }
            when (pct) {
                AppUpdater.NEEDS_PERMISSION -> {
                    progress.dismiss()
                    Toast.makeText(activity, R.string.update_needs_permission, Toast.LENGTH_LONG).show()
                }
                AppUpdater.FAILED -> {
                    progress.dismiss()
                    Toast.makeText(activity, R.string.update_failed, Toast.LENGTH_LONG).show()
                }
                100 -> progress.dismiss() // installer takes over
                else -> progress.setMessage(
                    activity.getString(R.string.update_downloading_body, info.versionName, pct)
                )
            }
        }
    }
}
