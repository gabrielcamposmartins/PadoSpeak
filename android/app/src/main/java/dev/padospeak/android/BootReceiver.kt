package dev.padospeak.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/**
 * Celular reiniciou ou o app acabou de se atualizar: com "receber em segundo plano" ligado e a conta conectada da
 * última vez, volta a ficar conectado sozinho (o ConnectionService abre a página em segundo plano), sem precisar
 * abrir o app para voltar a receber chamadas.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val prefs = ctx.getSharedPreferences("padospeak", Context.MODE_PRIVATE)
        if (!prefs.getBoolean("keepAlive", true) || !prefs.getBoolean("lastSession", false)) return
        try {
            ContextCompat.startForegroundService(ctx, Intent(ctx, ConnectionService::class.java))
        } catch (e: Exception) {
            android.util.Log.w("PadoSpeak", "religar a conexão", e)
        }
    }
}
