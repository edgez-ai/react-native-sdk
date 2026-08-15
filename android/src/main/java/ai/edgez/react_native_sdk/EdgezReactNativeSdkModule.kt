package ai.edgez.react_native_sdk

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationManager
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.location.LocationManager
import android.os.Build
import android.os.ParcelUuid
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.io.File
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

private val SERVICE = UUID.fromString("0000fff0-0000-1000-8000-00805f9b34fb")
private val RX = UUID.fromString("0000fff1-0000-1000-8000-00805f9b34fb")
private val TX = UUID.fromString("0000fff2-0000-1000-8000-00805f9b34fb")
private val FORWARD_TX = UUID.fromString("0000fff4-0000-1000-8000-00805f9b34fb")
private val OTA = UUID.fromString("0000fff5-0000-1000-8000-00805f9b34fb")
private val OTA_STATUS = UUID.fromString("0000fff6-0000-1000-8000-00805f9b34fb")
private val VOICE_TX = UUID.fromString("0000fff8-0000-1000-8000-00805f9b34fb")
private val CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
private const val REQUEST_BLE = 7301
private const val REQUEST_MIC = 7302
private const val REQUEST_NOTIFICATION = 7303
private const val REQUEST_LOCATION = 7304
private const val MAX_PAYLOAD = 512
private const val VOICE_CODEC_AMR_NB = 1
private const val VOICE_CODEC_OPUS = 2

class EdgezReactNativeSdkModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), PermissionListener {

    private val adapter get() = reactContext.getSystemService(BluetoothManager::class.java)?.adapter
    private var scanCallback: ScanCallback? = null
    private val devices = mutableMapOf<String, BluetoothDevice>()
    private var gatt: BluetoothGatt? = null
    private var rx: BluetoothGattCharacteristic? = null
    private var tx: BluetoothGattCharacteristic? = null
    private var ota: BluetoothGattCharacteristic? = null
    private var negotiatedMtu = 23
    private val descriptorQueue = ArrayDeque<BluetoothGattDescriptor>()
    private val writeQueue = ArrayDeque<ByteArray>()
    private var writeInFlight = false
    private val receive = FrameAccumulator()
    private val forwardReceive = FrameAccumulator()
    private var pendingBle: Pair<ReadableMap, Promise>? = null
    private var pendingMic: Promise? = null
    private var pendingNotification: Promise? = null
    private var pendingLocation: Promise? = null
    private var voiceRecorder: MediaRecorder? = null
    private var voiceRecordingFile: File? = null
    private var voiceRecordingCodec = VOICE_CODEC_AMR_NB
    private var voiceRecordingStartedAt = 0L
    private var voicePlayer: MediaPlayer? = null
    private var connectedLabel = ""
    private val otaLock = Object()
    private var otaWriteStatus: Int? = null
    private val otaRunning = AtomicBoolean(false)
    private val otaAbort = AtomicBoolean(false)
    private var listenerCount = 0

    override fun getName() = "EdgezReactNativeSdk"

    @ReactMethod fun addListener(eventName: String) { listenerCount++ }
    @ReactMethod fun removeListeners(count: Int) { listenerCount = (listenerCount - count).coerceAtLeast(0) }

    @ReactMethod
    fun startBleScan(arguments: ReadableMap, promise: Promise) {
        if (!hasBlePermissions()) {
            val activity = reactContext.currentActivity as? PermissionAwareActivity
            if (activity == null) { promise.reject("activity_missing", "BLE permission requires an activity"); return }
            pendingBle = arguments to promise
            activity.requestPermissions(requiredBlePermissions(), REQUEST_BLE, this)
            return
        }
        startScan(promise)
    }

    @ReactMethod fun stopBleScan(arguments: ReadableMap, promise: Promise) { stopScan(); promise.resolve(null) }

    @SuppressLint("MissingPermission")
    @ReactMethod
    fun connectBle(arguments: ReadableMap, promise: Promise) {
        val id = arguments.getString("deviceId")
        if (id.isNullOrBlank()) { promise.reject("missing_device", "Missing BLE device ID"); return }
        if (!hasBlePermissions()) { promise.reject("permission_denied", "Bluetooth permission denied"); return }
        val device = devices[id] ?: runCatching { adapter?.getRemoteDevice(id) }.getOrNull()
        if (device == null) { promise.reject("device_missing", "BLE device was not found; scan first"); return }
        stopScan(); closeGatt(); connectedLabel = device.name ?: id
        emit(mapOf("type" to "log", "log" to "Connecting BLE $id"))
        gatt = if (Build.VERSION.SDK_INT >= 23) device.connectGatt(reactContext, false, callback, BluetoothDevice.TRANSPORT_LE) else device.connectGatt(reactContext, false, callback)
        promise.resolve(null)
    }

