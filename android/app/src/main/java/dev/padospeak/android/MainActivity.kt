package dev.padospeak.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.webkit.MimeTypeMap
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import java.lang.ref.WeakReference
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * O PadoSpeak no Android: um WebView que abre o servidor da comunidade (o mesmo cliente do navegador, sempre na
 * versão do servidor) e, por fora dele, o que o navegador do celular não faz sozinho num app:
 *  - microfone e câmera pedidos ao Android na hora em que a página pede; a câmera do celular para fotos e vídeos;
 *  - notificações do sistema, a chamada recebida por cima da tela bloqueada e a chamada que continua com a tela
 *    apagada (CallService); conectado em segundo plano para receber (ConnectionService);
 *  - escolher arquivos, baixar anexos, links de fora no navegador, tela cheia dos vídeos;
 *  - barras do sistema na cor das bordas do app e o "voltar" que volta uma tela.
 * A página e o app conversam pela ponte `PadoSpeakAndroid` (Bridge.kt, client/src/lib/android.js).
 */
class MainActivity : ComponentActivity() {
    companion object {
        const val EXTRA_URL = "dev.padospeak.android.URL"
        const val EXTRA_RING = "dev.padospeak.android.RING"

        /** A janela viva (a ponte e as notificações falam com ela quando existe). */
        @Volatile
        var current: WeakReference<MainActivity>? = null

        fun originOf(uri: Uri?): String {
            if (uri == null || uri.scheme == null || uri.host == null) return ""
            val port = if (uri.port != -1) ":${uri.port}" else ""
            return "${uri.scheme!!.lowercase()}://${uri.host!!.lowercase()}$port"
        }
    }

    private val base: Uri = Uri.parse(BuildConfig.BASE_URL)

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var topScrim: View
    private lateinit var offline: LinearLayout

