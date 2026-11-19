package dev.padospeak.android

import android.annotation.SuppressLint
import android.content.Context
import android.content.MutableContextWrapper
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

/**
 * Guarda o WebView da página fora da janela: fechar o app (voltar, recentes) destrói só a janela; a página
 * continua viva e conectada, e a próxima janela usa o mesmo WebView, no mesmo lugar, sem recarregar. O contexto
 * do WebView troca entre a janela e o app (MutableContextWrapper).
 */
object WebHost {
    var web: WebView? = null

    val context: MutableContextWrapper?
        get() = web?.context as? MutableContextWrapper

    /** WebView novo da página, já com a ponte (`ctx`: a janela, ou o app quando ela não está aberta). */
    @SuppressLint("SetJavaScriptEnabled")
    fun create(ctx: Context): WebView {
        val app = ctx.applicationContext
        val web = WebView(MutableContextWrapper(ctx))
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.setBackgroundColor(app.getColor(R.color.launch_bg))
        web.overScrollMode = View.OVER_SCROLL_NEVER
        // O processo da página continua importante fora da tela: sem isto o WebView o rebaixa e o Android o
        // mata em segundo plano, e o app recarregava a página ao voltar.
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            // O layout do app já se ajusta; o tamanho de letra do sistema não deve quebrar as telas.
            textZoom = 100
            userAgentString = "$userAgentString PadoSpeakAndroid/${BuildConfig.VERSION_NAME}"
        }
        // O tema escuro é do próprio app (prefers-color-scheme), não o escurecimento automático do WebView.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(web.settings, false)
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(web, false)
        }
        web.setDownloadListener { url, userAgent, contentDisposition, mimetype, _ ->
            Downloads.fromWebView(app, web, url, userAgent, contentDisposition, mimetype)
        }
        Bridge.init(app)
        Bridge.attach(web)
        this.web = web
        return web
    }
}
