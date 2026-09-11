# Add project specific ProGuard rules here.

# The WebView bridge is called by name from JavaScript (window.AccordBridge.*).
# The default optimize config already keeps @JavascriptInterface methods; this
# pins the class name too so stack traces and evaluateJavascript hooks stay readable.
-keep class com.accord.app.AccordBridge { *; }
-keepattributes JavascriptInterface
