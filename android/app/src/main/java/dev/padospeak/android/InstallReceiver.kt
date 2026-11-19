package dev.padospeak.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build

/** Resultado da instalação da atualização (Updater): confirmação do sistema, pronto ou falhou. */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Updater.ACTION_STATUS) return
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                // Primeira atualização (o app veio do navegador) ou Android 11-: o sistema pede a confirmação.
                val confirm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(Intent.EXTRA_INTENT)
                } ?: return Updater.finished(ok = false, cancelled = false)
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                val activity = MainActivity.current?.get()
                if (activity != null && activity.isVisibleNow()) activity.startActivity(confirm)
                else Notifier.updateReady(ctx, confirm)
            }
            PackageInstaller.STATUS_SUCCESS -> {
                Notifier.cancelUpdate(ctx)
                Updater.finished(ok = true, cancelled = false)
            }
            else -> {
                android.util.Log.w("PadoSpeak", "atualização: $status ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
                Updater.finished(ok = false, cancelled = status == PackageInstaller.STATUS_FAILURE_ABORTED)
            }
        }
    }
}
