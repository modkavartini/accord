package com.accord.app

import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * In-app "OTA" updater for the sideloaded APK.
 *
 * Accord is distributed as a GitHub-hosted APK, not through Play, so it updates
 * itself: it reads a small JSON manifest (app-release.json on the site) for the
 * newest [UpdateInfo.versionCode], and if that's higher than this build, offers
 * to download that release's APK and hand it to the system package installer.
 *
 * Android still shows its own install confirmation — a sideloaded app cannot
 * install silently unless it's a device owner — so this isn't a fully silent
 * update; it just removes the manual "find the APK, download, open it" dance.
 *
 * The downloaded APK must be signed with the same key as the installed app or
 * Android refuses to update over the top. Release builds are, so this works;
 * a debug-signed dev install can't be updated by a release APK (expected).
 *
 * Progress codes passed to the download callback:
 *   0..100  download percent   ·   100 = done (installer launched)
 *   [FAILED]        download failed
 *   [NEEDS_PERMISSION]  "install unknown apps" not granted; user was sent to
 *                       the setting and should re-tap Update afterwards
 */
object AppUpdater {

    const val FAILED = -1
    const val NEEDS_PERMISSION = -2

    data class UpdateInfo(
        val versionCode: Int,
        val versionName: String,
        val apkUrl: String,
        val notes: String,
    )

    private const val CHECK_INTERVAL_MS = 6L * 60 * 60 * 1000 // 6h
    private const val APK_FILE = "Accord-update.apk"

    /**
     * Fetch the manifest off the main thread and compare to this build.
     * [onResult] runs on the main thread with the newer build, or null when
     * there's nothing to offer (up to date / network error / throttled, or the
     * user already skipped this version and [force] is false).
     */
    fun checkForUpdate(context: Context, force: Boolean, onResult: (UpdateInfo?) -> Unit) {
        val ctx = context.applicationContext
        if (!force &&
            System.currentTimeMillis() - Prefs.lastUpdateCheck(ctx) < CHECK_INTERVAL_MS) {
            onResult(null); return
        }
        thread(name = "accord-update-check") {
            val info = runCatching { fetchManifest() }.getOrNull()
            Prefs.setLastUpdateCheck(ctx, System.currentTimeMillis())
            val newer = info
                ?.takeIf { it.versionCode > BuildConfig.VERSION_CODE }
                ?.takeIf { force || it.versionCode != Prefs.skippedUpdateVersion(ctx) }
            Handler(Looper.getMainLooper()).post { onResult(newer) }
        }
    }

    private fun fetchManifest(): UpdateInfo? {
        val conn = (URL(BuildConfig.UPDATE_MANIFEST_URL).openConnection() as HttpURLConnection).apply {
            connectTimeout = 8_000
            readTimeout = 8_000
            requestMethod = "GET"
            setRequestProperty("Accept", "application/json")
        }
        try {
            if (conn.responseCode != HttpURLConnection.HTTP_OK) return null
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val json = JSONObject(body)
            val versionCode = json.optInt("versionCode", -1)
            val apkUrl = json.optString("apkUrl", "")
            if (versionCode < 0 || apkUrl.isBlank()) return null
            return UpdateInfo(
                versionCode = versionCode,
                versionName = json.optString("versionName", "?"),
                apkUrl = apkUrl,
                notes = json.optString("notes", ""),
            )
        } finally {
            conn.disconnect()
        }
    }

    fun skip(context: Context, info: UpdateInfo) =
        Prefs.setSkippedUpdateVersion(context.applicationContext, info.versionCode)

    /**
     * Ensure "install unknown apps" is granted (API 26+), then download the APK
     * and launch the installer when it lands. [onProgress] is always called on
     * the main thread.
     */
    fun downloadAndInstall(activity: Activity, info: UpdateInfo, onProgress: (Int) -> Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !activity.packageManager.canRequestPackageInstalls()) {
            runCatching {
                activity.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:${activity.packageName}"),
                    )
                )
            }
            onProgress(NEEDS_PERMISSION)
            return
        }

        val dm = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
        val target = File(dir, APK_FILE)
        if (target.exists()) target.delete()

        val request = DownloadManager.Request(Uri.parse(info.apkUrl)).apply {
            setTitle("Accord ${info.versionName}")
            setDescription("Downloading update…")
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
            setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, APK_FILE)
            setMimeType("application/vnd.android.package-archive")
        }
        val id = runCatching { dm.enqueue(request) }.getOrElse { onProgress(FAILED); return }
        pollDownload(activity, dm, id, target, onProgress)
    }

    private fun pollDownload(
        activity: Activity,
        dm: DownloadManager,
        id: Long,
        file: File,
        onProgress: (Int) -> Unit,
    ) {
        val handler = Handler(Looper.getMainLooper())
        handler.post(object : Runnable {
            override fun run() {
                if (activity.isFinishing || activity.isDestroyed) return
                val cursor = runCatching { dm.query(DownloadManager.Query().setFilterById(id)) }
                    .getOrNull()
                if (cursor == null || !cursor.moveToFirst()) { cursor?.close(); onProgress(FAILED); return }
                cursor.use { c ->
                    when (c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))) {
                        DownloadManager.STATUS_SUCCESSFUL -> {
                            onProgress(100)
                            launchInstaller(activity, file)
                        }
                        DownloadManager.STATUS_FAILED -> onProgress(FAILED)
                        else -> {
                            val soFar = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                            val total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                            if (total > 0) onProgress(((soFar * 100) / total).toInt().coerceIn(0, 99))
                            handler.postDelayed(this, 500)
                        }
                    }
                }
            }
        })
    }

    private fun launchInstaller(activity: Activity, file: File) {
        val uri = runCatching {
            FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        }.getOrNull() ?: return
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        runCatching { activity.startActivity(intent) }
    }
}
