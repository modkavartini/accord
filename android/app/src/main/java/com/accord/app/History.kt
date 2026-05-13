package com.accord.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * On-device record of forms the user has auto-filled with Accord. Stored as a
 * JSON array in SharedPreferences — fine for the small sizes involved (capped
 * at MAX_ENTRIES). Most recent first.
 */
object History {
    private const val PREFS = "accord.history"
    private const val KEY   = "entries"
    private const val MAX_ENTRIES = 50

    data class Entry(
        val name: String,
        val formId: String,
        val url: String,
        val filledAt: Long,
    )

    private fun prefs(ctx: Context) =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun list(ctx: Context): List<Entry> {
        val raw = prefs(ctx).getString(KEY, null) ?: return emptyList()
        return runCatching {
            val arr = JSONArray(raw)
            buildList(arr.length()) {
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    val formId = o.optString("formId").orEmpty()
                    if (formId.isEmpty()) continue
                    add(
                        Entry(
                            name     = o.optString("name").orEmpty().ifBlank { "Untitled form" },
                            formId   = formId,
                            url      = o.optString("url").orEmpty(),
                            filledAt = o.optLong("filledAt", 0L),
                        )
                    )
                }
            }
        }.getOrDefault(emptyList())
    }

    /**
     * Record a fill. If an entry already exists for this formId, it's bumped
     * to the top (deduped) — recency matters more than count for "fill again".
     */
    fun add(ctx: Context, name: String, formId: String, url: String) {
        if (formId.isBlank()) return
        val existing = list(ctx).filter { it.formId != formId }
        val updated  = listOf(
            Entry(
                name     = name.ifBlank { "Untitled form" },
                formId   = formId,
                url      = url,
                filledAt = System.currentTimeMillis(),
            )
        ) + existing
        write(ctx, updated.take(MAX_ENTRIES))
    }

    fun clear(ctx: Context) {
        prefs(ctx).edit().remove(KEY).apply()
    }

    private fun write(ctx: Context, entries: List<Entry>) {
        val arr = JSONArray()
        entries.forEach { e ->
            arr.put(
                JSONObject().apply {
                    put("name",     e.name)
                    put("formId",   e.formId)
                    put("url",      e.url)
                    put("filledAt", e.filledAt)
                }
            )
        }
        prefs(ctx).edit().putString(KEY, arr.toString()).apply()
    }
}
