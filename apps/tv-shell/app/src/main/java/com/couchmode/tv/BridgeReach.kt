package com.couchmode.tv

import android.system.ErrnoException
import android.system.OsConstants
import android.util.Log
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket

/**
 * Is the bridge where the settings say it is?
 *
 * Answered with a bare TCP connect rather than a page load. On a LAN it takes
 * milliseconds, so it can run every couple of seconds without a backoff, and it
 * tells apart two failures a WebView error page reports the same way: the
 * computer answering with nothing on the port, and the computer not answering
 * at all. Each one needs the person on the couch to do something different.
 */
enum class BridgeReach {
    /** Something accepted the connection. */
    UP,

    /** The computer answered and refused: it is awake, the bridge is not running. */
    NOT_RUNNING,

    /** No answer or no route: asleep, off, on another network, or a firewall dropping it. */
    UNREACHABLE;

    companion object {
        private const val TAG = "Couchmode"
        private const val TIMEOUT_MS = 2_000

        /** Blocking: call it off the main thread. [host] is `host:port`, as BridgeSettings stores it. */
        fun probe(host: String): BridgeReach {
            val port = host.substringAfterLast(':').toIntOrNull()?.takeIf { it in 1..65535 }
                ?: return UNREACHABLE
            return try {
                Socket().use { it.connect(InetSocketAddress(host.substringBeforeLast(':'), port), TIMEOUT_MS) }
                UP
            } catch (e: IOException) {
                val reach = if (refused(e)) NOT_RUNNING else UNREACHABLE
                Log.i(TAG, "bridge probe: $reach (${e.message})")
                reach
            }
        }

        /**
         * A timed connect on Android throws ConnectException for "refused" and
         * for "no route to host" alike, so the errno underneath is the only
         * thing that tells the two apart.
         */
        private fun refused(e: IOException): Boolean =
            (e.cause as? ErrnoException)?.errno == OsConstants.ECONNREFUSED ||
                e.message?.contains("ECONNREFUSED") == true
    }
}
