package dev.padospeak.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import org.json.JSONObject

/** Botões das notificações que respondem sem abrir o app: "Desligar", "Recusar" e "Responder". */
class CallActionReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_LEAVE = "dev.padospeak.android.LEAVE_CALL"
        const val ACTION_DECLINE = "dev.padospeak.android.DECLINE_CALL"
        const val ACTION_REPLY = "dev.padospeak.android.REPLY"
        const val EXTRA_KEY = "key"
    }

    override fun onReceive(ctx: Context, intent: Intent) {
        Bridge.init(ctx)
        val url = intent.getStringExtra(MainActivity.EXTRA_URL)
        when (intent.action) {
            ACTION_LEAVE -> {
                Bridge.send(JSONObject().put("type", "leaveCall"))
                ctx.stopService(Intent(ctx, CallService::class.java))
            }
            ACTION_DECLINE -> {
                if (url != null) Bridge.open(url)
                Notifier.cancelRing(ctx)
            }
            ACTION_REPLY -> {
                val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifier.KEY_REPLY)?.toString()?.trim()
                if (text.isNullOrEmpty() || url == null) return
                // A página manda pela conexão que já está aberta e avisa de volta ("replied").
                if (Bridge.alive()) Bridge.send(JSONObject().put("type", "reply").put("url", url).put("text", text))
                else Notifier.replied(ctx, url, false, text)
            }
        }
    }
}
