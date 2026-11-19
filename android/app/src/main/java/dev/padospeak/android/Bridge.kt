package dev.padospeak.android

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * Ponte entre a página e o app: a página manda `PadoSpeakAndroid.postMessage(JSON)` (client/src/lib/android.js)
 * e recebe o evento `padospeak:android` na `window`. Só a página do próprio servidor fala com o app — o objeto
 * `PadoSpeakAndroid` nem existe em outras origens (WebMessageListener com a origem permitida).
 *
 * Fica fora da janela (MainActivity) porque a página continua viva sem ela: com "receber em segundo plano"
 * ligado, fechar o app pelos recentes não desconecta (WebHost guarda o WebView e o ConnectionService mantém o
 * processo), e as chamadas continuam tocando.
 */
object Bridge {
    const val NAME = "PadoSpeakAndroid"

    private lateinit var app: Context
    private var web: WebView? = null
    val origin: String = MainActivity.originOf(Uri.parse(BuildConfig.BASE_URL))
    private val main = Handler(Looper.getMainLooper())

    /** A página carregou o cliente (mandou "ready"). */
    var pageReady = false
        private set
    /** Conta conectada e "receber em segundo plano" ligado: o ConnectionService fica rodando. */
    var session = false
        private set
    var inCall = false
        private set
    /** Chamada tocando agora (para refazer a notificação se a pessoa sair da tela): dmId, nome, grupo. */
    var ringing: Triple<String, String, Boolean>? = null
        private set
    private var pendingOpen: String? = null

    fun init(ctx: Context) {
        app = ctx.applicationContext
    }

    private fun activity(): MainActivity? = MainActivity.current?.get()

    /** A pessoa está olhando o app agora? */
    fun visible(): Boolean = activity()?.isVisibleNow() == true