    @ReactMethod fun disconnect(arguments: ReadableMap, promise: Promise) { stopScan(); closeGatt(); emit(mapOf("type" to "connection", "connection" to "none")); promise.resolve(null) }
    @ReactMethod fun initializeMesh(arguments: ReadableMap, promise: Promise) = queuePacket(arguments, promise)
    @ReactMethod fun sendPacket(arguments: ReadableMap, promise: Promise) = queuePacket(arguments, promise)

    @ReactMethod
    fun isOtaReady(arguments: ReadableMap, promise: Promise) { promise.resolve(gatt != null && ota != null) }

    @ReactMethod
    fun abortOta(arguments: ReadableMap, promise: Promise) { otaAbort.set(true); promise.resolve(null) }

    @ReactMethod
    fun performOta(arguments: ReadableMap, promise: Promise) {
        val image = byteArray(arguments, "image")
        if (image.isEmpty()) { promise.reject("ota_image_invalid", "OTA image is empty"); return }
        if (gatt == null || ota == null) { promise.reject("ota_unavailable", "BLE OTA characteristic FFF5 is unavailable"); return }
        if (!otaRunning.compareAndSet(false, true)) { promise.reject("ota_in_progress", "An OTA update is already running"); return }
        otaAbort.set(false)
        thread(name = "edgez-rn-ota") {
            runCatching {
                writeOta(ByteBuffer.allocate(5).order(ByteOrder.LITTLE_ENDIAN).put(1).putInt(image.size).array())
                val size = (negotiatedMtu - 8).coerceIn(20, 220)
                var sent = 0
                while (sent < image.size) {
                    check(!otaAbort.get()) { "Firmware update cancelled" }
                    val length = minOf(size, image.size - sent)
                    val packet = ByteBuffer.allocate(5 + length).order(ByteOrder.LITTLE_ENDIAN).put(2).putInt(sent).put(image, sent, length).array()
                    writeOta(packet); sent += length
                    emit(mapOf("type" to "otaProgress", "sentBytes" to sent, "totalBytes" to image.size))
                }
                writeOta(byteArrayOf(3)); "Firmware uploaded; the device is restarting"
            }.onFailure { runCatching { writeOta(byteArrayOf(4)) } }
                .fold({ promise.resolve(it) }, { promise.reject("ota_failed", it.message, it) })
            otaRunning.set(false); otaAbort.set(false)
        }
    }

    @ReactMethod
    fun requestMicrophonePermission(arguments: ReadableMap, promise: Promise) {
        if (ContextCompat.checkSelfPermission(reactContext, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) { promise.resolve(true); return }
        val activity = reactContext.currentActivity as? PermissionAwareActivity
        if (activity == null) { promise.resolve(false); return }
        pendingMic = promise; activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MIC, this)
    }

