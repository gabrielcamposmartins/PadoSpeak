package dev.padospeak.android

import android.Manifest
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Chamada em andamento: serviço em primeiro plano (com a notificação "Em chamada") para o Android não pausar
 * o microfone, a câmera e a conexão com a tela apagada ou com outro app aberto. Segura a CPU e o Wi-Fi
 * acordados enquanto a chamada durar.
 */
class CallService : Service() {
    companion object {
        const val EXTRA_CAMERA = "camera"
        const val EXTRA_TEXT = "text"
        private const val MAX_HOLD_MS = 6 * 60 * 60 * 1000L
    }

    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val camera = intent?.getBooleanExtra(EXTRA_CAMERA, false) == true
        val n = Notifier.callNotification(this, intent?.getStringExtra(EXTRA_TEXT))
        try {
            ServiceCompat.startForeground(this, Notifier.CALL_ID, n, types(camera))
        } catch (e: Exception) {
            // Sem microfone/câmera permitidos agora: ao menos mantém o som da chamada.
            try {
                val media = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0
                ServiceCompat.startForeground(this, Notifier.CALL_ID, n, media)
            } catch (_: Exception) {
                stopSelf()
                return START_NOT_STICKY
            }
        }
        hold()
        return START_NOT_STICKY
    }

    private fun granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun types(camera: Boolean): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0
        var t = 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (granted(Manifest.permission.RECORD_AUDIO)) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            if (camera && granted(Manifest.permission.CAMERA)) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        }
        return if (t == 0) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else t
    }

    @Suppress("DEPRECATION")
    private fun hold() {
        if (wake == null) {
            wake = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PadoSpeak:chamada")
                .apply {
                    setReferenceCounted(false)
                    acquire(MAX_HOLD_MS)
                }
        }
        if (wifi == null) {
            wifi = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
                .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "PadoSpeak:chamada")
                .apply {
                    setReferenceCounted(false)
                    acquire()
                }
        }
    }

    override fun onDestroy() {
        wake?.takeIf { it.isHeld }?.release()
        wifi?.takeIf { it.isHeld }?.release()
        wake = null
        wifi = null
        super.onDestroy()
    }
}