    private var resumed = false
    private var barTop = 0
    private var barBottom = 0
    /** Aberta pela chamada recebida: aparece por cima da tela bloqueada até a chamada acabar. */
    private var overLock = false

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingWebPermission: PermissionRequest? = null
    private var pendingResources: Array<String> = emptyArray()
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var cameraFile: File? = null
    private var cameraUri: Uri? = null
    private var pendingCapture: (() -> Unit)? = null

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val data = r.data
        val uris: Array<Uri>? = when {
            r.resultCode != RESULT_OK || data == null -> null
            data.clipData != null -> data.clipData!!.let { clip -> Array(clip.itemCount) { clip.getItemAt(it).uri } }
            data.data != null -> arrayOf(data.data!!)
            else -> null
        }
        fileCallback?.onReceiveValue(uris)
        fileCallback = null
    }

    private val takeWithCamera = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val file = cameraFile
        val uris: Array<Uri>? = when {
            r.resultCode != RESULT_OK -> null
            file != null && file.length() > 0 -> arrayOf(cameraUri!!)
            // Alguns apps de câmera gravam o vídeo onde querem e devolvem o endereço.
            r.data?.data != null -> arrayOf(r.data!!.data!!)
            else -> null
        }
        if (uris == null) file?.delete()
        fileCallback?.onReceiveValue(uris)
        fileCallback = null
    }

    private val askPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        val req = pendingWebPermission ?: return@registerForActivityResult
        pendingWebPermission = null
        val ok = pendingResources.filter { granted(androidPermissionFor(it)) }
        if (ok.isEmpty()) {
            req.deny()
            toast(getString(R.string.permission_denied))
        } else {
            req.grant(ok.toTypedArray())
        }
    }

    private val askCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        val next = pendingCapture
        pendingCapture = null
        if (ok) {
            next?.invoke()
        } else {
            toast(getString(R.string.permission_denied))
            fileCallback?.onReceiveValue(null)
            fileCallback = null
        }
    }

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        barTop = getColor(R.color.bar_top)
        barBottom = getColor(R.color.bar_bottom)
        enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        current = WeakReference(this)
        Bridge.init(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) window.isNavigationBarContrastEnforced = false
        Notifier.createChannels(this)
        applyRing(intent)

        // A página que ficou conectada em segundo plano volta para esta janela, no mesmo lugar.
        val kept = WebHost.web
        web = if (kept != null) {
            (kept.parent as? ViewGroup)?.removeView(kept)
            WebHost.context?.baseContext = this
            kept
        } else {
            WebHost.create(this)
        }
        web.webViewClient = PageClient()
        web.webChromeClient = Chrome()

        root = FrameLayout(this).apply { setBackgroundColor(barBottom) }
        topScrim = View(this).apply { setBackgroundColor(barTop) }
        offline = buildOfflineView()
        root.addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        root.addView(topScrim, FrameLayout.LayoutParams(MATCH_PARENT, 0, Gravity.TOP))
        root.addView(offline, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        setContentView(root)

        // A página fica entre as barras do sistema (e acima do teclado); as faixas das barras ganham a cor das
        // bordas do app, que a página informa (setBars).
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val bottom = maxOf(bars.bottom, ime.bottom)
            (web.layoutParams as FrameLayout.LayoutParams).setMargins(bars.left, bars.top, bars.right, bottom)
            web.requestLayout()
            topScrim.layoutParams.height = bars.top
            topScrim.requestLayout()
            offline.setPadding(bars.left, bars.top, bars.right, bottom)
            WindowInsetsCompat.CONSUMED
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    customView != null -> customViewCallback?.onCustomViewHidden()
                    web.canGoBack() -> web.goBack()
                    // Na tela inicial do app: vai para o fundo (como o botão início), sem fechar a chamada.
                    else -> moveTaskToBack(true)
                }
            }
        })

        // Fica conectado em segundo plano desde a abertura (a página desliga se a pessoa sair da conta ou
        // desligar a opção em Notificações).
        Bridge.startIfWanted()
        Updater.maybeCheck(this)

        if (kept == null) {
            web.loadUrl(startUrl(intent) ?: BuildConfig.BASE_URL)
        } else {
            startUrl(intent)?.let { deliver(it) }
            if (Bridge.inCall) onCallChanged(true)
        }
    }

    fun isOurs(uri: Uri?): Boolean = originOf(uri) == Bridge.origin

    /** Endereço que a notificação ou o link pediu (relativo ao servidor ou um link do PadoSpeak). */
    private fun startUrl(intent: Intent?): String? {
        intent ?: return null
        intent.getStringExtra(EXTRA_URL)?.takeIf { it.isNotBlank() }?.let { return absolute(it) }
        val data = intent.data
        if (intent.action == Intent.ACTION_VIEW && data != null && (isOurs(data) || data.host == base.host)) {
            return base.buildUpon().encodedPath(data.encodedPath).encodedQuery(data.encodedQuery).build().toString()
        }
        return null
    }

    private fun absolute(url: String): String? {
        val uri = Uri.parse(url)
        return when {
            uri.isAbsolute -> if (isOurs(uri)) url else null
            url.startsWith("/") -> BuildConfig.BASE_URL.trimEnd('/') + url
            else -> null
        }
    }

    /** Conversa, canal ou chamada: a página abre sem recarregar. Outras páginas (convite): carrega. */
    private fun deliver(url: String) {
        val path = Uri.parse(url).path
        if (path.isNullOrEmpty() || path == "/") Bridge.open(url) else web.loadUrl(url)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        applyRing(intent)
        startUrl(intent)?.let { deliver(it) }
    }

    // ---------- Chamada recebida por cima da tela bloqueada ----------

    private fun applyRing(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_RING, false) != true) return
        overLock = true
        showOverLock(true)
    }

    @Suppress("DEPRECATION")
    private fun showOverLock(on: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(on)
            setTurnScreenOn(on)
        } else {
            val flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            if (on) window.addFlags(flags) else window.clearFlags(flags)
        }
    }

    /** Parou de tocar (recusou, quem ligou desistiu) sem entrar na chamada: volta a tela bloqueada. */
    fun onRingEnded() {
        if (overLock && !Bridge.inCall) leaveLockScreen()
    }

    private fun leaveLockScreen() {
        overLock = false
        showOverLock(false)
        if (getSystemService(KeyguardManager::class.java).isKeyguardLocked) moveTaskToBack(true)
    }

    // ---------- Página ----------

    /** A página carregou o app (android.js mandou "ready"). */
    fun onPageReady() {
        askNotificationsOnce()
    }

    private val prefs by lazy { getSharedPreferences("padospeak", MODE_PRIVATE) }

    private fun once(key: String): Boolean {
        if (prefs.getBoolean(key, false)) return false
        prefs.edit().putBoolean(key, true).apply()
        return true
    }

    /** Sem as notificações liberadas, pede (uma vez cada vez que o app abre; o Android para de mostrar se negar duas vezes). */
    private var askedThisRun = false

    private fun askNotificationsOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (granted(Manifest.permission.POST_NOTIFICATIONS) || askedThisRun) return
        askedThisRun = true
        askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    /** Botões do diagnóstico (Configurações → Notificações): libera o que está faltando. */
    @SuppressLint("BatteryLife")
    fun fix(what: String) {
        val pkg = Uri.parse("package:$packageName")
        val intent = when (what) {
            "notifications" ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !granted(Manifest.permission.POST_NOTIFICATIONS) &&
                    shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
                ) {
                    askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                    null
                } else {
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                }
            "battery" -> Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg)
            "fullScreen" -> if (Build.VERSION.SDK_INT >= 34) Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg) else null
            else -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
        } ?: return
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg))
        }
    }

    /**
     * Conectado em segundo plano pela primeira vez: pede para o Android não cortar a internet do app com o
     * celular parado (economia de bateria) e, no Android 14+, a chamada em tela cheia se ela estiver negada.
     */
    @SuppressLint("BatteryLife")
    fun askBackgroundOnce() {
        val power = getSystemService(PowerManager::class.java)
        if (!power.isIgnoringBatteryOptimizations(packageName) && once("askedBattery")) {
            try {
                startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
            } catch (_: ActivityNotFoundException) {
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
            !getSystemService(NotificationManager::class.java).canUseFullScreenIntent() && once("askedFullScreen")
        ) {
            try {
                startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName")))
            } catch (_: ActivityNotFoundException) {
            }
        }
    }

    /** A pessoa está olhando o app agora? */
    fun isVisibleNow(): Boolean = resumed

    override fun onResume() {
        super.onResume()
        resumed = true
        web.onResume()
        Bridge.send("visible", true)
        Bridge.sendStatus()
        Notifier.clearMessages(this)
    }

    override fun onPause() {
        resumed = false
        Bridge.send("visible", false)
        // Ainda tocando: a notificação de chamada volta (com o toque do celular).
        Bridge.ringing?.let { (dm, name, group) -> Notifier.ring(this, dm, name, group) }
        // Em chamada a página continua "visível" para o WebView (nada de pausar vídeo nem atrasar timers).
        if (!Bridge.inCall) web.onPause()
        // Foi para o fundo: se uma atualização baixada estava esperando, instala agora (sem chamada).
        Updater.installWhenIdle(this)
        super.onPause()
    }

    override fun onDestroy() {
        if (current?.get() === this) current = null
        root.removeView(web)
        // Fechou a janela (voltar, recentes): a página continua viva e conectada, e a próxima janela usa a
        // mesma, sem recarregar. Ela só acaba se o Android encerrar o processo.
        WebHost.context?.baseContext = applicationContext
        web.webChromeClient = WebChromeClient()
        super.onDestroy()
    }

    /** Entrou ou saiu de uma chamada. */
    fun onCallChanged(active: Boolean) {
        volumeControlStream = if (active) AudioManager.STREAM_VOICE_CALL else AudioManager.USE_DEFAULT_STREAM_TYPE
        if (!active) {
            if (!resumed) web.onPause()
            if (overLock) leaveLockScreen()
        }
    }

    /** Cores das bordas do app (a faixa de cima e a de baixo) para as barras do sistema. */
    fun setBars(top: String?, bottom: String?) {
        val t = CssColor.parse(top) ?: return
        val b = CssColor.parse(bottom) ?: return
        if (t == barTop && b == barBottom) return
        barTop = t
        barBottom = b
        topScrim.setBackgroundColor(t)
        root.setBackgroundColor(b)
        if (customView == null) applyBarIcons()
    }

    private fun applyBarIcons() {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.isAppearanceLightStatusBars = CssColor.isLight(barTop)
        controller.isAppearanceLightNavigationBars = CssColor.isLight(barBottom)
    }

    fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()

    private fun granted(permission: String) =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun androidPermissionFor(resource: String) =
        if (resource == PermissionRequest.RESOURCE_VIDEO_CAPTURE) Manifest.permission.CAMERA else Manifest.permission.RECORD_AUDIO

    fun showOffline(on: Boolean) {
        offline.visibility = if (on) View.VISIBLE else View.GONE
    }

    private fun buildOfflineView(): LinearLayout {
        val dp = { v: Int -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt() }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(getColor(R.color.launch_bg))
            visibility = View.GONE
            isClickable = true
            val titleView = TextView(context).apply {
                text = getString(R.string.offline_title)
                setTextColor(Color.WHITE)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
                gravity = Gravity.CENTER
            }
            val textView = TextView(context).apply {
                text = getString(R.string.offline_text)
                setTextColor(0xDDFFFFFF.toInt())
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                gravity = Gravity.CENTER
                setPadding(dp(32), dp(8), dp(32), dp(20))
            }
            val retryButton = Button(context).apply {
                text = getString(R.string.offline_retry)
                setOnClickListener {
                    offline.visibility = View.GONE
                    if (web.url.isNullOrEmpty() || web.url == "about:blank") web.loadUrl(BuildConfig.BASE_URL) else web.reload()
                }
            }
            addView(titleView, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
            addView(textView, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
            addView(retryButton, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        }
    }

    // ---------- Câmera do celular (fotos e vídeos para a conversa) ----------

    private fun capture(video: Boolean) {
        if (!granted(Manifest.permission.CAMERA)) {
            // Com a permissão de câmera no app, o Android exige que ela esteja liberada até para abrir a câmera dele.
            pendingCapture = { capture(video) }
            askCamera.launch(Manifest.permission.CAMERA)
            return
        }
        val dir = File(cacheDir, "camera").apply { mkdirs() }
        // Sobras de capturas antigas (já enviadas ou desistidas).
        dir.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86_400_000 }?.forEach { it.delete() }
        val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val file = File(dir, if (video) "VID_$stamp.mp4" else "IMG_$stamp.jpg")
        val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
        cameraFile = file
        cameraUri = uri
        val intent = Intent(if (video) MediaStore.ACTION_VIDEO_CAPTURE else MediaStore.ACTION_IMAGE_CAPTURE)
            .putExtra(MediaStore.EXTRA_OUTPUT, uri)
            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            takeWithCamera.launch(intent)
        } catch (_: ActivityNotFoundException) {
            toast(getString(R.string.no_app_to_open))
            fileCallback?.onReceiveValue(null)
            fileCallback = null
        }
    }

    private fun chooseCapture(photo: Boolean, video: Boolean) {
        when {
            photo && !video -> capture(false)
            video && !photo -> capture(true)
            else -> {
                var picked = false
                AlertDialog.Builder(this)
                    .setTitle(R.string.camera_title)
                    .setItems(arrayOf(getString(R.string.camera_photo), getString(R.string.camera_video))) { _, which ->
                        picked = true
                        capture(which == 1)
                    }
                    .setOnDismissListener {
                        if (!picked) {
                            fileCallback?.onReceiveValue(null)
                            fileCallback = null
                        }
                    }
                    .show()
            }
        }
    }

    // ---------- WebView ----------

    class PageClient : WebViewClient() {
        private val activity get() = current?.get()
        private var failed = false

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (originOf(request.url) == Bridge.origin) return false
            if (request.isForMainFrame) Bridge.openOutside(request.url)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            Bridge.pageStarted()
            failed = false
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (!failed) activity?.showOffline(false)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            failed = true
            activity?.showOffline(true)
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
            // Servidor fora do ar (502/503 do proxy): a tela de "sem conexão" em vez da página de erro.
            if (!request.isForMainFrame || errorResponse.statusCode < 500) return
            failed = true
            activity?.showOffline(true)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // O processo da página caiu (memória): recomeça em vez de fechar o app. Sem a janela aberta, a
            // página volta em segundo plano, para continuar recebendo chamadas e mensagens.
            (view.parent as? ViewGroup)?.removeView(view)
            if (WebHost.web === view) WebHost.web = null
            Bridge.detach()
            view.destroy()
            val a = activity
            if (a != null) {
                a.recreate()
            } else {
                WebHost.create(view.context.applicationContext).apply {
                    webViewClient = PageClient()
                    loadUrl(BuildConfig.BASE_URL)
                }
            }
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) {
            runOnUiThread {
                if (originOf(request.origin) != Bridge.origin) {
                    request.deny()
                    return@runOnUiThread
                }
                val wanted = request.resources.filter {
                    it == PermissionRequest.RESOURCE_AUDIO_CAPTURE || it == PermissionRequest.RESOURCE_VIDEO_CAPTURE
                }
                if (wanted.isEmpty()) {
                    request.deny()
                    return@runOnUiThread
                }
                val missing = wanted.map { androidPermissionFor(it) }.filter { !granted(it) }.toMutableList()
                if (missing.isEmpty()) {
                    request.grant(wanted.toTypedArray())
                    return@runOnUiThread
                }
                // Fones Bluetooth na chamada (Android 12+): pedido junto com o microfone, sem ser obrigatório.
                if (Manifest.permission.RECORD_AUDIO in missing && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                    !granted(Manifest.permission.BLUETOOTH_CONNECT)
                ) missing += Manifest.permission.BLUETOOTH_CONNECT
                pendingWebPermission?.deny()
                pendingWebPermission = request
                pendingResources = wanted.toTypedArray()
                askPermissions.launch(missing.toTypedArray())
            }
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest) {
            if (pendingWebPermission === request) pendingWebPermission = null
        }

        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams,
        ): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            val types = params.acceptTypes.flatMap { it.split(',') }.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
            val mimes = types.mapNotNull { t ->
                if (t.startsWith(".")) MimeTypeMap.getSingleton().getMimeTypeFromExtension(t.drop(1)) else t
            }.distinct()
            // Botão "Câmera" da conversa (<input capture>): a câmera do próprio celular, com foto ou vídeo.
            if (params.isCaptureEnabled) {
                val photo = mimes.isEmpty() || mimes.any { it.startsWith("image/") }
                val video = mimes.any { it.startsWith("video/") }
                chooseCapture(photo, video)
                return true
            }
            val intent = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(if (mimes.size == 1) mimes[0] else "*/*")
            if (mimes.size > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toTypedArray())
            if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            return try {
                pickFiles.launch(intent)
                true
            } catch (_: ActivityNotFoundException) {
                fileCallback = null
                false
            }
        }

        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            // window.open: o endereço vai para o navegador do sistema (a página do PadoSpeak não perde o lugar).
            val popup = WebView(this@MainActivity)
            var handled = false
            val take = { url: String? ->
                if (!handled && !url.isNullOrEmpty() && url != "about:blank") {
                    handled = true
                    Bridge.openOutside(Uri.parse(url))
                    popup.post { popup.destroy() }
                }
            }
            popup.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                    take(r.url.toString())
                    return true
                }

                override fun onPageStarted(v: WebView, url: String?, favicon: Bitmap?) {
                    take(url)
                }
            }
            (resultMsg.obj as WebView.WebViewTransport).webView = popup
            resultMsg.sendToTarget()
            return true
        }

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            // Tela cheia de um vídeo (ou da chamada): por cima de tudo, sem as barras do sistema.
            customView?.let { root.removeView(it) }
            customView = view
            customViewCallback = callback
            root.addView(view, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            WindowCompat.getInsetsController(window, window.decorView).apply {
                systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                hide(WindowInsetsCompat.Type.systemBars())
            }
        }

        override fun onHideCustomView() {
            customView?.let { root.removeView(it) }
            customView = null
            customViewCallback = null
            WindowCompat.getInsetsController(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
            applyBarIcons()
        }

        // Sem o ícone cinza de "play" nos vídeos antes de começarem.
        override fun getDefaultVideoPoster(): Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    }
}
