package ai.edgez.react_native_sdk

import android.content.Context
import android.net.Uri
import android.net.LocalSocket
import android.net.LocalSocketAddress
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

internal class UsbIpWebSocketBridge(
    private val context: Context,
    private val eventListener: (state: String, message: String?) -> Unit,
) : Closeable {
    companion object {
        private const val MAX_QUEUED_BYTES = 4L * 1024L * 1024L
        private const val READ_BUFFER_BYTES = 64 * 1024
        private const val FRAME_HEADER_BYTES = 8
        private const val FRAME_VERSION: Byte = 1
        private const val FRAME_ARTIFACT: Byte = 1
        private const val FRAME_USB_IP: Byte = 2
        private val FRAME_MAGIC = byteArrayOf('E'.code.toByte(), 'Z'.code.toByte(), 'U'.code.toByte(), 'F'.code.toByte())
    }

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val closed = AtomicBoolean(false)
    private val writeLock = Any()
    private val creditLock = Object()
    private var uploadCredit = 0L
    @Volatile private var webSocket: WebSocket? = null
    @Volatile private var localSocket: LocalSocket? = null

    fun start(url: String, token: String, busId: String, socketName: String) {
        require(url.startsWith("wss://")) { "USB flash tunnel URL must use wss://" }
        require(token.isNotBlank()) { "USB flash tunnel token is required" }
        require(busId.matches(Regex("^[0-9]+-[0-9]+$"))) { "Invalid USB bus ID" }
        check(webSocket == null) { "USB flash tunnel is already running" }

        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .header("X-EdgeZ-USB-Role", "mobile")
            .header("X-EdgeZ-USB-Bus-ID", busId)
            .build()
        eventListener("connecting", null)
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(socket: WebSocket, response: Response) {
                if (closed.get()) {
                    socket.close(1000, "Tunnel stopped")
                    return
                }
                socket.send(JSONObject(mapOf("type" to "hello", "role" to "mobile", "busId" to busId)).toString())
                runCatching {
                    LocalSocket().also {
                        it.connect(LocalSocketAddress(socketName, LocalSocketAddress.Namespace.ABSTRACT))
                        localSocket = it
                    }
                }.fold(
                    onSuccess = { local ->
                        eventListener("connected", null)
                        pumpLocalToWebSocket(local, socket)
                    },
                    onFailure = { error ->
                        eventListener("failed", error.message)
                        socket.close(1011, "USB/IP socket unavailable")
                    },
                )
            }

            override fun onMessage(socket: WebSocket, bytes: ByteString) {
                val local = localSocket ?: return
                runCatching {
                    val (kind, payload) = decodeFrame(bytes.toByteArray())
                    check(kind == FRAME_USB_IP) { "Unexpected WebSocket frame type $kind" }
                    synchronized(writeLock) {
                        local.outputStream.write(payload)
                        local.outputStream.flush()
                    }
                }.onFailure {
                    eventListener("failed", it.message)
                    close()
                }
            }

            override fun onMessage(socket: WebSocket, text: String) {
                runCatching {
                    val message = JSONObject(text)
                    if (message.optString("type") == "flash.status" && message.optString("state") == "uploading") {
                        val credit = message.optLong("credit", 0)
                        if (credit > 0) synchronized(creditLock) {
                            uploadCredit += credit
                            creditLock.notifyAll()
                        }
                    }
                }
                eventListener("message", text.take(1024))
            }

            override fun onClosing(socket: WebSocket, code: Int, reason: String) {
                socket.close(code, reason)
            }

            override fun onClosed(socket: WebSocket, code: Int, reason: String) {
                closeLocalSocket()
                if (!closed.get()) eventListener("disconnected", "$code $reason".trim())
            }

            override fun onFailure(socket: WebSocket, error: Throwable, response: Response?) {
                closeLocalSocket()
                if (!closed.get()) eventListener("failed", error.message)
            }
        })
    }

    private fun pumpLocalToWebSocket(local: LocalSocket, socket: WebSocket) {
        thread(name = "edgez-usb-ip-wss", isDaemon = true) {
            val buffer = ByteArray(READ_BUFFER_BYTES)
            runCatching {
                while (!closed.get()) {
                    while (!closed.get() && socket.queueSize() >= MAX_QUEUED_BYTES) Thread.sleep(10)
                    val count = local.inputStream.read(buffer)
                    if (count < 0) break
                    check(socket.send(encodeFrame(FRAME_USB_IP, buffer, count).toByteString())) { "WebSocket rejected USB/IP data" }
                }
            }.onFailure {
                if (!closed.get()) eventListener("failed", it.message)
            }
            if (!closed.get()) socket.close(1000, "USB/IP stream ended")
        }
    }

    private fun closeLocalSocket() {
        runCatching { localSocket?.shutdownInput() }
        runCatching { localSocket?.shutdownOutput() }
        runCatching { localSocket?.close() }
        localSocket = null
    }

    fun sendUsbEvent(event: String) {
        if (closed.get()) return
        webSocket?.send(JSONObject(mapOf("type" to "usb-event", "event" to event)).toString())
    }

    fun startFlash(jobId: String, profile: String, firmwareUri: String, size: Long, sha256: String) {
        require(jobId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"))) { "Invalid flash job ID" }
        require(profile.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"))) { "Invalid flash profile" }
        require(size > 0) { "Firmware size must be positive" }
        require(sha256.matches(Regex("^[a-fA-F0-9]{64}$"))) { "Firmware SHA-256 is invalid" }
        val socket = webSocket ?: error("USB flash tunnel is not running")
        synchronized(creditLock) { uploadCredit = 0 }
        check(socket.send(JSONObject(mapOf(
            "type" to "flash.start",
            "jobId" to jobId,
            "profile" to profile,
            "size" to size,
            "sha256" to sha256.lowercase(),
        )).toString())) { "WebSocket rejected flash.start" }

        thread(name = "edgez-firmware-upload", isDaemon = true) {
            runCatching {
                openFirmware(firmwareUri).use { input -> uploadFirmware(socket, input, size) }
                check(socket.send(JSONObject(mapOf("type" to "flash.upload.complete", "jobId" to jobId)).toString())) {
                    "WebSocket rejected flash.upload.complete"
                }
            }.onFailure { error ->
                socket.send(JSONObject(mapOf("type" to "flash.cancel", "jobId" to jobId)).toString())
                if (!closed.get()) eventListener("failed", error.message)
            }
        }
    }

    fun startReleaseFlash(jobId: String, profile: String, firmwareUrl: String, sha256: String) {
        require(jobId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"))) { "Invalid flash job ID" }
        require(profile.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"))) { "Invalid flash profile" }
        require(firmwareUrl.matches(Regex("^https://github\\.com/[^/]+/[^/]+/releases/download/[^/]+/[^/]+$"))) {
            "Firmware URL must be a versioned GitHub release asset"
        }
        require(sha256.matches(Regex("^[a-fA-F0-9]{64}$"))) { "Firmware SHA-256 is invalid" }
        val socket = webSocket ?: error("USB flash tunnel is not running")
        check(socket.send(JSONObject(mapOf(
            "type" to "flash.start",
            "jobId" to jobId,
            "profile" to profile,
            "firmwareUrl" to firmwareUrl,
            "sha256" to sha256.lowercase(),
        )).toString())) { "WebSocket rejected flash.start" }
    }

    fun cancelFlash(jobId: String) {
        webSocket?.send(JSONObject(mapOf("type" to "flash.cancel", "jobId" to jobId)).toString())
    }

    private fun uploadFirmware(socket: WebSocket, input: InputStream, expectedSize: Long) {
        val buffer = ByteArray(READ_BUFFER_BYTES)
        var sent = 0L
        while (!closed.get()) {
            val count = input.read(buffer)
            if (count < 0) break
            waitForCredit(count)
            while (!closed.get() && socket.queueSize() >= MAX_QUEUED_BYTES) Thread.sleep(10)
            check(socket.send(encodeFrame(FRAME_ARTIFACT, buffer, count).toByteString())) {
                "WebSocket rejected firmware chunk"
            }
            sent += count
        }
        check(!closed.get()) { "USB flash tunnel stopped during upload" }
        check(sent == expectedSize) { "Firmware size changed during upload: expected $expectedSize, sent $sent" }
    }

    private fun waitForCredit(bytes: Int) {
        synchronized(creditLock) {
            while (!closed.get() && uploadCredit < bytes) creditLock.wait(1_000)
            check(!closed.get()) { "USB flash tunnel stopped while waiting for upload credit" }
            uploadCredit -= bytes
        }
    }

    private fun openFirmware(value: String): InputStream {
        val uri = Uri.parse(value)
        return when (uri.scheme?.lowercase()) {
            "content", "android.resource" -> context.contentResolver.openInputStream(uri)
                ?: error("Unable to open firmware URI")
            "file" -> FileInputStream(File(requireNotNull(uri.path) { "Firmware file URI has no path" }))
            null, "" -> FileInputStream(File(value))
            else -> error("Unsupported firmware URI scheme: ${uri.scheme}")
        }
    }

    private fun encodeFrame(kind: Byte, payload: ByteArray, count: Int): ByteArray {
        val frame = ByteArray(FRAME_HEADER_BYTES + count)
        System.arraycopy(FRAME_MAGIC, 0, frame, 0, FRAME_MAGIC.size)
        frame[4] = FRAME_VERSION
        frame[5] = kind
        System.arraycopy(payload, 0, frame, FRAME_HEADER_BYTES, count)
        return frame
    }

    private fun decodeFrame(frame: ByteArray): Pair<Byte, ByteArray> {
        require(frame.size >= FRAME_HEADER_BYTES) { "WebSocket binary frame is too short" }
        require(FRAME_MAGIC.indices.all { frame[it] == FRAME_MAGIC[it] }) { "WebSocket binary frame has invalid magic" }
        require(frame[4] == FRAME_VERSION) { "Unsupported WebSocket frame version" }
        require(frame[6] == 0.toByte() && frame[7] == 0.toByte()) { "WebSocket frame flags are unsupported" }
        return frame[5] to frame.copyOfRange(FRAME_HEADER_BYTES, frame.size)
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        synchronized(creditLock) { creditLock.notifyAll() }
        closeLocalSocket()
        webSocket?.close(1000, "Tunnel stopped")
        webSocket = null
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
        eventListener("stopped", null)
    }
}