    /** Liga a ponte num WebView novo (uma vez por WebView). */
    fun attach(web: WebView) {
        this.web = web
        pageReady = false
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, NAME, setOf(origin)) { _, message, sourceOrigin, isMainFrame, _ ->
                if (isMainFrame && MainActivity.originOf(sourceOrigin) == origin) message.data?.let { handle(it) }
            }
        } else {
            // WebView muito antigo (sem atualização da Play Store): interface clássica, conferindo a origem.
            web.addJavascriptInterface(LegacyBridge(), NAME)
        }
    }

    /** O WebView acabou (o processo da página caiu): a chamada e o toque dele também. */
    fun detach() {
        web = null
        pageReady = false
        if (inCall) onCallState(false, false, null)
        ringing = null
        Notifier.cancelRing(app)
    }

    /** A página começou a carregar de novo (recarregar, outra página do servidor). */
    fun pageStarted() {
        pageReady = false
    }

    /** Mensagem da interface clássica (chega fora da thread principal). */
    internal fun fromLegacy(raw: String) {
        main.post {
            val url = web?.url ?: return@post
            if (MainActivity.originOf(Uri.parse(url)) == origin) handle(raw)
        }
    }

    private fun handle(raw: String) {
        val m = try {
            JSONObject(raw)
        } catch (_: Exception) {
            return
        }
        when (m.optString("type")) {
            "ready" -> {
                pageReady = true
                send("visible", visible())
                pendingOpen?.let {
                    pendingOpen = null
                    send("open", it)
                }
                activity()?.onPageReady()
            }
            "notify" -> if (!visible()) {
                Notifier.message(app, m.optString("title"), m.optString("body"), m.optString("url"), m.optString("tag"))
            }
            "ring" -> {
                val dm = if (m.isNull("dmId")) "" else m.optString("dmId")
                if (dm.isEmpty()) {
                    ringing = null
                    Notifier.cancelRing(app)
                    activity()?.onRingEnded()
                } else {
                    ringing = Triple(dm, m.optString("name"), m.optBoolean("group"))
                    if (!visible()) Notifier.ring(app, dm, m.optString("name"), m.optBoolean("group"))
                }
            }
            "call" -> onCallState(m.optBoolean("active"), m.optBoolean("camera"), m.optString("text").ifEmpty { null })
            "session" -> {
                if (m.has("keepAlive")) prefs().edit().putBoolean(KEEP_ALIVE, m.optBoolean("keepAlive")).apply()
                // Conta conectada da última vez: ao reiniciar o celular ou atualizar o app, volta a conectar sozinho.
                prefs().edit().putBoolean("lastSession", m.optBoolean("on")).apply()
                setSession(m.optBoolean("on") && keepAlive())
            }
            "bars" -> activity()?.setBars(m.optString("top"), m.optString("bottom"))
            "open" -> {
                val uri = Uri.parse(m.optString("url"))
                if (uri.scheme == "http" || uri.scheme == "https") openOutside(uri)
            }
            "download" -> Downloads.http(app, m.optString("url"), m.optString("name"), null, web?.settings?.userAgentString)
            "blob" -> Downloads.blobChunk(app, m)
            "replied" -> Notifier.replied(app, m.optString("url"), m.optBoolean("ok"), m.optString("text"))
        }
    }

    /** Abre um lugar do app (conversa, canal, atender a chamada) sem recarregar a página. */
    fun open(url: String) {
        if (pageReady) send("open", url) else pendingOpen = url
    }

    fun alive(): Boolean = web != null && pageReady

    private fun onCallState(active: Boolean, camera: Boolean, text: String?) {
        if (active) {
            val intent = Intent(app, CallService::class.java)
                .putExtra(CallService.EXTRA_CAMERA, camera)
                .putExtra(CallService.EXTRA_TEXT, text)
            try {
                ContextCompat.startForegroundService(app, intent)
            } catch (e: Exception) {
                // Android 12+: sem o app na tela não dá para começar o serviço; segue enquanto o app estiver aberto.
                android.util.Log.w("PadoSpeak", "serviço da chamada", e)
            }
        } else if (inCall) {
            app.stopService(Intent(app, CallService::class.java))
        }
        val changed = inCall != active
        inCall = active
        if (changed) activity()?.onCallChanged(active)
        // Acabou a chamada com o app fora da tela: hora boa para instalar uma atualização que estava esperando.
        if (changed && !active) Updater.installWhenIdle(app)
    }

    private const val KEEP_ALIVE = "keepAlive"

    private fun prefs() = app.getSharedPreferences("padospeak", Context.MODE_PRIVATE)

    /** "Receber chamadas e mensagens com o app em segundo plano" (ligado por padrão; a página guarda a escolha). */
    private fun keepAlive() = prefs().getBoolean(KEEP_ALIVE, true)

    /** Ao abrir o app: liga a conexão em segundo plano se a opção estiver ligada (a página corrige depois). */
    fun startIfWanted() {
        if (keepAlive()) setSession(true)
    }

    private fun setSession(on: Boolean) {
        if (on == session) return
        session = on
        if (on) {
            try {
                ContextCompat.startForegroundService(app, Intent(app, ConnectionService::class.java))
                activity()?.askBackgroundOnce()
            } catch (e: Exception) {
                android.util.Log.w("PadoSpeak", "conexão em segundo plano", e)
                session = false
            }
        } else {
            app.stopService(Intent(app, ConnectionService::class.java))
        }
    }

    /** Endereço fora do PadoSpeak: no navegador ou no app que abre esse tipo de link. */
    fun openOutside(uri: Uri) {
        val intent = when (uri.scheme?.lowercase()) {
            "http", "https", "mailto", "tel", "sms" -> Intent(Intent.ACTION_VIEW, uri)
            "intent" -> try {
                Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME).apply {
                    addCategory(Intent.CATEGORY_BROWSABLE)
                    component = null
                    selector = null
                }
            } catch (_: Exception) {
                null
            }
            else -> null
        } ?: return
        val from: Context = activity() ?: app.also { intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
        try {
            from.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            val fallback = intent.getStringExtra("browser_fallback_url")
            if (fallback != null && fallback.startsWith("http")) openOutside(Uri.parse(fallback))
            else Toast.makeText(app, app.getString(R.string.no_app_to_open), Toast.LENGTH_LONG).show()
        }
    }

    fun send(type: String, value: Any? = null) {
        val obj = JSONObject().put("type", type)
        when (value) {
            null -> {}
            is String -> obj.put(if (type == "open") "url" else "value", value)
            else -> obj.put("value", value)
        }
        send(obj)
    }

    fun send(obj: JSONObject) {
        main.post {
            val w = web ?: return@post
            val url = w.url ?: return@post
            if (MainActivity.originOf(Uri.parse(url)) != origin) return@post
            w.evaluateJavascript("window.dispatchEvent(new CustomEvent('padospeak:android',{detail:$obj}))", null)
        }
    }
}

class LegacyBridge {
    @JavascriptInterface
    fun postMessage(raw: String) = Bridge.fromLegacy(raw)
}
