package ai.edgez.react_native_sdk

import android.content.Context
import android.net.Uri
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

internal class UsbIpWebSocketBridge(
    private val context: Context,
    private val usbIpServer: UsbIpServer,
    private val eventListener: (state: String, message: String?) -> Unit,
) : Closeable {
    companion object {
        private const val TAG = "EdgezReactNativeSdk"
        private const val MAX_QUEUED_BYTES = 4L * 1024L * 1024L
        private const val MAX_PENDING_LOCAL_FRAMES = 512
        private const val MAX_PENDING_WEBSOCKET_FRAMES = 512
        private const val READ_BUFFER_BYTES = 64 * 1024
        private const val MAX_WEBSOCKET_BATCH_BYTES = 256 * 1024
        private const val WEBSOCKET_BATCH_DELAY_NANOS = 2_000_000L
        private const val METRICS_INTERVAL_MS = 5_000L
        private const val FRAME_HEADER_BYTES = 8
        private const val FRAME_VERSION: Byte = 1
        private const val FRAME_ARTIFACT: Byte = 1
        private const val FRAME_USB_IP: Byte = 2
        private const val FRAME_DEVICE_ARTIFACT: Byte = 3
        private val FRAME_MAGIC = byteArrayOf('E'.code.toByte(), 'Z'.code.toByte(), 'U'.code.toByte(), 'F'.code.toByte())
    }

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val closed = AtomicBoolean(false)
    private val creditLock = Object()
    private val localWriteQueue = ArrayBlockingQueue<ByteArray>(MAX_PENDING_LOCAL_FRAMES)
    private val websocketSendQueue = ArrayBlockingQueue<ByteArray>(MAX_PENDING_WEBSOCKET_FRAMES)
    private val remoteFramesReceived = AtomicLong()
    private val remoteBytesReceived = AtomicLong()
    private val localWriteCalls = AtomicLong()
    private val localWriteBytes = AtomicLong()
    private val localWriteNanos = AtomicLong()
    private val localReadCalls = AtomicLong()
    private val localReadBytes = AtomicLong()
    private val websocketSendCalls = AtomicLong()
    private val websocketSendChunks = AtomicLong()
    private val websocketSendBytes = AtomicLong()
    private val websocketSendNanos = AtomicLong()
    private val websocketBackpressureNanos = AtomicLong()
    private val localWriteQueueHighWater = AtomicInteger()
    private val websocketSendQueueHighWater = AtomicInteger()
    private var uploadCredit = 0L
    @Volatile private var webSocket: WebSocket? = null
    @Volatile private var localSocket: LocalSocket? = null
    @Volatile private var localWriterThread: Thread? = null
    @Volatile private var localReaderThread: Thread? = null
    @Volatile private var websocketSenderThread: Thread? = null
    @Volatile private var metricsThread: Thread? = null
    @Volatile private var deviceFlashUpload: DeviceFlashUpload? = null
    @Volatile private var bridgeSocketName: String? = null
    @Volatile private var bridgeBusId: String? = null
    @Volatile private var activeDeviceFlashRequestId: String? = null
    @Volatile private var activeDeviceFlashJobId: String? = null
    private val deviceFlashCancelled = AtomicBoolean(false)

    private data class DeviceFlashUpload(
        val requestId: String,
        val jobId: String,
        val action: String,
        val expectedSize: Long,
        val expectedSha256: String,
        val file: File,
        val output: FileOutputStream,
        val digest: MessageDigest = MessageDigest.getInstance("SHA-256"),
        var received: Long = 0,
    )

    fun start(url: String, token: String, busId: String, socketName: String) {
        require(url.startsWith("wss://")) { "USB flash tunnel URL must use wss://" }
        require(token.isNotBlank()) { "USB flash tunnel token is required" }
        require(busId.matches(Regex("^[0-9]+-[0-9]+$"))) { "Invalid USB bus ID" }
        check(webSocket == null) { "USB flash tunnel is already running" }
        bridgeSocketName = socketName
        bridgeBusId = busId

        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .header("X-EdgeZ-USB-Role", "mobile")
            .header("X-EdgeZ-USB-Bus-ID", busId)
            .build()
        eventListener("connecting", null)
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(socket: WebSocket, response: Response) {
                Log.i(TAG, "USB flash WebSocket opened url=$url busid=$busId")
                if (closed.get()) {
                    socket.cancel()
                    return
                }
                socket.send(JSONObject(mapOf("type" to "hello", "role" to "mobile", "busId" to busId)).toString())
                connectLocalBridge(socket, socketName, closeOnFailure = true)
            }

            override fun onMessage(socket: WebSocket, bytes: ByteString) {
                runCatching {
                    val (kind, payload) = decodeFrame(bytes.toByteArray())
                    if (kind == FRAME_DEVICE_ARTIFACT) {
                        appendDeviceFlashArtifact(payload)
                        return@runCatching
                    }
                    check(kind == FRAME_USB_IP) { "Unexpected WebSocket frame type $kind" }
                    check(localSocket != null) { "USB/IP local socket is unavailable" }
                    check(localWriteQueue.offer(payload)) { "USB/IP local write queue is full" }
                    remoteFramesReceived.incrementAndGet()
                    remoteBytesReceived.addAndGet(payload.size.toLong())
                    observeHighWater(localWriteQueueHighWater, localWriteQueue.size)
                }.onFailure {
                    eventListener("failed", it.message)
                    close()
                }
            }

            override fun onMessage(socket: WebSocket, text: String) {
                runCatching {
                    val message = JSONObject(text)
                    if (message.optString("type") == "device.control.request") {
                        handleDeviceControl(socket, busId, message)
                        return
                    }
                    if (message.optString("type") == "device.flash.request") {
                        beginDeviceFlash(message)
                        return
                    }
                    if (message.optString("type") == "device.flash.artifact.complete") {
                        completeDeviceFlash(socket, busId, message)
                        return
                    }
                    if (message.optString("type") == "device.flash.cancel") {
                        cancelDeviceFlash(message)
                        return
                    }
                    if (message.optString("type") == "flash.status" && message.optString("state") == "uploading") {
                        val credit = message.optLong("credit", 0)
                        if (credit > 0) synchronized(creditLock) {
                            uploadCredit += credit
                            creditLock.notifyAll()
                        }
                    }
                }.onFailure {
                    eventListener("failed", it.message)
                    close()
                    return
                }
                eventListener("message", text.take(1024))
            }

            override fun onClosing(socket: WebSocket, code: Int, reason: String) {
                socket.close(code, reason)
            }

            override fun onClosed(socket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "USB flash WebSocket closed code=$code reason=$reason")
                closeLocalSocket()
                if (!closed.get()) eventListener("disconnected", "$code $reason".trim())
            }

            override fun onFailure(socket: WebSocket, error: Throwable, response: Response?) {
                Log.e(TAG, "USB flash WebSocket failed http=${response?.code}", error)
                closeLocalSocket()
                if (!closed.get()) eventListener("failed", error.message)
            }
        })
    }

    private fun pumpWebSocketToLocal(local: LocalSocket, socket: WebSocket) {
        localWriterThread = thread(name = "edgez-wss-usb-ip", isDaemon = true) {
            runCatching {
                while (!closed.get() && localSocket === local) {
                    val payload = localWriteQueue.poll(250, TimeUnit.MILLISECONDS) ?: continue
                    val writeStarted = System.nanoTime()
                    local.outputStream.write(payload)
                    local.outputStream.flush()
                    localWriteNanos.addAndGet(System.nanoTime() - writeStarted)
                    localWriteCalls.incrementAndGet()
                    localWriteBytes.addAndGet(payload.size.toLong())
                }
            }.onFailure {
                if (!closed.get() && localSocket === local) eventListener("failed", it.message)
            }
            if (!closed.get() && localSocket === local) socket.close(1011, "USB/IP local write failed")
        }
    }

    private fun pumpLocalToWebSocket(local: LocalSocket, socket: WebSocket) {
        websocketSenderThread = thread(name = "edgez-usb-ip-wss-sender", isDaemon = true) {
            runCatching {
                while (!closed.get() && localSocket === local) {
                    val first = websocketSendQueue.poll(250, TimeUnit.MILLISECONDS) ?: continue
                    val chunks = ArrayList<ByteArray>(4)
                    chunks.add(first)
                    var totalBytes = first.size
                    val deadline = System.nanoTime() + WEBSOCKET_BATCH_DELAY_NANOS
                    while (chunks.size * READ_BUFFER_BYTES < MAX_WEBSOCKET_BATCH_BYTES) {
                        val remaining = deadline - System.nanoTime()
                        if (remaining <= 0) break
                        val next = websocketSendQueue.poll(remaining, TimeUnit.NANOSECONDS) ?: break
                        chunks.add(next)
                        totalBytes += next.size
                    }
                    val backpressureStarted = System.nanoTime()
                    while (!closed.get() && socket.queueSize() >= MAX_QUEUED_BYTES) Thread.sleep(10)
                    websocketBackpressureNanos.addAndGet(System.nanoTime() - backpressureStarted)
                    val payload = if (chunks.size == 1) first else ByteArrayOutputStream(totalBytes).use { batch ->
                        chunks.forEach { batch.write(it) }
                        batch.toByteArray()
                    }
                    val sendStarted = System.nanoTime()
                    check(socket.send(encodeFrame(FRAME_USB_IP, payload, payload.size).toByteString())) {
                        "WebSocket rejected USB/IP data"
                    }
                    websocketSendNanos.addAndGet(System.nanoTime() - sendStarted)
                    websocketSendCalls.incrementAndGet()
                    websocketSendChunks.addAndGet(chunks.size.toLong())
                    websocketSendBytes.addAndGet(payload.size.toLong())
                }
            }.onFailure {
                if (!closed.get() && localSocket === local) eventListener("failed", it.message)
            }
            if (!closed.get() && localSocket === local) socket.close(1011, "USB/IP WebSocket send failed")
        }

        localReaderThread = thread(name = "edgez-usb-ip-wss-reader", isDaemon = true) {
            val buffer = ByteArray(READ_BUFFER_BYTES)
            runCatching {
                while (!closed.get() && localSocket === local) {
                    val count = local.inputStream.read(buffer)
                    if (count < 0) break
                    localReadCalls.incrementAndGet()
                    localReadBytes.addAndGet(count.toLong())
                    check(websocketSendQueue.offer(buffer.copyOf(count), 5, TimeUnit.SECONDS)) {
                        "USB/IP WebSocket send queue is full"
                    }
                    observeHighWater(websocketSendQueueHighWater, websocketSendQueue.size)
                }
            }.onFailure {
                if (!closed.get() && localSocket === local) eventListener("failed", it.message)
            }
            if (!closed.get() && localSocket === local) socket.close(1000, "USB/IP stream ended")
        }
    }

    private fun closeLocalSocket() {
        metricsThread?.interrupt()
        metricsThread = null
        localWriterThread?.interrupt()
        localWriterThread = null
        localReaderThread?.interrupt()
        localReaderThread = null
        websocketSenderThread?.interrupt()
        websocketSenderThread = null
        localWriteQueue.clear()
        websocketSendQueue.clear()
        runCatching { localSocket?.shutdownInput() }
        runCatching { localSocket?.shutdownOutput() }
        runCatching { localSocket?.close() }
        localSocket = null
    }

    private fun connectLocalBridge(socket: WebSocket, socketName: String, closeOnFailure: Boolean): Throwable? {
        return runCatching {
            LocalSocket().also {
                it.connect(LocalSocketAddress(socketName, LocalSocketAddress.Namespace.ABSTRACT))
                localSocket = it
            }
        }.fold(
            onSuccess = { local ->
                Log.i(TAG, "USB flash bridge connected to local socket @$socketName")
                eventListener("connected", null)
                startMetrics(local, socket)
                pumpWebSocketToLocal(local, socket)
                pumpLocalToWebSocket(local, socket)
                null
            },
            onFailure = { error ->
                Log.e(TAG, "USB flash bridge could not connect to local socket @$socketName", error)
                eventListener("failed", error.message)
                if (closeOnFailure) socket.close(1011, "USB/IP socket unavailable")
                error
            },
        )
    }

    private fun startMetrics(local: LocalSocket, socket: WebSocket) {
        metricsThread?.interrupt()
        metricsThread = thread(name = "edgez-usb-ip-metrics", isDaemon = true) {
            while (!closed.get() && localSocket === local) {
                try {
                    Thread.sleep(METRICS_INTERVAL_MS)
                } catch (_: InterruptedException) {
                    break
                }
                val seconds = METRICS_INTERVAL_MS / 1_000.0
                val incomingFrames = remoteFramesReceived.getAndSet(0)
                val incomingBytes = remoteBytesReceived.getAndSet(0)
                val writes = localWriteCalls.getAndSet(0)
                val writtenBytes = localWriteBytes.getAndSet(0)
                val writeNanos = localWriteNanos.getAndSet(0)
                val reads = localReadCalls.getAndSet(0)
                val readBytes = localReadBytes.getAndSet(0)
                val sends = websocketSendCalls.getAndSet(0)
                val chunks = websocketSendChunks.getAndSet(0)
                val sentBytes = websocketSendBytes.getAndSet(0)
                val sendNanos = websocketSendNanos.getAndSet(0)
                val backpressureNanos = websocketBackpressureNanos.getAndSet(0)
                val incomingHighWater = localWriteQueueHighWater.getAndSet(localWriteQueue.size)
                val outgoingHighWater = websocketSendQueueHighWater.getAndSet(websocketSendQueue.size)
                Log.i(TAG, "USB/IP metrics " +
                    "remoteToLocal=${formatRate(incomingBytes, seconds)} frames=$incomingFrames " +
                    "localWrites=$writes/${formatRate(writtenBytes, seconds)} avgWriteMs=${formatMillis(writeNanos, writes)} " +
                    "inQueue=${localWriteQueue.size}/$incomingHighWater " +
                    "localToRemote=${formatRate(readBytes, seconds)} reads=$reads " +
                    "wsSends=$sends chunks=$chunks batch=${formatRatio(chunks, sends)}x " +
                    "sent=${formatRate(sentBytes, seconds)} avgSendMs=${formatMillis(sendNanos, sends)} " +
                    "outQueue=${websocketSendQueue.size}/$outgoingHighWater " +
                    "okhttpQueue=${socket.queueSize()} backpressureMs=${backpressureNanos / 1_000_000}")
            }
        }
    }

    private fun observeHighWater(highWater: AtomicInteger, value: Int) {
        highWater.getAndUpdate { previous -> maxOf(previous, value) }
    }

    private fun formatRate(bytes: Long, seconds: Double): String = "%.1fKiB/s".format(bytes / 1024.0 / seconds)

    private fun formatMillis(nanos: Long, count: Long): String =
        if (count == 0L) "0.000" else "%.3f".format(nanos / 1_000_000.0 / count)

    private fun formatRatio(total: Long, count: Long): String =
        if (count == 0L) "0.00" else "%.2f".format(total.toDouble() / count)

    fun sendUsbEvent(event: String) {
        if (closed.get()) return
        webSocket?.send(JSONObject(mapOf("type" to "usb-event", "event" to event)).toString())
    }

    fun startFlash(jobId: String, profile: String, baudRate: Int, ackWindow: Int, timeoutSeconds: Int, esptoolConfig: String, firmwareUri: String, size: Long, sha256: String) {
        require(jobId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"))) { "Invalid flash job ID" }
        require(profile.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"))) { "Invalid flash profile" }
        require(size > 0) { "Firmware size must be positive" }
        require(sha256.matches(Regex("^[a-fA-F0-9]{64}$"))) { "Firmware SHA-256 is invalid" }
        val isEspProfile = profile.startsWith("esp32")
        if (isEspProfile) {
            require(baudRate in setOf(115200, 230400, 460800, 921600)) { "Unsupported ESP flash baud rate" }
            require(ackWindow in 1..8) { "ESP flash ACK window must be between 1 and 8" }
            require(esptoolConfig in setOf("standard", "high-latency")) { "Unsupported esptool configuration preset" }
        }
        require(timeoutSeconds in 60..1800) { "Flash timeout must be between 1 and 30 minutes" }
        val socket = webSocket ?: error("USB flash tunnel is not running")
        synchronized(creditLock) { uploadCredit = 0 }
        val request = mutableMapOf<String, Any>(
            "type" to "flash.start",
            "jobId" to jobId,
            "profile" to profile,
            "timeoutSeconds" to timeoutSeconds,
            "size" to size,
            "sha256" to sha256.lowercase(),
        )
        if (isEspProfile) {
            request["baudRate"] = baudRate
            request["ackWindow"] = ackWindow
            request["esptoolConfig"] = esptoolConfig
        }
        check(socket.send(JSONObject(request).toString())) { "WebSocket rejected flash.start" }

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

    fun startReleaseFlash(jobId: String, profile: String, baudRate: Int, ackWindow: Int, timeoutSeconds: Int, esptoolConfig: String, firmwareUrl: String, sha256: String) {
        require(jobId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"))) { "Invalid flash job ID" }
        require(profile.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"))) { "Invalid flash profile" }
        require(firmwareUrl.matches(Regex("^https://github\\.com/[^/]+/[^/]+/releases/download/[^/]+/[^/]+$"))) {
            "Firmware URL must be a versioned GitHub release asset"
        }
        require(sha256.matches(Regex("^[a-fA-F0-9]{64}$"))) { "Firmware SHA-256 is invalid" }
        val isEspProfile = profile.startsWith("esp32")
        if (isEspProfile) {
            require(baudRate in setOf(115200, 230400, 460800, 921600)) { "Unsupported ESP flash baud rate" }
            require(ackWindow in 1..8) { "ESP flash ACK window must be between 1 and 8" }
            require(esptoolConfig in setOf("standard", "high-latency")) { "Unsupported esptool configuration preset" }
        }
        require(timeoutSeconds in 60..1800) { "Flash timeout must be between 1 and 30 minutes" }
        val socket = webSocket ?: error("USB flash tunnel is not running")
        val request = mutableMapOf<String, Any>(
            "type" to "flash.start",
            "jobId" to jobId,
            "profile" to profile,
            "timeoutSeconds" to timeoutSeconds,
            "firmwareUrl" to firmwareUrl,
            "sha256" to sha256.lowercase(),
        )
        if (isEspProfile) {
            request["baudRate"] = baudRate
            request["ackWindow"] = ackWindow
            request["esptoolConfig"] = esptoolConfig
        }
        check(socket.send(JSONObject(request).toString())) { "WebSocket rejected flash.start" }
    }

    fun cancelFlash(jobId: String) {
        webSocket?.send(JSONObject(mapOf("type" to "flash.cancel", "jobId" to jobId)).toString())
    }

    private fun handleDeviceControl(socket: WebSocket, busId: String, request: JSONObject) {
        val requestId = request.optString("requestId")
        val action = request.optString("action")
        thread(name = "edgez-usb-device-control", isDaemon = true) {
            val error = runCatching {
                require(requestId.isNotBlank()) { "Missing device control request ID" }
                require(action in setOf(
                    "esp32.enter-bootloader",
                    "esp32.run-app",
                    "esp32.usbip-fast-mode.enable",
                    "esp32.usbip-fast-mode.disable",
                )) {
                    "Unsupported device control action: $action"
                }
                usbIpServer.executeDeviceControl(busId, action)
            }.exceptionOrNull()
            val response = JSONObject().apply {
                put("type", "device.control.result")
                put("requestId", requestId)
                put("success", error == null)
                if (error != null) put("message", error.message ?: error.javaClass.simpleName)
            }
            if (!socket.send(response.toString()) && !closed.get()) {
                eventListener("failed", "WebSocket rejected device control response")
            }
        }
    }

    private fun beginDeviceFlash(request: JSONObject) {
        check(deviceFlashUpload == null) { "Another mobile flash artifact is active" }
        val requestId = request.getString("requestId")
        val jobId = request.getString("jobId")
        val action = request.getString("action")
        val size = request.getLong("size")
        val sha256 = request.getString("sha256").lowercase()
        require(requestId.isNotBlank() && jobId.isNotBlank()) { "Invalid mobile flash request" }
        require(action == "cmsis-dap.nrf54l15.program") { "Unsupported mobile flash action: $action" }
        require(size in 1..64L * 1024L * 1024L) { "Invalid mobile flash artifact size" }
        require(sha256.matches(Regex("^[a-f0-9]{64}$"))) { "Invalid mobile flash SHA-256" }
        val busId = requireNotNull(bridgeBusId) { "USB bridge bus ID is unavailable" }
        // Linux has detached the USB/IP port before this request. Closing the
        // local transport gives Android an explicit connection boundary and
        // releases the probe without closing the authenticated WebSocket.
        closeLocalSocket()
        usbIpServer.releaseImportedDevice(busId)
        val file = File.createTempFile("edgez-cmsis-dap-", ".hex", context.cacheDir)
        activeDeviceFlashRequestId = requestId
        activeDeviceFlashJobId = jobId
        deviceFlashCancelled.set(false)
        deviceFlashUpload = DeviceFlashUpload(
            requestId, jobId, action, size, sha256, file, FileOutputStream(file),
        )
    }

    private fun appendDeviceFlashArtifact(payload: ByteArray) {
        val upload = deviceFlashUpload ?: error("Mobile flash artifact arrived without a request")
        require(payload.isNotEmpty() && upload.received + payload.size <= upload.expectedSize) {
            "Invalid mobile flash artifact chunk"
        }
        upload.output.write(payload)
        upload.digest.update(payload)
        upload.received += payload.size
    }

    private fun completeDeviceFlash(socket: WebSocket, busId: String, request: JSONObject) {
        val upload = deviceFlashUpload ?: error("Mobile flash completion arrived without a request")
        require(request.optString("requestId") == upload.requestId && request.optString("jobId") == upload.jobId) {
            "Mobile flash completion does not match the active request"
        }
        deviceFlashUpload = null
        upload.output.close()
        val digest = upload.digest.digest().joinToString("") { "%02x".format(it) }
        if (upload.received != upload.expectedSize || digest != upload.expectedSha256) {
            upload.file.delete()
            bridgeSocketName?.let { connectLocalBridge(socket, it, closeOnFailure = false) }
            activeDeviceFlashRequestId = null
            activeDeviceFlashJobId = null
            sendDeviceFlashStatus(socket, upload, "failed", "Streamed firmware size or SHA-256 does not match")
            return
        }
        sendDeviceFlashStatus(socket, upload, "verified", "Firmware verified on Android", upload.received)
        thread(name = "edgez-cmsis-dap-programmer", isDaemon = true) {
            var lastReported = 0L
            var lastReportNanos = 0L
            val error = runCatching {
                check(!deviceFlashCancelled.get()) { "CMSIS-DAP programming was cancelled" }
                usbIpServer.programNrf54(busId, upload.file) { completed, total, message ->
                    check(!closed.get() && !deviceFlashCancelled.get()) {
                        "CMSIS-DAP programming was cancelled"
                    }
                    val now = System.nanoTime()
                    if (completed == 0L || completed == total || completed - lastReported >= 64 * 1024 || now - lastReportNanos >= 1_000_000_000L) {
                        lastReported = completed
                        lastReportNanos = now
                        sendDeviceFlashStatus(socket, upload, "flashing", message, completed, total)
                    }
                }
            }.exceptionOrNull()
            upload.file.delete()
            bridgeSocketName?.let { connectLocalBridge(socket, it, closeOnFailure = false) }
            activeDeviceFlashRequestId = null
            activeDeviceFlashJobId = null
            if (deviceFlashCancelled.get()) {
                sendDeviceFlashStatus(socket, upload, "cancelled", "CMSIS-DAP programming was cancelled")
            } else if (error == null) {
                sendDeviceFlashStatus(socket, upload, "complete", "CMSIS-DAP programming and verification complete", upload.expectedSize)
            } else {
                sendDeviceFlashStatus(socket, upload, "failed", error.message ?: error.javaClass.simpleName)
            }
        }
    }

    private fun cancelDeviceFlash(request: JSONObject) {
        if (request.optString("requestId") == activeDeviceFlashRequestId
            && request.optString("jobId") == activeDeviceFlashJobId) {
            deviceFlashCancelled.set(true)
        }
    }

    private fun sendDeviceFlashStatus(
        socket: WebSocket,
        upload: DeviceFlashUpload,
        state: String,
        message: String,
        received: Long = 0,
        size: Long = upload.expectedSize,
    ) {
        val response = JSONObject().apply {
            put("type", "device.flash.status")
            put("requestId", upload.requestId)
            put("jobId", upload.jobId)
            put("state", state)
            put("message", message)
            put("received", received)
            put("size", size)
        }
        check(socket.send(response.toString())) { "WebSocket rejected mobile flash status" }
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
        deviceFlashUpload?.let { upload ->
            runCatching { upload.output.close() }
            upload.file.delete()
        }
        deviceFlashUpload = null
        deviceFlashCancelled.set(true)
        activeDeviceFlashRequestId = null
        activeDeviceFlashJobId = null
        bridgeSocketName = null
        bridgeBusId = null
        closeLocalSocket()
        // cancel() also terminates an HTTP upgrade that is still waiting for a
        // cold organization runtime. close() only works after the WebSocket
        // handshake has completed and can otherwise leave a zombie session.
        webSocket?.cancel()
        webSocket = null
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
        eventListener("stopped", null)
    }
}
