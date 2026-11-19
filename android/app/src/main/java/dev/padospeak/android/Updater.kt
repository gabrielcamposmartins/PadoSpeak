package dev.padospeak.android

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * Atualização do app (o APK; a interface já vem do servidor): confere a release mais recente do GitHub
 * (`android.json`, publicado junto com o `PadoSpeak-android.apk`), baixa o APK novo, confere o SHA-256 e instala
 * pelo instalador do Android — o Android só aceita se a assinatura for a mesma do app instalado.
 *
 * Nunca no meio de uma chamada nem com o app na tela: o APK fica guardado e instala quando o app vai para o fundo.
 * No Android 12+, depois que o próprio PadoSpeak instalou uma vez, instala sem perguntar; antes disso (ou no
 * Android 11-), aparece a confirmação do sistema (na hora, com o app aberto, ou numa notificação).
 */
object Updater {
    private const val MANIFEST = "https://github.com/gabrielcamposmartins/PadoSpeak/releases/latest/download/android.json"
    private const val TRUSTED = "https://github.com/gabrielcamposmartins/PadoSpeak/releases/download/"
    private const val CHECK_EVERY_MS = 3 * 60 * 60 * 1000L
    const val ACTION_STATUS = "dev.padospeak.android.INSTALL_STATUS"

    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    /** APK novo já baixado e conferido, esperando a hora de instalar. */
    @Volatile
    private var ready: File? = null
    @Volatile
    private var installing = false
    @Volatile
    private var checking = false

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("padospeak", Context.MODE_PRIVATE)

    /** Confere se há versão nova (no máximo a cada 3 horas). */
    fun maybeCheck(ctx: Context, force: Boolean = false) {
        if (BuildConfig.DEBUG || checking || installing) return
        val app = ctx.applicationContext
        val last = prefs(app).getLong("updateCheckedAt", 0)
        if (!force && ready == null && System.currentTimeMillis() - last < CHECK_EVERY_MS) return
        checking = true
        io.execute {
            try {
                check(app)
            } catch (e: Exception) {
                android.util.Log.w("PadoSpeak", "atualização", e)
            } finally {
                checking = false
            }
        }
    }

    private fun check(app: Context) {
        prefs(app).edit().putLong("updateCheckedAt", System.currentTimeMillis()).apply()
        val info = JSONObject(String(get(MANIFEST), Charsets.UTF_8))
        val code = info.optLong("versionCode")
        if (code <= BuildConfig.VERSION_CODE) {
            ready = null
            File(app.cacheDir, "update").deleteRecursively()
            return
        }
        val url = info.optString("url")
        val sha = info.optString("sha256").lowercase()
        if (!url.startsWith(TRUSTED) || sha.length != 64) return
        val dir = File(app.cacheDir, "update").apply { mkdirs() }
        val apk = File(dir, "PadoSpeak-$code.apk")
        if (!(apk.exists() && sha256(apk) == sha)) {
            dir.listFiles()?.forEach { it.delete() }
            val tmp = File(dir, "baixando.tmp")
            download(url, tmp)
            if (sha256(tmp) != sha) {
                tmp.delete()
                throw IllegalStateException("SHA-256 diferente do anunciado")
            }
            tmp.renameTo(apk)
        }
        ready = apk
        main.post { installWhenIdle(app) }
    }

    /** Instala o APK guardado se agora é uma boa hora: sem chamada e com o app fora da tela. */
    fun installWhenIdle(ctx: Context) {
        val apk = ready ?: return
        if (installing || Bridge.inCall || Bridge.visible()) return
        installing = true
        val app = ctx.applicationContext
        io.execute {
            try {
                install(app, apk)
            } catch (e: Exception) {
                android.util.Log.w("PadoSpeak", "instalar atualização", e)
                installing = false
            }
        }
    }

    private fun install(app: Context, apk: File) {
        val installer = app.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(app.packageName)
            setSize(apk.length())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite("base.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val status = Intent(app, InstallReceiver::class.java).setAction(ACTION_STATUS)
            // O sistema preenche o resultado no PendingIntent: precisa ser mutável.
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
            session.commit(PendingIntent.getBroadcast(app, id, status, flags).intentSender)
        }
    }

    /** Resultado da instalação (InstallReceiver). */
    fun finished(ok: Boolean, cancelled: Boolean) {
        installing = false
        if (ok) ready = null
        // Recusou ou falhou: tenta de novo na próxima conferência (daqui a 3 horas), sem insistir agora.
        if (cancelled) ready = null
    }

    private fun connect(url: String): HttpURLConnection {
        var current = url
        repeat(5) {
            val c = URL(current).openConnection() as HttpURLConnection
            c.connectTimeout = 15_000
            c.readTimeout = 60_000
            c.instanceFollowRedirects = false
            c.setRequestProperty("User-Agent", "PadoSpeakAndroid/${BuildConfig.VERSION_NAME}")
            val code = c.responseCode
            if (code in 300..399) {
                val next = c.getHeaderField("Location") ?: throw IllegalStateException("redirecionamento sem destino")
                c.disconnect()
                if (!next.startsWith("https://")) throw IllegalStateException("redirecionamento inseguro")
                current = next
            } else {
                if (code != 200) throw IllegalStateException("HTTP $code")
                return c
            }
        }
        throw IllegalStateException("redirecionamentos demais")
    }

    private fun get(url: String): ByteArray = connect(url).let { c -> c.inputStream.use { it.readBytes() }.also { c.disconnect() } }

    private fun download(url: String, to: File) {
        val c = connect(url)
        c.inputStream.use { input -> to.outputStream().use { input.copyTo(it) } }
        c.disconnect()
    }

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
