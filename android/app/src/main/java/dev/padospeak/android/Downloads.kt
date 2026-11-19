package dev.padospeak.android

import android.app.DownloadManager
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.WebView
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.io.OutputStream
import java.util.concurrent.Executors

/**
 * Downloads: anexos (endereço do servidor) vão pelo gerenciador de downloads do Android, com a notificação
 * do sistema; arquivos gerados na página (blob:) chegam em pedaços pela ponte e são gravados em Downloads.
 */
object Downloads {
    private val io = Executors.newSingleThreadExecutor()
    private class Pending(val out: OutputStream, val uri: Uri?, val name: String)
    private val pending = HashMap<String, Pending>()

    private val main = Handler(Looper.getMainLooper())
    private fun toast(ctx: Context, text: String) = main.post { Toast.makeText(ctx, text, Toast.LENGTH_LONG).show() }

    private fun clean(name: String): String =
        name.replace(Regex("""[\\/:*?"<>|\x00-\x1f]"""), "_").trim().trimStart('.').take(150).ifEmpty { "arquivo" }

    fun http(a: Context, url: String, name: String?, mime: String?, userAgent: String?) {
        val uri = Uri.parse(url)
        if (uri.scheme != "https" && uri.scheme != "http") return
        val file = clean(name?.takeIf { it.isNotBlank() } ?: URLUtil.guessFileName(url, null, mime))
        try {
            val req = DownloadManager.Request(uri)
                .setTitle(file)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            // Android 9 ou anterior: pasta do app (a pasta Downloads pública pediria outra permissão).
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, file)
            else req.setDestinationInExternalFilesDir(a, Environment.DIRECTORY_DOWNLOADS, file)
            CookieManager.getInstance().getCookie(url)?.let { req.addRequestHeader("Cookie", it) }
            userAgent?.let { req.addRequestHeader("User-Agent", it) }
            mime?.takeIf { it.isNotBlank() }?.let { req.setMimeType(it) }
            (a.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
            toast(a, a.getString(R.string.download_started, file))
        } catch (e: Exception) {
            android.util.Log.w("PadoSpeak", "download", e)
            toast(a, a.getString(R.string.download_failed))
        }
    }

    /** Download pedido pelo próprio WebView (link com `download` que a página não tratou). */
    fun fromWebView(a: Context, web: WebView, url: String, userAgent: String?, contentDisposition: String?, mime: String?) {
        val name = URLUtil.guessFileName(url, contentDisposition, mime)
        if (url.startsWith("blob:") || url.startsWith("data:")) {
            // Só a página consegue ler um blob: ela manda os bytes pela ponte.
            val js = """
                (async () => {
                  try {
                    const b = await (await fetch(${JSONObject.quote(url)})).blob();
                    window.__padospeakSaveBlob?.(b, ${JSONObject.quote(name)});
                  } catch (e) { console.warn('[download]', e); }
                })();
            """.trimIndent()
            web.evaluateJavascript(js, null)
            return
        }
        http(a, url, name, mime, userAgent)
    }

    /** Pedaço de um arquivo da página: { id, name, mime, data (base64), last }. */
    fun blobChunk(a: Context, m: JSONObject) {
        val id = m.optString("id").ifEmpty { return }
        val name = clean(m.optString("name"))
        val mime = m.optString("mime").ifEmpty { "application/octet-stream" }
        val data = m.optString("data")
        val last = m.optBoolean("last")
        val app = a.applicationContext
        io.execute {
            try {
                val p = pending[id] ?: open(app, name, mime).also { pending[id] = it }
                if (data.isNotEmpty()) p.out.write(Base64.decode(data, Base64.DEFAULT))
                if (last) {
                    pending.remove(id)
                    p.out.close()
                    if (p.uri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        app.contentResolver.update(p.uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
                    }
                    toast(app, a.getString(R.string.download_saved, p.name))
                }
            } catch (e: Exception) {
                android.util.Log.w("PadoSpeak", "download", e)
                pending.remove(id)?.let { runCatching { it.out.close() } }
                toast(app, a.getString(R.string.download_failed))
            }
        }
    }

    private fun open(ctx: Context, name: String, mime: String): Pending {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("sem Downloads")
            val out = ctx.contentResolver.openOutputStream(uri) ?: throw IllegalStateException("sem Downloads")
            return Pending(out, uri, name)
        }
        val dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: ctx.filesDir
        dir.mkdirs()
        var file = File(dir, name)
        var n = 1
        while (file.exists()) file = File(dir, "${name.substringBeforeLast('.')} (${n++})${name.substringAfterLast('.', "").let { if (it.isEmpty()) "" else ".$it" }}")
        return Pending(file.outputStream(), null, file.name)
    }
}
