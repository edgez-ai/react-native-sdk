package ai.edgez.react_native_sdk

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.io.ByteArrayInputStream
import java.security.MessageDigest
import java.security.Signature
import java.security.cert.CertificateFactory
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * Stores a verified React Native bundle outside the APK and selects it before
 * React starts. A bundle that does not report healthy during its first launch
 * is discarded automatically on the next launch, falling back to the APK.
 */
object EdgezBundleUpdateManager {
    private const val PREFS = "edgez_app_bundle_update"
    private const val KEY_CURRENT_RUNTIME = "current_runtime"
    private const val KEY_UPDATE_ID = "update_id"
    private const val KEY_UPDATE_RUNTIME = "update_runtime"
    private const val KEY_BUNDLE_PATH = "bundle_path"
    private const val KEY_SHA256 = "sha256"
    private const val KEY_HEALTHY = "healthy"
    private const val KEY_ATTEMPTED = "attempted"
    private const val KEY_REJECTED_UPDATE_ID = "rejected_update_id"
    private const val MAX_BUNDLE_BYTES = 64L * 1024L * 1024L

    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(2, TimeUnit.MINUTES)
        .callTimeout(3, TimeUnit.MINUTES)
        .build()

    /** Called by the host application's MainApplication before React starts. */
    @JvmStatic
    fun resolveBundleFile(context: Context, debug: Boolean, runtimeVersion: String): String? {
        if (debug) return null
        val prefs = prefs(context)
        prefs.edit().putString(KEY_CURRENT_RUNTIME, runtimeVersion).commit()
        val path = prefs.getString(KEY_BUNDLE_PATH, null) ?: return null
        val file = File(path)
        if (prefs.getString(KEY_UPDATE_RUNTIME, null) != runtimeVersion || !file.isFile) {
            clear(context)
            return null
        }
        if (prefs.getBoolean(KEY_HEALTHY, false)) return file.absolutePath
        if (prefs.getBoolean(KEY_ATTEMPTED, false)) {
            clear(context, prefs.getString(KEY_UPDATE_ID, null))
            return null
        }
        prefs.edit().putBoolean(KEY_ATTEMPTED, true).commit()
        return file.absolutePath
    }

