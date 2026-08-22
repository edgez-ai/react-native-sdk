package ai.edgez.react_native_sdk

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.Surface
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import app.organicmaps.sdk.Framework
import app.organicmaps.sdk.MapController
import app.organicmaps.sdk.MapRenderingListener
import app.organicmaps.sdk.MapStyle
import app.organicmaps.sdk.MapView
import app.organicmaps.sdk.OrganicMaps
import app.organicmaps.sdk.downloader.CountryItem
import app.organicmaps.sdk.downloader.MapManager
import app.organicmaps.sdk.util.ConnectionState
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.uimanager.events.RCTEventEmitter
import java.io.File
import java.util.Locale

private const val MAP_VIEW_NAME = "EdgezOrganicMapView"

internal class EdgezOrganicMapViewManager(
    private val applicationContext: ReactApplicationContext,
) : SimpleViewManager<EdgezOrganicMapView>() {
    private val engine = EdgezOrganicMapsEngine(applicationContext)

    override fun getName() = MAP_VIEW_NAME

    override fun createViewInstance(context: ThemedReactContext) =
        EdgezOrganicMapView(context, engine)

    @ReactProp(name = "nodes")
    fun setNodes(view: EdgezOrganicMapView, value: ReadableArray?) = view.setNodes(value)

    @ReactProp(name = "centerLatitude", defaultDouble = Double.NaN)
    fun setCenterLatitude(view: EdgezOrganicMapView, value: Double) =
        view.setCenterLatitude(value.takeIf(Double::isFinite))

    @ReactProp(name = "centerLongitude", defaultDouble = Double.NaN)
    fun setCenterLongitude(view: EdgezOrganicMapView, value: Double) =
        view.setCenterLongitude(value.takeIf(Double::isFinite))

    @ReactProp(name = "zoom", defaultInt = 9)
    fun setZoom(view: EdgezOrganicMapView, value: Int) = view.setZoom(value)

    @ReactProp(name = "enableMapDownloads", defaultBoolean = false)
    fun setEnableMapDownloads(view: EdgezOrganicMapView, value: Boolean) =
        view.setEnableMapDownloads(value)

    override fun getCommandsMap(): MutableMap<String, Int> = mutableMapOf(
        "setCamera" to COMMAND_SET_CAMERA,
        "downloadRegion" to COMMAND_DOWNLOAD_REGION,
        "dismissDownloadRegion" to COMMAND_DISMISS_REGION,
        "findDownloadableRegion" to COMMAND_FIND_REGION,
        "getCamera" to COMMAND_GET_CAMERA,
        "setPerspective3d" to COMMAND_SET_3D,
        "setMapTheme" to COMMAND_SET_THEME,
        "setSatelliteMode" to COMMAND_SET_SATELLITE,
        "setBundledSatelliteMode" to COMMAND_SET_BUNDLED_SATELLITE,
    )

    override fun receiveCommand(view: EdgezOrganicMapView, commandId: Int, args: ReadableArray?) {
        when (commandId) {
            COMMAND_SET_CAMERA -> view.setCamera(
                args?.getDouble(0), args?.getDouble(1), args?.getInt(2),
            )
            COMMAND_DOWNLOAD_REGION -> view.downloadRegion(args?.getString(0))
            COMMAND_DISMISS_REGION -> view.dismissDownloadRegion(args?.getString(0))
            COMMAND_FIND_REGION -> view.emitDownloadableRegion()
            COMMAND_GET_CAMERA -> view.emitCameraChanged()
            COMMAND_SET_3D -> view.setPerspective3d(args?.getBoolean(0) ?: false)
            COMMAND_SET_THEME -> view.setMapTheme(args?.getString(0).orEmpty())
            COMMAND_SET_SATELLITE -> view.setSatelliteMode(
                args?.getBoolean(0) ?: false,
                args?.getString(1).orEmpty(),
                if (args != null && args.size() > 2) args.getInt(2) else 256,
                if (args != null && args.size() > 3) args.getInt(3) else 35,
            )
            COMMAND_SET_BUNDLED_SATELLITE -> view.setBundledSatelliteMode(
                args?.getBoolean(0) ?: false,
                args?.getString(1).orEmpty(),
            )
        }
    }

    override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> =
        mutableMapOf(
            "topMapReady" to mapOf("registrationName" to "onMapReady"),
            "topMapCameraChanged" to mapOf("registrationName" to "onCameraChanged"),
            "topMapRegionAvailable" to mapOf("registrationName" to "onMapRegionAvailable"),
            "topMapDownloadUpdate" to mapOf("registrationName" to "onMapDownloadUpdate"),
            "topMapError" to mapOf("registrationName" to "onMapError"),
        )

    override fun onDropViewInstance(view: EdgezOrganicMapView) {
        view.dispose()
        super.onDropViewInstance(view)
    }

    companion object {
        private const val COMMAND_SET_CAMERA = 1
        private const val COMMAND_DOWNLOAD_REGION = 2
        private const val COMMAND_DISMISS_REGION = 3
        private const val COMMAND_FIND_REGION = 4
        private const val COMMAND_GET_CAMERA = 5
        private const val COMMAND_SET_3D = 6
        private const val COMMAND_SET_THEME = 7
        private const val COMMAND_SET_SATELLITE = 8
        private const val COMMAND_SET_BUNDLED_SATELLITE = 9
    }
}

