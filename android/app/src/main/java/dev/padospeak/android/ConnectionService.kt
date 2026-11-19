package dev.padospeak.android

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.ServiceCompat

/**
 * "Receber chamadas e mensagens com o app em segundo plano": serviço em primeiro plano (com o aviso discreto
 * "PadoSpeak conectado") que mantém o processo — e a página com a conexão do WebSocket — vivo com a tela
 * bloqueada ou o app fechado pelos recentes. O servidor pinga a conexão a cada 50 s para a operadora não
 * derrubá-la. Quando a rede muda ou volta, avisa a página para reconectar na hora.
 */
class ConnectionService : Service() {
    private var callback: ConnectivityManager.NetworkCallback? = null
    private val main = Handler(Looper.getMainLooper())
    private val checkUpdates = object : Runnable {
        override fun run() {
            Updater.maybeCheck(this@ConnectionService)
            main.postDelayed(this, 60 * 60 * 1000L)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        try {
            ServiceCompat.startForeground(this, Notifier.CONN_ID, Notifier.connectionNotification(this), type)
        } catch (e: Exception) {
            android.util.Log.w("PadoSpeak", "conexão em segundo plano", e)
            stopSelf()
            return START_NOT_STICKY
        }
        watchNetwork()
        ensurePage()
        main.removeCallbacks(checkUpdates)
        main.post(checkUpdates)
        return START_NOT_STICKY
    }

    /**
     * Sem a página (o celular reiniciou, o app acabou de se atualizar, ou ela caiu com o app fechado): abre em
     * segundo plano, para continuar recebendo chamadas e mensagens. Abrir o app depois usa a mesma.
     */
    private fun ensurePage() {
        if (WebHost.web != null) return
        WebHost.create(applicationContext).apply {
            webViewClient = MainActivity.PageClient()
            loadUrl(BuildConfig.BASE_URL)
        }
    }

    private fun watchNetwork() {
        if (callback != null) return
        val cm = getSystemService(ConnectivityManager::class.java)
        callback = object : ConnectivityManager.NetworkCallback() {
            private var current: Network? = null
            private var first = true

            override fun onAvailable(network: Network) {
                val changed = !first && network != current
                first = false
                current = network
                if (changed) Bridge.send("online")
            }

            override fun onLost(network: Network) {
                if (network == current) current = null
            }
        }.also { cm.registerDefaultNetworkCallback(it) }
    }

    override fun onDestroy() {
        main.removeCallbacks(checkUpdates)
        callback?.let { runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } }
        callback = null
        super.onDestroy()
    }
}