    fun install(
        context: Context,
        bundleUrl: String,
        signedPayload: String,
        manifestSignature: String,
    ): WritableMap {
        val payload = verifyManifest(context, signedPayload, manifestSignature)
        val updateId = payload.getString("updateId")
        val runtimeVersion = payload.getString("runtimeVersion")
        val expectedSha256 = payload.getString("sha256")
        require(updateId.isNotBlank() && updateId.length <= 256) { "Invalid app update ID" }
        require(runtimeVersion.isNotBlank() && runtimeVersion.length <= 128) { "Invalid app update runtime" }
        val currentRuntime = prefs(context).getString(KEY_CURRENT_RUNTIME, null)
        require(currentRuntime == runtimeVersion) {
            "Bundle runtime $runtimeVersion is incompatible with app runtime ${currentRuntime ?: "unknown"}"
        }
        val normalizedSha = expectedSha256.lowercase()
        require(normalizedSha.matches(Regex("[0-9a-f]{64}"))) { "Invalid bundle SHA-256" }
        val uri = java.net.URI(bundleUrl)
        require(uri.scheme == "https" && !uri.host.isNullOrBlank()) { "Bundle URL must use HTTPS" }

        val directory = File(context.filesDir, "edgez-app-bundles").apply { mkdirs() }
        val destination = File(directory, "bundle-${normalizedSha.take(20)}.jsbundle")
        val temporary = File(directory, "${destination.name}.download")
        temporary.delete()

        try {
            val request = Request.Builder().url(bundleUrl).get().build()
            client.newCall(request).execute().use { response ->
                check(response.isSuccessful) { "Bundle download failed with HTTP ${response.code}" }
                val body = response.body
                val declaredLength = body.contentLength()
                check(declaredLength < 0 || declaredLength <= MAX_BUNDLE_BYTES) { "Bundle exceeds 64 MiB" }
                val digest = MessageDigest.getInstance("SHA-256")
                var received = 0L
                body.byteStream().use { input ->
                    FileOutputStream(temporary).use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            received += count
                            check(received <= MAX_BUNDLE_BYTES) { "Bundle exceeds 64 MiB" }
                            digest.update(buffer, 0, count)
                            output.write(buffer, 0, count)
                        }
                        output.fd.sync()
                    }
                }
                val actualSha = digest.digest().joinToString("") { "%02x".format(it) }
                check(actualSha == normalizedSha) { "Bundle SHA-256 mismatch" }
            }
            destination.delete()
            check(temporary.renameTo(destination)) { "Could not activate downloaded bundle" }
            prefs(context).edit()
                .putString(KEY_UPDATE_ID, updateId)
                .putString(KEY_UPDATE_RUNTIME, runtimeVersion)
                .putString(KEY_BUNDLE_PATH, destination.absolutePath)
                .putString(KEY_SHA256, normalizedSha)
                .putBoolean(KEY_HEALTHY, false)
                .putBoolean(KEY_ATTEMPTED, false)
                .remove(KEY_REJECTED_UPDATE_ID)
                .commit()
            directory.listFiles()?.filter { it != destination }?.forEach(File::delete)
            return status(context)
        } catch (error: Throwable) {
            temporary.delete()
            throw error
        }
    }

    fun markHealthy(context: Context): WritableMap {
        val preferences = prefs(context)
        if (preferences.contains(KEY_UPDATE_ID)) preferences.edit().putBoolean(KEY_HEALTHY, true).commit()
        return status(context)
    }

    fun rollback(context: Context): WritableMap {
        clear(context, prefs(context).getString(KEY_UPDATE_ID, null))
        return status(context)
    }

    fun status(context: Context): WritableMap {
        val preferences = prefs(context)
        val path = preferences.getString(KEY_BUNDLE_PATH, null)
        return Arguments.createMap().apply {
            putString("runtimeVersion", preferences.getString(KEY_CURRENT_RUNTIME, null))
            putString("updateId", preferences.getString(KEY_UPDATE_ID, null))
            putString("sha256", preferences.getString(KEY_SHA256, null))
            putString("rejectedUpdateId", preferences.getString(KEY_REJECTED_UPDATE_ID, null))
            putBoolean("installed", path != null && File(path).isFile)
            putBoolean("healthy", preferences.getBoolean(KEY_HEALTHY, false))
            putBoolean("pendingRestart", path != null && !preferences.getBoolean(KEY_ATTEMPTED, false))
        }
    }

    private fun clear(context: Context, rejectedUpdateId: String? = null) {
        val preferences = prefs(context)
        preferences.getString(KEY_BUNDLE_PATH, null)?.let { File(it).delete() }
        val currentRuntime = preferences.getString(KEY_CURRENT_RUNTIME, null)
        preferences.edit().clear().apply {
            if (currentRuntime != null) putString(KEY_CURRENT_RUNTIME, currentRuntime)
            if (rejectedUpdateId != null) putString(KEY_REJECTED_UPDATE_ID, rejectedUpdateId)
        }.commit()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun verifyManifest(context: Context, signedPayload: String, manifestSignature: String): JSONObject {
        val payloadBytes = runCatching { Base64.decode(signedPayload, Base64.DEFAULT) }
            .getOrElse { throw IllegalArgumentException("Invalid signed app bundle payload", it) }
        val signatureBytes = runCatching { Base64.decode(manifestSignature, Base64.DEFAULT) }
            .getOrElse { throw IllegalArgumentException("Invalid app bundle signature", it) }
        val packageInfo = if (Build.VERSION.SDK_INT >= 33) {
            context.packageManager.getPackageInfo(
                context.packageName,
                PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()),
            )
        } else {
            @Suppress("DEPRECATION")
            context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        }
        val certificateFactory = CertificateFactory.getInstance("X.509")
        val verified = packageInfo.signingInfo?.apkContentsSigners.orEmpty().any { signer ->
            val certificate = certificateFactory.generateCertificate(ByteArrayInputStream(signer.toByteArray()))
            val algorithm = when (certificate.publicKey.algorithm.uppercase()) {
                "RSA" -> "SHA256withRSA"
                "EC", "ECDSA" -> "SHA256withECDSA"
                else -> return@any false
            }
            Signature.getInstance(algorithm).run {
                initVerify(certificate.publicKey)
                update(payloadBytes)
                verify(signatureBytes)
            }
        }
        check(verified) { "App bundle manifest signature does not match the installed APK" }
        return JSONObject(payloadBytes.toString(Charsets.UTF_8))
    }
}