    @ReactMethod fun requestNotificationPermission(arguments: ReadableMap, promise: Promise) {
        if (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(reactContext, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            promise.resolve(EdgezBleForegroundService.notificationsAllowed(reactContext)); return
        }
        val activity = reactContext.currentActivity as? PermissionAwareActivity
        if (activity == null) { promise.reject("activity_missing", "Notification permission requires an activity"); return }
        pendingNotification = promise
        activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATION, this)
    }
    @ReactMethod fun notificationsAllowed(arguments: ReadableMap, promise: Promise) { promise.resolve(EdgezBleForegroundService.notificationsAllowed(reactContext)) }
    @ReactMethod fun canUseFullScreenIntent(arguments: ReadableMap, promise: Promise) {
        val allowed = Build.VERSION.SDK_INT < 34 || reactContext.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()
        promise.resolve(allowed)
    }
    @ReactMethod fun showIncomingMessageNotification(arguments: ReadableMap, promise: Promise) {
        promise.resolve(EdgezBleForegroundService.showMessage(reactContext, arguments.getString("sender").orEmpty(), arguments.getString("body").orEmpty(), arguments.getString("nodeNum")?.toLongOrNull() ?: 0L, arguments.getString("messageId").orEmpty()))
    }
    @ReactMethod fun showIncomingCallNotification(arguments: ReadableMap, promise: Promise) {
        promise.resolve(EdgezBleForegroundService.showCall(reactContext, arguments.getString("caller").orEmpty(), arguments.getString("nodeNum")?.toLongOrNull() ?: 0L, arguments.getString("callId")?.toLongOrNull() ?: 0L))
    }
    @ReactMethod fun cancelIncomingCallNotification(arguments: ReadableMap, promise: Promise) { EdgezBleForegroundService.cancelCall(reactContext); promise.resolve(null) }
    @ReactMethod fun clearCallLockScreenPresentation(arguments: ReadableMap, promise: Promise) {
        val activity = reactContext.currentActivity
        if (Build.VERSION.SDK_INT >= 27) { activity?.setShowWhenLocked(false); activity?.setTurnScreenOn(false) }
        promise.resolve(null)
    }
    @ReactMethod fun getBestKnownLocation(arguments: ReadableMap, promise: Promise) {
        val permissions = arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (permissions.none { ContextCompat.checkSelfPermission(reactContext, it) == PackageManager.PERMISSION_GRANTED }) {
            val activity = reactContext.currentActivity as? PermissionAwareActivity
            if (activity == null) { promise.reject("location_permission_required", "Location permission requires an activity"); return }
            pendingLocation = promise; activity.requestPermissions(permissions, REQUEST_LOCATION, this); return
        }
        returnBestLocation(promise)
    }
    @ReactMethod fun startVoiceRecording(arguments: ReadableMap, promise: Promise) {
        if (ContextCompat.checkSelfPermission(reactContext, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { promise.reject("microphone_permission_denied", "Microphone permission denied"); return }
        runCatching {
            discardVoiceRecording()
            val directory = File(reactContext.cacheDir, "edgez_voice").apply { mkdirs() }
            val opus = Build.VERSION.SDK_INT >= 29
            val file = File(directory, "recording_${System.currentTimeMillis()}.${if (opus) "ogg" else "3gp"}")
            @Suppress("DEPRECATION") val recorder = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(reactContext) else MediaRecorder()
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            if (opus) {
                recorder.setOutputFormat(MediaRecorder.OutputFormat.OGG); recorder.setAudioEncoder(MediaRecorder.AudioEncoder.OPUS)
                recorder.setAudioSamplingRate(16_000); recorder.setAudioEncodingBitRate(12_000)
            } else {
                recorder.setOutputFormat(MediaRecorder.OutputFormat.THREE_GPP); recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AMR_NB)
                recorder.setAudioSamplingRate(8_000); recorder.setAudioEncodingBitRate(4_750)
            }
            recorder.setOutputFile(file.absolutePath); recorder.prepare(); recorder.start()
            voiceRecorder = recorder; voiceRecordingFile = file; voiceRecordingCodec = if (opus) VOICE_CODEC_OPUS else VOICE_CODEC_AMR_NB; voiceRecordingStartedAt = System.currentTimeMillis()
        }.fold({ emit(mapOf("type" to "log", "log" to "Voice recording started")); promise.resolve(null) }, { discardVoiceRecording(); promise.reject("voice_record_failed", it.message, it) })
    }
    @ReactMethod fun stopVoiceRecording(arguments: ReadableMap, promise: Promise) {
        val recorder = voiceRecorder; val file = voiceRecordingFile
        if (recorder == null || file == null) { promise.resolve(null); return }
        val send = !arguments.hasKey("send") || arguments.getBoolean("send")
        val duration = (System.currentTimeMillis() - voiceRecordingStartedAt).coerceAtLeast(0)
        voiceRecorder = null; voiceRecordingFile = null; voiceRecordingStartedAt = 0
        runCatching {
            try { recorder.stop() } finally { recorder.release() }
            if (!send || duration < 250 || !file.exists() || file.length() <= 0) { file.delete(); null }
            else Arguments.createMap().apply { putArray("bytes", Arguments.fromArray(file.readBytes().map { it.toInt() and 255 })); putInt("durationMs", duration.toInt()); putInt("codec", voiceRecordingCodec); file.delete() }
        }.fold({ promise.resolve(it) }, { file.delete(); promise.reject("voice_record_failed", it.message, it) })
    }
    @ReactMethod fun playVoiceMessage(arguments: ReadableMap, promise: Promise) {
        val bytes = byteArray(arguments, "bytes"); if (bytes.isEmpty()) { promise.reject("voice_missing", "Voice message has no audio bytes"); return }
        runCatching {
            voicePlayer?.release()
            val directory = File(reactContext.cacheDir, "edgez_voice").apply { mkdirs() }
            val file = File(directory, "voice_${System.currentTimeMillis()}.${if (arguments.getInt("codec") == VOICE_CODEC_OPUS) "ogg" else "3gp"}").apply { writeBytes(bytes) }
            voicePlayer = MediaPlayer().apply { setDataSource(file.absolutePath); setOnCompletionListener { it.release(); if (voicePlayer === it) voicePlayer = null; file.delete() }; prepare(); start() }
        }.fold({ promise.resolve(null) }, { promise.reject("voice_play_failed", it.message, it) })
    }
    @ReactMethod fun startLiveVoiceAudio(arguments: ReadableMap, promise: Promise) { promise.reject("not_available", "Live voice is not available in this release") }
    @ReactMethod fun stopLiveVoiceAudio(arguments: ReadableMap, promise: Promise) { promise.resolve(null) }
    @ReactMethod fun playLiveVoiceAudio(arguments: ReadableMap, promise: Promise) { promise.reject("not_available", "Live voice is not available in this release") }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray): Boolean {
        val granted = grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }
        when (requestCode) {
            REQUEST_BLE -> { val pending = pendingBle; pendingBle = null; if (granted && pending != null) startScan(pending.second) else pending?.second?.reject("permission_denied", "Bluetooth permission denied"); return true }
            REQUEST_MIC -> { pendingMic?.resolve(granted); pendingMic = null; return true }
            REQUEST_NOTIFICATION -> { pendingNotification?.resolve(granted && EdgezBleForegroundService.notificationsAllowed(reactContext)); pendingNotification = null; return true }
            REQUEST_LOCATION -> { val pending = pendingLocation; pendingLocation = null; if (granted && pending != null) returnBestLocation(pending) else pending?.reject("location_permission_denied", "Location permission denied"); return true }
        }
        return false
    }

    @SuppressLint("MissingPermission")
    private fun startScan(promise: Promise) {
        val scanner = adapter?.bluetoothLeScanner
        if (scanner == null) { promise.reject("ble_unavailable", "Bluetooth LE is unavailable or disabled"); return }
        stopScan(); devices.clear()
        val generation = System.currentTimeMillis()
        scanCallback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val device = result.device; devices[device.address] = device
                emit(mapOf("type" to "bleDevice", "bleDevice" to mapOf("id" to device.address, "name" to (result.scanRecord?.deviceName ?: device.name ?: ""), "rssi" to result.rssi, "lastSeenMs" to System.currentTimeMillis()), "generation" to generation))
            }
            override fun onScanFailed(errorCode: Int) { emit(mapOf("type" to "log", "log" to "BLE scan failed=$errorCode")) }
        }
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        scanner.startScan(listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE)).build()), settings, scanCallback)
        emit(mapOf("type" to "log", "log" to "BLE scan started")); promise.resolve(null)
    }

    @SuppressLint("MissingPermission")
    private fun stopScan() { val callback = scanCallback ?: return; runCatching { adapter?.bluetoothLeScanner?.stopScan(callback) }; scanCallback = null }

    @SuppressLint("MissingPermission")
    private fun closeGatt() {
        synchronized(this) { writeQueue.clear(); writeInFlight = false }
        descriptorQueue.clear(); rx = null; tx = null; ota = null
        gatt?.disconnect(); gatt?.close(); gatt = null; EdgezBleForegroundService.stop(reactContext)
    }

    private val callback = object : BluetoothGattCallback() {
        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(active: BluetoothGatt, status: Int, newState: Int) {
            emit(mapOf("type" to "log", "log" to "BLE connection status=$status state=$newState"))
            if (newState == BluetoothProfile.STATE_CONNECTED) { gatt = active; EdgezBleForegroundService.start(reactContext, connectedLabel); emit(mapOf("type" to "connection", "connection" to "ble")); active.requestMtu(517) }
            else if (newState == BluetoothProfile.STATE_DISCONNECTED) { closeGatt(); emit(mapOf("type" to "connection", "connection" to "none")) }
        }
        @SuppressLint("MissingPermission")
        override fun onMtuChanged(active: BluetoothGatt, mtu: Int, status: Int) { if (status == BluetoothGatt.GATT_SUCCESS) negotiatedMtu = mtu; active.discoverServices() }
        @SuppressLint("MissingPermission")
        override fun onServicesDiscovered(active: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) { emit(mapOf("type" to "log", "log" to "BLE service discovery failed=$status")); return }
            val service = active.getService(SERVICE) ?: run { emit(mapOf("type" to "log", "log" to "EdgeZ BLE service is missing")); return }
            rx = service.getCharacteristic(RX); tx = service.getCharacteristic(TX); ota = service.getCharacteristic(OTA)
            descriptorQueue.clear()
            listOf(TX, FORWARD_TX, OTA_STATUS, VOICE_TX).mapNotNull(service::getCharacteristic).forEach { characteristic ->
                active.setCharacteristicNotification(characteristic, true); characteristic.getDescriptor(CCCD)?.let(descriptorQueue::add)
            }
            writeNextDescriptor(active)
        }
        @SuppressLint("MissingPermission")
        override fun onDescriptorWrite(active: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) { writeNextDescriptor(active) }
        override fun onCharacteristicChanged(active: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) { handleChanged(characteristic, value) }
        @Deprecated("Deprecated in Java") override fun onCharacteristicChanged(active: BluetoothGatt, characteristic: BluetoothGattCharacteristic) { handleChanged(characteristic, characteristic.value ?: return) }
        override fun onCharacteristicWrite(active: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            if (characteristic.uuid == OTA) { synchronized(otaLock) { otaWriteStatus = status; otaLock.notifyAll() }; return }
            synchronized(this@EdgezReactNativeSdkModule) { writeInFlight = false; if (status == BluetoothGatt.GATT_SUCCESS) writeQueue.pollFirst() else writeQueue.clear() }
            writeNext(active)
        }
    }

    private fun handleChanged(characteristic: BluetoothGattCharacteristic, value: ByteArray) {
        when (characteristic.uuid) { TX -> receive.add(value).forEach { emit(mapOf("type" to "packet", "packet" to it)) }; FORWARD_TX -> forwardReceive.add(value).forEach { emit(mapOf("type" to "packet", "packet" to it, "route" to "ble_forward")) }; else -> Unit }
    }

    @SuppressLint("MissingPermission")
    private fun writeNextDescriptor(active: BluetoothGatt) {
        val descriptor = descriptorQueue.pollFirst()
        if (descriptor == null) { emit(mapOf("type" to "ready")); writeNext(active); return }
        if (Build.VERSION.SDK_INT >= 33) active.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
        else { descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE; active.writeDescriptor(descriptor) }
    }

    private fun queuePacket(arguments: ReadableMap, promise: Promise) {
        val packet = byteArray(arguments, "packet")
        if (packet.isEmpty()) { promise.reject("missing_packet", "Missing EdgeZ packet"); return }
        if (packet.size > MAX_PAYLOAD) { promise.reject("packet_too_large", "EdgeZ packet exceeds $MAX_PAYLOAD bytes"); return }
        val frame = byteArrayOf('E'.code.toByte(), 'Z'.code.toByte(), packet.size.toByte(), (packet.size shr 8).toByte()) + packet
        synchronized(this) { writeQueue.add(frame) }
        val active = gatt; if (active == null || rx == null) { synchronized(this) { writeQueue.remove(frame) }; promise.reject("ble_not_ready", "BLE control channel is not ready"); return }
        writeNext(active); promise.resolve(null)
    }

    @SuppressLint("MissingPermission")
    private fun writeNext(active: BluetoothGatt) {
        val frame: ByteArray
        synchronized(this) { if (writeInFlight) return; frame = writeQueue.peekFirst() ?: return; writeInFlight = true }
        val characteristic = rx ?: return
        val started = if (Build.VERSION.SDK_INT >= 33) active.writeCharacteristic(characteristic, frame, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS
        else { characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT; characteristic.value = frame; active.writeCharacteristic(characteristic) }
        if (!started) synchronized(this) { writeInFlight = false; writeQueue.clear() }
    }

    @SuppressLint("MissingPermission")
    private fun writeOta(packet: ByteArray) {
        val active = gatt ?: error("BLE is not connected"); val characteristic = ota ?: error("OTA characteristic is unavailable")
        synchronized(otaLock) {
            otaWriteStatus = null
            val started = if (Build.VERSION.SDK_INT >= 33) active.writeCharacteristic(characteristic, packet, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS else { characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT; characteristic.value = packet; active.writeCharacteristic(characteristic) }
            check(started) { "BLE OTA write could not start" }
            val end = System.currentTimeMillis() + 15_000
            while (otaWriteStatus == null && System.currentTimeMillis() < end) otaLock.wait((end - System.currentTimeMillis()).coerceAtLeast(1))
            check(otaWriteStatus == BluetoothGatt.GATT_SUCCESS) { "BLE OTA write failed or timed out: $otaWriteStatus" }
        }
    }

    private fun requiredBlePermissions(): Array<String> = if (Build.VERSION.SDK_INT >= 31) arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT) else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    private fun hasBlePermissions() = requiredBlePermissions().all { ContextCompat.checkSelfPermission(reactContext, it) == PackageManager.PERMISSION_GRANTED }
    private fun byteArray(map: ReadableMap, key: String): ByteArray { val array = if (map.hasKey(key) && !map.isNull(key)) map.getArray(key) else null; return ByteArray(array?.size() ?: 0) { array!!.getInt(it).toByte() } }

    private fun discardVoiceRecording() {
        val recorder = voiceRecorder; voiceRecorder = null
        runCatching { recorder?.stop() }; recorder?.release(); voiceRecordingFile?.delete(); voiceRecordingFile = null; voiceRecordingStartedAt = 0
    }

    @SuppressLint("MissingPermission")
    private fun returnBestLocation(promise: Promise) {
        val manager = reactContext.getSystemService(LocationManager::class.java)
        val fine = ContextCompat.checkSelfPermission(reactContext, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(reactContext, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (manager == null || (!fine && !coarse)) { promise.resolve(null); return }
        val providers = if (fine) listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER) else listOf(LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
        val location = providers.mapNotNull { provider -> runCatching { if (manager.isProviderEnabled(provider)) manager.getLastKnownLocation(provider) else null }.getOrNull() }.maxByOrNull { it.time }
        promise.resolve(location?.let { Arguments.createMap().apply { putDouble("latitude", it.latitude); putDouble("longitude", it.longitude); putDouble("timestampMs", it.time.toDouble()) } })
    }

    private fun emit(event: Map<String, Any?>) {
        if (!reactContext.hasActiveReactInstance()) return
        reactContext.runOnJSQueueThread { reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("EdgezMeshEvent", Arguments.makeNativeMap(event)) }
    }

    override fun invalidate() { stopScan(); discardVoiceRecording(); voicePlayer?.release(); voicePlayer = null; closeGatt(); super.invalidate() }
}

private class FrameAccumulator {
    private var buffer = ByteArray(1040); private var length = 0
    fun add(bytes: ByteArray): List<ByteArray> {
        if (length + bytes.size > buffer.size) length = 0
        System.arraycopy(bytes, 0, buffer, length, bytes.size); length += bytes.size
        val packets = mutableListOf<ByteArray>()
        while (length >= 4) {
            var magic = -1; for (i in 0 until length - 1) if (buffer[i] == 'E'.code.toByte() && buffer[i + 1] == 'Z'.code.toByte()) { magic = i; break }
            if (magic < 0) { length = 0; break }
            if (magic > 0) { System.arraycopy(buffer, magic, buffer, 0, length - magic); length -= magic }
            if (length < 4) break
            val payload = (buffer[2].toInt() and 255) or ((buffer[3].toInt() and 255) shl 8)
            if (payload <= 0 || payload > MAX_PAYLOAD) { length = 0; break }
            if (length < payload + 4) break
            packets.add(buffer.copyOfRange(4, payload + 4)); val remaining = length - payload - 4
            if (remaining > 0) System.arraycopy(buffer, payload + 4, buffer, 0, remaining); length = remaining
        }
        return packets
    }
}
