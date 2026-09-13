package com.couchmode.tv

import android.content.Context
import android.content.SharedPreferences

/**
 * Where the bridge is and how to pair with it.
 *
 * Couchmode never handles credentials. The pair code is a LAN handshake token
 * printed by the bridge, not a secret belonging to any agent or account.
 */
data class BridgeSettings(
    val host: String,
    val code: String,
) {
    /** The /tv URL, with the pair code passed through so the TV pairs itself. */
    fun tvUrl(): String = "http://$host/tv?code=$code"

    val isComplete: Boolean
        get() = host.isNotBlank() && code.isNotBlank()

    companion object {
        private const val PREFS = "couchmode"
        private const val KEY_HOST = "host"
        private const val KEY_CODE = "code"
        private const val DEFAULT_PORT = "7777"

        fun load(context: Context): BridgeSettings {
            val prefs = prefs(context)
            return BridgeSettings(
                host = prefs.getString(KEY_HOST, "").orEmpty(),
                code = prefs.getString(KEY_CODE, "").orEmpty(),
            )
        }

        fun save(context: Context, settings: BridgeSettings) {
            prefs(context).edit()
                .putString(KEY_HOST, settings.host)
                .putString(KEY_CODE, settings.code)
                .apply()
        }

        private fun prefs(context: Context): SharedPreferences =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        /**
         * Accept what a person would actually type with a remote: a bare IP,
         * an IP with a port, or a pasted URL. Default to the bridge's own
         * default port when none is given.
         */
        fun normaliseHost(input: String): String {
            var value = input.trim()
                .removePrefix("http://")
                .removePrefix("https://")
                .trimEnd('/')
            if (value.contains('/')) value = value.substringBefore('/')
            if (value.isEmpty()) return ""
            return if (value.contains(':')) value else "$value:$DEFAULT_PORT"
        }
    }
}
