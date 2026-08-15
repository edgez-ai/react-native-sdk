package ai.edgez.react_native_sdk

import android.Manifest
import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

class EdgezBleForegroundService : Service() {
    override fun onCreate() { super.onCreate(); createChannels(this) }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val label = intent?.getStringExtra(EXTRA_LABEL).orEmpty()
        startForeground(CONNECTION_ID, connectionNotification(this, label))
        return START_STICKY
    }
    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val EXTRA_LABEL = "deviceLabel"
        private const val CONNECTION_CHANNEL = "edgez_ble_connection"
        private const val MESSAGE_CHANNEL = "edgez_messages"
        private const val CALL_CHANNEL = "edgez_calls"
        private const val CONNECTION_ID = 0xED01
        private const val CALL_ID = 0xED02

        fun start(context: Context, label: String) {
            createChannels(context)
            ContextCompat.startForegroundService(context, Intent(context, EdgezBleForegroundService::class.java).putExtra(EXTRA_LABEL, label))
        }
        fun stop(context: Context) {
            context.stopService(Intent(context, EdgezBleForegroundService::class.java))
            NotificationManagerCompat.from(context).cancel(CONNECTION_ID)
        }
        fun notificationsAllowed(context: Context): Boolean =
            (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
                NotificationManagerCompat.from(context).areNotificationsEnabled()

        fun showMessage(context: Context, sender: String, body: String, node: Long, messageId: String): Boolean {
            if (!notificationsAllowed(context)) return false
            createChannels(context)
            val name = sender.ifBlank { "EdgeZ contact" }
            val person = androidx.core.app.Person.Builder().setName(name).setKey(node.toString()).build()
            val notification = NotificationCompat.Builder(context, MESSAGE_CHANNEL)
                .setSmallIcon(icon(context)).setContentTitle(name).setContentText(body.ifBlank { "New message" })
                .setStyle(NotificationCompat.MessagingStyle(person).setConversationTitle(name).addMessage(body.ifBlank { "New message" }, System.currentTimeMillis(), person))
                .setCategory(NotificationCompat.CATEGORY_MESSAGE).setPriority(NotificationCompat.PRIORITY_HIGH)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setAutoCancel(true)
                .setContentIntent(activityIntent(context, Uri.parse("edgez://message?node=$node"), messageId.hashCode())).build()
            NotificationManagerCompat.from(context).notify(messageId.ifBlank { node.toString() }, node.hashCode(), notification)
            return true
        }

        fun showCall(context: Context, caller: String, node: Long, call: Long): Boolean {
            if (!notificationsAllowed(context)) return false
            createChannels(context)
            val name = caller.ifBlank { "EdgeZ caller" }
            fun intent(action: String, offset: Int) = activityIntent(context, Uri.parse("edgez://call?node=$node&call=$call&action=$action"), call.hashCode() * 31 + offset)
            val content = intent("open", 0); val answer = intent("answer", 1); val decline = intent("decline", 2)
            val person = androidx.core.app.Person.Builder().setName(name).setImportant(true).build()
            val notification = NotificationCompat.Builder(context, CALL_CHANNEL)
                .setSmallIcon(icon(context)).setContentTitle(name).setContentText("Incoming EdgeZ voice call")
                .setCategory(NotificationCompat.CATEGORY_CALL).setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC).setOngoing(true).setTimeoutAfter(60_000)
                .setContentIntent(content).setFullScreenIntent(content, true)
                .setStyle(NotificationCompat.CallStyle.forIncomingCall(person, decline, answer)).build()
            NotificationManagerCompat.from(context).notify(CALL_ID, notification)
            return true
        }
        fun cancelCall(context: Context) = NotificationManagerCompat.from(context).cancel(CALL_ID)

        private fun connectionNotification(context: Context, label: String): Notification = NotificationCompat.Builder(context, CONNECTION_CHANNEL)
            .setSmallIcon(icon(context)).setContentTitle("EdgeZ BLE active")
            .setContentText(if (label.isBlank()) "Listening for EdgeZ messages and calls" else "Connected to $label")
            .setCategory(NotificationCompat.CATEGORY_SERVICE).setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setOngoing(true)
            .setContentIntent(activityIntent(context, Uri.parse("edgez://open"), 0)).build()

        private fun createChannels(context: Context) {
            if (Build.VERSION.SDK_INT < 26) return
            context.getSystemService(NotificationManager::class.java).createNotificationChannels(listOf(
                NotificationChannel(CONNECTION_CHANNEL, "BLE connection", NotificationManager.IMPORTANCE_LOW).apply { description = "Keeps the EdgeZ BLE connection active"; setShowBadge(false) },
                NotificationChannel(MESSAGE_CHANNEL, "Messages", NotificationManager.IMPORTANCE_HIGH).apply { description = "Incoming EdgeZ messages" },
                NotificationChannel(CALL_CHANNEL, "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply { description = "Incoming EdgeZ voice calls"; lockscreenVisibility = Notification.VISIBILITY_PUBLIC; enableVibration(true); enableLights(true); lightColor = Color.GREEN },
            ))
        }
        private fun activityIntent(context: Context, uri: Uri, code: Int): PendingIntent {
            val intent = (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent(Intent.ACTION_VIEW)).apply {
                action = Intent.ACTION_VIEW; data = uri; addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            return PendingIntent.getActivity(context, code, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        private fun icon(context: Context) = context.applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.stat_sys_data_bluetooth
    }
}
