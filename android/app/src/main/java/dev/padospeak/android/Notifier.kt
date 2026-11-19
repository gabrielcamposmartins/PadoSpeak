package dev.padospeak.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput

/**
 * Notificações do sistema: mensagens (em forma de conversa, com vibração e "Responder"), chamada recebida (tela
 * cheia por cima da tela bloqueada, com o toque do celular), chamada em andamento e o aviso discreto de que o
 * app está conectado em segundo plano.
 */
object Notifier {
    private const val CH_MESSAGES = "mensagens"
    private const val CH_RING = "chamadas"
    private const val CH_CALL = "chamada"
    private const val CH_CONN = "conexao"
    private const val CH_UPDATE = "atualizacao"
    private const val UPDATE_ID = 4
    const val CALL_ID = 1
    private const val RING_ID = 2
    const val CONN_ID = 3
    const val KEY_REPLY = "reply"
    private const val COLOR = 0xFFD93F3A.toInt()
    private val VIBRATE_MESSAGE = longArrayOf(0, 180, 90, 180)
    private val VIBRATE_RING = longArrayOf(0, 900, 500, 900, 500)

    /** Últimas mensagens de cada conversa ainda na central (para empilhar como no WhatsApp). */
    private class Line(val sender: String, val text: String, val at: Long, val mine: Boolean)
    private val history = LinkedHashMap<String, MutableList<Line>>()

    fun createChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        // Canais da primeira versão de teste (sem vibração/toque, que não mudam depois de criados).
        listOf("messages", "ring", "call").forEach { nm.deleteNotificationChannel(it) }
        nm.createNotificationChannel(
            NotificationChannel(CH_MESSAGES, ctx.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH).apply {
                description = ctx.getString(R.string.channel_messages_desc)
                enableVibration(true)
                vibrationPattern = VIBRATE_MESSAGE
                enableLights(true)
                lightColor = COLOR
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_RING, ctx.getString(R.string.channel_ring), NotificationManager.IMPORTANCE_HIGH).apply {
                description = ctx.getString(R.string.channel_ring_desc)
                setSound(
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                enableVibration(true)
                vibrationPattern = VIBRATE_RING
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_CALL, ctx.getString(R.string.channel_call), NotificationManager.IMPORTANCE_LOW).apply {
                description = ctx.getString(R.string.channel_call_desc)
                setShowBadge(false)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_CONN, ctx.getString(R.string.channel_conn), NotificationManager.IMPORTANCE_MIN).apply {
                description = ctx.getString(R.string.channel_conn_desc)
                setShowBadge(false)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_UPDATE, ctx.getString(R.string.channel_update), NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = ctx.getString(R.string.channel_update_desc)
                setShowBadge(false)
            },
        )
    }

    private const val IMMUTABLE = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT

    /** Abre o app (e, com `url`, o lugar da notificação). `ring`: por cima da tela bloqueada. */
    fun openIntent(ctx: Context, url: String?, requestCode: Int, ring: Boolean = false): PendingIntent {
        val intent = Intent(ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (!url.isNullOrEmpty()) intent.putExtra(MainActivity.EXTRA_URL, url)
        if (ring) intent.putExtra(MainActivity.EXTRA_RING, true)
        return PendingIntent.getActivity(ctx, requestCode, intent, IMMUTABLE)
    }

    private fun post(ctx: Context, id: Int, n: Notification) {
        try {
            NotificationManagerCompat.from(ctx).notify(id, n)
        } catch (_: SecurityException) {
            // Notificações negadas (Android 13+): os avisos continuam dentro do app.
        }
    }

    private fun idOf(key: String) = (key.hashCode() and 0x3fffffff) or 0x100

    fun message(ctx: Context, title: String, body: String, url: String, tag: String) {
        val key = tag.ifEmpty { url.ifEmpty { title } }
        val lines = history.getOrPut(key) { mutableListOf() }
        lines += Line(title.ifEmpty { ctx.getString(R.string.app_name) }, body, System.currentTimeMillis(), false)
        while (lines.size > 8) lines.removeAt(0)
        showConversation(ctx, key, url, alert = true)
    }

    private fun showConversation(ctx: Context, key: String, url: String, alert: Boolean) {
        val lines = history[key] ?: return
        val id = idOf(key)
        val me = Person.Builder().setName(ctx.getString(R.string.me)).build()
        val style = NotificationCompat.MessagingStyle(me)
        val senders = lines.filter { !it.mine }.map { it.sender }.distinct()
        if (senders.size > 1) {
            style.isGroupConversation = true
            style.conversationTitle = ctx.getString(R.string.app_name)
        }
        for (l in lines) style.addMessage(l.text, l.at, if (l.mine) null else Person.Builder().setName(l.sender).setKey(l.sender).build())
        val target = url.ifEmpty { "/" }
        val reply = PendingIntent.getBroadcast(
            ctx,
            id,
            Intent(ctx, CallActionReceiver::class.java)
                .setAction(CallActionReceiver.ACTION_REPLY)
                .putExtra(MainActivity.EXTRA_URL, target)
                .putExtra(CallActionReceiver.EXTRA_KEY, key),
            // O texto digitado chega dentro do PendingIntent: precisa ser mutável.
            PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0),
        )
        val replyAction = NotificationCompat.Action.Builder(0, ctx.getString(R.string.reply), reply)
            .addRemoteInput(RemoteInput.Builder(KEY_REPLY).setLabel(ctx.getString(R.string.reply_hint)).build())
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .setShowsUserInterface(false)
            .build()
        val n = NotificationCompat.Builder(ctx, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(COLOR)
            .setStyle(style)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVibrate(VIBRATE_MESSAGE)
            .setDefaults(NotificationCompat.DEFAULT_SOUND or NotificationCompat.DEFAULT_LIGHTS)
            .setOnlyAlertOnce(!alert)
            .setAutoCancel(true)
            .setContentIntent(openIntent(ctx, target, id))
            .addAction(replyAction)
            .build()
        post(ctx, id, n)
    }

    /** Resposta pela notificação: entrou (aparece como "Você") ou não deu (a notificação volta como estava). */
    fun replied(ctx: Context, url: String, ok: Boolean, text: String) {
        val key = history.keys.firstOrNull { it == url } ?: url
        if (ok) history[key]?.add(Line(ctx.getString(R.string.me), text, System.currentTimeMillis(), true))
        else android.widget.Toast.makeText(ctx, ctx.getString(R.string.reply_failed), android.widget.Toast.LENGTH_LONG).show()
        showConversation(ctx, key, url, alert = false)
    }

    fun ring(ctx: Context, dmId: String, name: String, group: Boolean) {
        val who = name.ifEmpty { ctx.getString(R.string.app_name) }
        val enc = android.net.Uri.encode(dmId)
        val decline = PendingIntent.getBroadcast(
            ctx,
            RING_ID,
            Intent(ctx, CallActionReceiver::class.java)
                .setAction(CallActionReceiver.ACTION_DECLINE)
                .putExtra(MainActivity.EXTRA_URL, "/?dm=$enc&call=decline"),
            IMMUTABLE,
        )
        val answer = openIntent(ctx, "/?dm=$enc&call=answer", RING_ID + 20, ring = true)
        val caller = Person.Builder().setName(who).setImportant(true).build()
        val n = NotificationCompat.Builder(ctx, CH_RING)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(COLOR)
            .setContentTitle(who)
            .setContentText(ctx.getString(if (group) R.string.ring_group else R.string.ring_text))
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setTimeoutAfter(60_000)
            .setVibrate(VIBRATE_RING)
            .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
            .setContentIntent(openIntent(ctx, "/?dm=$enc", RING_ID + 10, ring = true))
            // Tela apagada ou bloqueada: abre a chamada em tela cheia, como as outras ligações.
            .setFullScreenIntent(openIntent(ctx, "/?dm=$enc", RING_ID + 30, ring = true), true)
            .build()
        // Toque e vibração repetem até atender, recusar ou parar de tocar.
        n.flags = n.flags or Notification.FLAG_INSISTENT
        post(ctx, RING_ID, n)
    }

    fun cancelRing(ctx: Context) = NotificationManagerCompat.from(ctx).cancel(RING_ID)

    /** Voltou para o app: as notificações de mensagem já vistas saem da central (a da chamada fica). */
    fun clearMessages(ctx: Context) {
        history.clear()
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.activeNotifications.filter { it.id != CALL_ID && it.id != CONN_ID && it.id != UPDATE_ID }.forEach { nm.cancel(it.tag, it.id) }
    }

    fun callNotification(ctx: Context, text: String?): Notification {
        val leave = PendingIntent.getBroadcast(
            ctx,
            CALL_ID,
            Intent(ctx, CallActionReceiver::class.java).setAction(CallActionReceiver.ACTION_LEAVE),
            IMMUTABLE,
        )
        val who = Person.Builder().setName(ctx.getString(R.string.call_title)).build()
        return NotificationCompat.Builder(ctx, CH_CALL)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(COLOR)
            .setContentTitle(ctx.getString(R.string.call_title))
            .apply { if (!text.isNullOrEmpty()) setContentText(text) }
            // Estilo de ligação: o Android mostra o tempo da chamada na barra de status, como nas outras.
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(who, leave))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setUsesChronometer(true)
            .setShowWhen(true)
            .setSilent(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openIntent(ctx, null, CALL_ID + 10))
            .build()
    }

    /** Atualização baixada que precisa da confirmação do sistema (a primeira, ou no Android 11-). */
    fun updateReady(ctx: Context, confirm: Intent) {
        val n = NotificationCompat.Builder(ctx, CH_UPDATE)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(COLOR)
            .setContentTitle(ctx.getString(R.string.update_title))
            .setContentText(ctx.getString(R.string.update_text))
            .setAutoCancel(true)
            .setContentIntent(PendingIntent.getActivity(ctx, UPDATE_ID, confirm, IMMUTABLE))
            .build()
        post(ctx, UPDATE_ID, n)
    }

    fun cancelUpdate(ctx: Context) = NotificationManagerCompat.from(ctx).cancel(UPDATE_ID)

    fun connectionNotification(ctx: Context): Notification =
        NotificationCompat.Builder(ctx, CH_CONN)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(COLOR)
            .setContentTitle(ctx.getString(R.string.conn_title))
            .setContentText(ctx.getString(R.string.conn_text))
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setContentIntent(openIntent(ctx, null, CONN_ID + 10))
            .build()
}
