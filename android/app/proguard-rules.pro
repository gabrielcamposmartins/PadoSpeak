# Ponte com a página (addJavascriptInterface, só nos WebViews antigos sem WebMessageListener)
-keepclassmembers class dev.padospeak.android.LegacyBridge {
    @android.webkit.JavascriptInterface <methods>;
}