internal class EdgezOrganicMapsEngine(context: Context) {
    private val applicationContext = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private val callbacks = mutableListOf<Pair<() -> Unit, (Throwable) -> Unit>>()
    private var initializing = false
    val organicMaps: OrganicMaps

    init {
        val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
        val versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            packageInfo.longVersionCode.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        } else {
            @Suppress("DEPRECATION") packageInfo.versionCode
        }
        organicMaps = OrganicMaps(
            applicationContext,
            "edgez-react-native",
            context.packageName,
            versionCode,
            packageInfo.versionName ?: "0.0.0",
        )
    }

    fun installMbtilesAsset(assetName: String): File {
        require(!assetName.contains('/') && assetName.endsWith(".mbtiles")) {
            "Invalid MBTiles asset name"
        }
        val directory = File(applicationContext.filesDir, "edgez-mbtiles").apply {
            check(isDirectory || mkdirs()) { "Cannot create MBTiles directory" }
        }
        val destination = File(directory, assetName)
        if (destination.isFile && destination.length() > 0L) return destination
        val temporary = File(directory, "$assetName.tmp")
        applicationContext.assets.open(assetName).use { input ->
            temporary.outputStream().use(input::copyTo)
        }
        if (destination.exists() && !destination.delete()) error("Cannot replace MBTiles asset")
        check(temporary.renameTo(destination)) { "Cannot install MBTiles asset" }
        return destination
    }

    @Synchronized
    fun initialize(onReady: () -> Unit, onError: (Throwable) -> Unit) {
        if (organicMaps.arePlatformAndCoreInitialized()) {
            mainHandler.post(onReady)
            return
        }
        callbacks += onReady to onError
        if (initializing) return
        initializing = true
        runCatching {
            val started = organicMaps.init { finishInitialization() }
            if (!started && organicMaps.arePlatformAndCoreInitialized()) finishInitialization()
        }.onFailure(::failInitialization)
    }

    private fun finishInitialization() = mainHandler.post {
        val ready = synchronized(this) {
            initializing = false
            callbacks.toList().also { callbacks.clear() }
        }
        ready.forEach { it.first() }
    }

    private fun failInitialization(error: Throwable) = mainHandler.post {
        val failed = synchronized(this) {
            initializing = false
            callbacks.toList().also { callbacks.clear() }
        }
        failed.forEach { it.second(error) }
    }
}

private data class EdgezNativeMapNode(
    val id: String,
    val label: String,
    val latitude: Double,
    val longitude: Double,
    val marker: String,
)

internal class EdgezOrganicMapView(
    private val reactContext: ThemedReactContext,
    private val engine: EdgezOrganicMapsEngine,
) : FrameLayout(reactContext), DefaultLifecycleObserver, PermissionListener {
    private val status = TextView(reactContext)
    private val lifecycleOwner = reactContext.currentActivity as? LifecycleOwner
    private var mapController: MapController? = null
    private var disposed = false
    private var renderingReady = false
    private var initialCameraApplied = false
    private var locationPermissionGranted = false
    private var enableMapDownloads = false
    private val requestedRegions = mutableSetOf<String>()
    private val dismissedRegions = mutableSetOf<String>()
    private var pendingRegionId: String? = null
    private var storageCallbackSlot: Int? = null
    private var nodes = emptyList<EdgezNativeMapNode>()
    private var centerLatitude: Double? = null
    private var centerLongitude: Double? = null
    private var zoom = 9

    private val locationPoll = object : Runnable {
        override fun run() {
            if (disposed || !locationPermissionGranted) return
            applyInitialCamera()
            if (!initialCameraApplied) postDelayed(this, PHONE_LOCATION_REFRESH_MS)
        }
    }
    private val regionCheck = object : Runnable {
        override fun run() {
            if (disposed || !enableMapDownloads) return
            refreshDownloadPrompt()
            postDelayed(this, REGION_AUTOCACHE_INTERVAL_MS)
        }
    }

    init {
        status.apply {
            text = "Starting offline map…"
            setTextColor(Color.WHITE)
            textSize = 15f
            gravity = Gravity.CENTER
            setPadding(24, 16, 24, 16)
            setBackgroundColor(0xCC1B1B1B.toInt())
        }
        addView(status, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.TOP))
        lifecycleOwner?.lifecycle?.addObserver(this)
        engine.initialize(
            onReady = {
                ConnectionState.INSTANCE.initialize(context.applicationContext)
                runCatching { Framework.nativeRestoreDownloadQueue() }
                createMap()
                requestLocationPermission()
            },
            onError = ::showError,
        )
    }

    fun setNodes(value: ReadableArray?) {
        nodes = parseNodes(value)
        renderNodes()
        applyInitialCamera()
    }

    fun setCenterLatitude(value: Double?) {
        centerLatitude = value?.takeIf { it.isFinite() && it in -90.0..90.0 }
        moveCameraIfExplicit()
    }

    fun setCenterLongitude(value: Double?) {
        centerLongitude = value?.takeIf { it.isFinite() && it in -180.0..180.0 }
        moveCameraIfExplicit()
    }

    fun setZoom(value: Int) {
        zoom = value.coerceIn(1, 20)
    }

    fun setEnableMapDownloads(value: Boolean) {
        enableMapDownloads = value
        if (value && renderingReady) {
            subscribeToMapDownloads()
            removeCallbacks(regionCheck)
            postDelayed(regionCheck, REGION_AUTOCACHE_INITIAL_DELAY_MS)
        } else if (!value) {
            removeCallbacks(regionCheck)
        }
    }

    fun setCamera(latitude: Double?, longitude: Double?, requestedZoom: Int?) {
        if (latitude == null || longitude == null || latitude !in -90.0..90.0 || longitude !in -180.0..180.0) return
        centerLatitude = latitude
        centerLongitude = longitude
        zoom = (requestedZoom ?: zoom).coerceIn(1, 20)
        moveCamera(latitude, longitude)
    }

    fun downloadRegion(regionId: String?) {
        if (!regionId.isNullOrBlank()) startRegionDownload(regionId)
    }

    fun dismissDownloadRegion(regionId: String?) {
        regionId?.let(dismissedRegions::add)
        pendingRegionId = null
    }

    fun emitDownloadableRegion() {
        val regionId = findDownloadableRegion()
        if (regionId != null) emit("topMapRegionAvailable", mapOf("regionId" to regionId))
        else emit("topMapDownloadUpdate", mapOf(
            "regionId" to "",
            "status" to "Zoom in to an uncached region to download its detailed map.",
            "progress" to null,
            "finished" to false,
            "failed" to false,
        ))
    }

    fun emitCameraChanged() = notifyCameraChanged()

    fun setPerspective3d(enabled: Boolean) = runMapSetting {
        Framework.nativeSet3dMode(enabled, enabled)
    }

    fun setMapTheme(theme: String) = runMapSetting {
        MapStyle.set(if (theme == "night") MapStyle.Dark else MapStyle.Clear)
    }

    fun setSatelliteMode(enabled: Boolean, tileUrl: String, cacheSizeMb: Int, areaOpacity: Int) {
        if (enabled && !Framework.nativeIsWellFormedBackgroundTilesUrl(tileUrl)) {
            emitError("Satellite URL must use http(s) and contain {z}, {x}, and {y}")
            return
        }
        runMapSetting {
            if (enabled) Framework.nativeSetBackgroundTiles(
                true, tileUrl, cacheSizeMb.coerceIn(16, 2_048), areaOpacity.coerceIn(0, 100),
            ) else Framework.nativeSetBackgroundTilesEnabled(false)
        }
    }

    fun setBundledSatelliteMode(enabled: Boolean, assetName: String) = runMapSetting {
        if (enabled) {
            val archive = engine.installMbtilesAsset(assetName)
            Framework.nativeSetBackgroundTileSources(
                true, "", arrayOf(archive.absolutePath), 256, 35,
            )
        } else Framework.nativeSetBackgroundTilesEnabled(false)
    }

    fun dispose() {
        if (disposed) return
        disposed = true
        removeCallbacks(locationPoll)
        removeCallbacks(regionCheck)
        storageCallbackSlot?.let(MapManager::nativeUnsubscribe)
        storageCallbackSlot = null
        engine.organicMaps.locationHelper.stop()
        lifecycleOwner?.lifecycle?.removeObserver(this)
        mapController?.let { controller ->
            lifecycleOwner?.let { owner ->
                owner.lifecycle.removeObserver(controller)
                controller.onDestroy(owner)
            }
        }
        mapController = null
        removeAllViews()
    }

    override fun onStart(owner: LifecycleOwner) = startLocationIfReady()

    override fun onStop(owner: LifecycleOwner) {
        removeCallbacks(locationPoll)
        engine.organicMaps.locationHelper.stop()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<String>,
        grantResults: IntArray,
    ): Boolean {
        if (requestCode != REQUEST_MAP_LOCATION) return false
        onLocationPermissionResult(grantResults.isNotEmpty() && grantResults.any {
            it == PackageManager.PERMISSION_GRANTED
        })
        return true
    }

    private fun requestLocationPermission() {
        val permissions = arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (permissions.any { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }) {
            onLocationPermissionResult(true)
            return
        }
        val activity = reactContext.currentActivity as? PermissionAwareActivity
        if (activity == null) onLocationPermissionResult(false)
        else activity.requestPermissions(permissions, REQUEST_MAP_LOCATION, this)
    }

    private fun createMap() {
        if (disposed || mapController != null) return
        val mapView = MapView(context)
        mapView.setOnTouchListener { _, event ->
            if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
                postDelayed({
                    notifyCameraChanged()
                    if (enableMapDownloads) refreshDownloadPrompt()
                }, DOWNLOAD_PROMPT_GESTURE_DELAY_MS)
            }
            false
        }
        addView(mapView, 0, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        status.text = "Creating renderer…"
        mapController = MapController(
            mapView,
            engine.organicMaps.locationHelper,
            object : MapRenderingListener {
                override fun onRenderingCreated() { post { status.text = "Rendering offline map…" } }
                override fun onRenderingRestored() { post { onRenderingReady() } }
                override fun onRenderingInitializationFinished() { post { onRenderingReady() } }
            },
            { post { showError(IllegalStateException("Map rendering is not supported")) } },
            false,
        )
        lifecycleOwner?.lifecycle?.addObserver(mapController!!)
        startLocationIfReady()
    }

    private fun onRenderingReady() {
        if (renderingReady) return
        renderingReady = true
        renderNodes()
        applyInitialCamera()
        subscribeToMapDownloads()
        if (enableMapDownloads) postDelayed(regionCheck, REGION_AUTOCACHE_INITIAL_DELAY_MS)
        emit("topMapReady", emptyMap())
    }

    private fun onLocationPermissionResult(granted: Boolean) {
        if (disposed) return
        locationPermissionGranted = granted
        startLocationIfReady()
        applyInitialCamera()
    }

    @Suppress("DEPRECATION")
    private fun startLocationIfReady() {
        if (disposed || !locationPermissionGranted || mapController == null) return
        val lifecycle = lifecycleOwner?.lifecycle
        if (lifecycle != null && !lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) return
        val activity = reactContext.currentActivity as? Activity
        val rotation = activity?.windowManager?.defaultDisplay?.rotation ?: Surface.ROTATION_0
        engine.organicMaps.sensorHelper.setRotation(rotation)
        engine.organicMaps.locationHelper.start()
        removeCallbacks(locationPoll)
        post(locationPoll)
    }

    private fun renderNodes() {
        val controller = mapController ?: return
        if (!controller.isRenderingActive()) return
        Framework.nativeClearApiPoints()
        if (nodes.isNotEmpty()) {
            Framework.nativeParseAndSetApiUrl(markerUrl(nodes))
            Framework.nativeSetApiPointsFromUrl()
        }
        controller.updateCompassOffset(0, 0)
        controller.view.postInvalidate()
        status.visibility = View.GONE
    }

    private fun applyInitialCamera() {
        if (disposed || initialCameraApplied || !renderingReady) return
        val target = (if (centerLatitude != null && centerLongitude != null) {
            centerLatitude!! to centerLongitude!!
        } else if (locationPermissionGranted) {
            currentPhoneLocation()?.let { it.latitude to it.longitude }
        } else nodes.firstOrNull()?.let { it.latitude to it.longitude }) ?: return
        moveCamera(target.first, target.second)
        initialCameraApplied = true
        postDelayed({ if (!disposed && renderingReady) moveCamera(target.first, target.second) }, MAP_REFRESH_DELAY_MS)
    }

    private fun moveCameraIfExplicit() {
        val latitude = centerLatitude ?: return
        val longitude = centerLongitude ?: return
        if (renderingReady) moveCamera(latitude, longitude)
    }

    private fun moveCamera(latitude: Double, longitude: Double) {
        val controller = mapController ?: return
        if (!controller.isRenderingActive()) return
        Framework.nativeStopLocationFollow()
        Framework.nativeZoomToPoint(latitude, longitude, zoom, false)
        controller.updateCompassOffset(0, 0)
        controller.view.postInvalidate()
        post { notifyCameraChanged() }
    }

    private fun notifyCameraChanged() {
        if (!renderingReady) return
        readCurrentCamera()?.let { emit("topMapCameraChanged", it) }
    }

    private fun readCurrentCamera(): Map<String, Any>? = runCatching {
        val center = Framework.nativeGetScreenRectCenter()
        val latitude = center.getOrNull(0) ?: return@runCatching null
        val rawLongitude = center.getOrNull(1) ?: return@runCatching null
        val currentZoom = Framework.nativeGetDrawScale()
        if (!latitude.isFinite() || !rawLongitude.isFinite() || latitude !in -90.0..90.0 || currentZoom < 1) return@runCatching null
        mapOf(
            "latitude" to latitude,
            "longitude" to (((rawLongitude + 180.0) % 360.0 + 360.0) % 360.0 - 180.0),
            "zoom" to currentZoom.coerceIn(1, 20),
        )
    }.getOrNull()

    @SuppressLint("MissingPermission")
    private fun currentPhoneLocation(): Location? {
        engine.organicMaps.locationHelper.savedLocation?.let { return it }
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
        val hasFine = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val providers = if (hasFine) listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
        else listOf(LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
        return providers.mapNotNull { provider ->
            runCatching { if (manager.isProviderEnabled(provider)) manager.getLastKnownLocation(provider) else null }.getOrNull()
        }.maxByOrNull { it.time }
    }

    private fun runMapSetting(action: () -> Unit) {
        if (!renderingReady) { emitError("The map renderer is not ready"); return }
        runCatching {
            action()
            mapController?.view?.postInvalidate()
        }.onFailure { emitError(it.message ?: "Unable to change map setting") }
    }

    private fun subscribeToMapDownloads() {
        if (!enableMapDownloads || storageCallbackSlot != null) return
        storageCallbackSlot = MapManager.nativeSubscribe(object : MapManager.StorageCallback {
            override fun onStatusChanged(data: List<MapManager.StorageCallbackData>) {
                val event = data.lastOrNull() ?: return
                post {
                    when (event.newStatus) {
                        CountryItem.STATUS_DONE -> {
                            pendingRegionId = null
                            emitDownload(event.countryId, "Offline map cached: ${event.countryId}", 1.0, true, false)
                            mapController?.view?.postInvalidate()
                        }
                        CountryItem.STATUS_PROGRESS, CountryItem.STATUS_ENQUEUED -> emitDownload(
                            event.countryId,
                            if (event.newStatus == CountryItem.STATUS_ENQUEUED) "Queued map: ${event.countryId}" else "Downloading map: ${event.countryId}",
                            null, false, false,
                        )
                        CountryItem.STATUS_FAILED -> {
                            requestedRegions.remove(event.countryId)
                            emitDownload(event.countryId, "Map download failed: ${event.countryId}", null, false, true)
                        }
                    }
                }
            }

            override fun onProgress(countryId: String, localSize: Long, remoteSize: Long) {
                val progress = if (remoteSize > 0L) (localSize.toDouble() / remoteSize).coerceIn(0.0, 1.0) else null
                post { emitDownload(
                    countryId,
                    if (progress == null) "Downloading map: $countryId" else "Downloading map: $countryId ${(progress * 100).toInt()}%",
                    progress, false, false,
                ) }
            }
        })
    }

    private fun refreshDownloadPrompt() {
        val regionId = findDownloadableRegion() ?: return
        if (regionId == pendingRegionId || regionId in requestedRegions || regionId in dismissedRegions) return
        pendingRegionId = regionId
        emit("topMapRegionAvailable", mapOf("regionId" to regionId))
    }

    private fun findDownloadableRegion(): String? {
        if (!enableMapDownloads || !renderingReady) return null
        return runCatching {
            if (Framework.nativeGetDrawScale() < MIN_DOWNLOAD_PROMPT_ZOOM || Framework.nativeIsDownloadedMapAtScreenCenter()) return@runCatching null
            val center = Framework.nativeGetScreenRectCenter()
            MapManager.nativeFindCountry(center.getOrNull(0) ?: return@runCatching null, center.getOrNull(1) ?: return@runCatching null)?.takeIf(String::isNotBlank)
        }.getOrNull()
    }

    private fun startRegionDownload(regionId: String) {
        pendingRegionId = null
        runCatching {
            if (ConnectionState.INSTANCE.isMobileConnected) MapManager.nativeEnableDownloadOn3g()
            if (requestedRegions.add(regionId)) {
                emitDownload(regionId, "Queued map: $regionId", null, false, false)
                MapManager.startDownload(regionId)
            }
        }.onFailure {
            requestedRegions.remove(regionId)
            emitDownload(regionId, "Map download failed: ${it.message ?: regionId}", null, false, true)
        }
    }

    private fun emitDownload(regionId: String, status: String, progress: Double?, finished: Boolean, failed: Boolean) =
        emit("topMapDownloadUpdate", mapOf(
            "regionId" to regionId,
            "status" to status,
            "progress" to progress,
            "finished" to finished,
            "failed" to failed,
        ))

    private fun showError(error: Throwable) {
        if (disposed) return
        val message = "Offline map unavailable: ${error.message ?: error.javaClass.simpleName}"
        status.visibility = View.VISIBLE
        status.text = message
        emitError(message)
    }

    private fun emitError(message: String) = emit("topMapError", mapOf("message" to message))

    private fun emit(eventName: String, values: Map<String, Any?>) {
        if (disposed || id == View.NO_ID) return
        val event = Arguments.createMap()
        values.forEach { (key, value) ->
            when (value) {
                null -> event.putNull(key)
                is Boolean -> event.putBoolean(key, value)
                is Int -> event.putInt(key, value)
                is Double -> event.putDouble(key, value)
                else -> event.putString(key, value.toString())
            }
        }
        @Suppress("DEPRECATION")
        reactContext.getJSModule(RCTEventEmitter::class.java).receiveEvent(id, eventName, event)
    }

    private fun markerUrl(items: List<EdgezNativeMapNode>): String = buildString {
        append("om://map?")
        items.forEachIndexed { index, node ->
            if (index > 0) append('&')
            append("ll=").append(String.format(Locale.US, "%.7f,%.7f", node.latitude, node.longitude))
            append("&n=").append(Uri.encode(node.label))
            append("&id=").append(Uri.encode(node.id))
            markerStyle(node.marker)?.let { append("&s=").append(Uri.encode(it)) }
        }
    }

    private fun markerStyle(marker: String): String? = when (marker.lowercase(Locale.US)) {
        "red", "blue", "purple", "yellow", "pink", "brown", "green", "orange" -> "placemark-${marker.lowercase(Locale.US)}"
        "deep_purple" -> "placemark-deeppurple"
        "light_blue" -> "placemark-lightblue"
        "cyan" -> "placemark-cyan"
        "teal" -> "placemark-teal"
        "lime" -> "placemark-lime"
        "deep_orange" -> "placemark-deeporange"
        "gray", "grey" -> "placemark-gray"
        "blue_gray" -> "placemark-bluegray"
        else -> null
    }

    private fun parseNodes(value: ReadableArray?): List<EdgezNativeMapNode> {
        if (value == null) return emptyList()
        return (0 until value.size()).mapNotNull { index ->
            val map = value.getMap(index) ?: return@mapNotNull null
            val latitude = map.number("latitude") ?: return@mapNotNull null
            val longitude = map.number("longitude") ?: return@mapNotNull null
            if (latitude !in -90.0..90.0 || longitude !in -180.0..180.0) return@mapNotNull null
            EdgezNativeMapNode(
                map.string("id"), map.string("label"), latitude, longitude,
                map.string("marker").ifBlank { "blue" },
            )
        }
    }

    private fun ReadableMap.number(key: String): Double? = if (hasKey(key) && !isNull(key)) getDouble(key) else null
    private fun ReadableMap.string(key: String): String = if (hasKey(key) && !isNull(key)) getString(key).orEmpty() else ""

    companion object {
        private const val REQUEST_MAP_LOCATION = 7310
        private const val PHONE_LOCATION_REFRESH_MS = 1_000L
        private const val MAP_REFRESH_DELAY_MS = 250L
        private const val MIN_DOWNLOAD_PROMPT_ZOOM = 9
        private const val REGION_AUTOCACHE_INTERVAL_MS = 3_500L
        private const val REGION_AUTOCACHE_INITIAL_DELAY_MS = 5_000L
        private const val DOWNLOAD_PROMPT_GESTURE_DELAY_MS = 500L
    }
}
