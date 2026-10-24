package app.tvdashboard;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** Shared setup for the app and the screensaver: a full screen WebView on the dashboard page. */
final class Dash {
    static final String PAGE = BuildConfig.PAGE_URL;
    private static final String PREFS = "dash";
    private static final String KEY = "tv_key";

    private Dash() {}

    /** Saves the access key, which is set once over ADB: am start ... --es key VALUE */
    static void saveKey(Context c, String key) {
        if (key != null && key.matches("[A-Za-z0-9]{16,}")) {
            prefs(c).edit().putString(KEY, key).apply();
        }
    }

    static String url(Context c) {
        String key = prefs(c).getString(KEY, "");
        return key.isEmpty() ? PAGE : PAGE + "#k=" + key;
    }

    @SuppressLint("SetJavaScriptEnabled")
    static WebView create(Context c) { return create(c, null); }

    /** bridge (optional) is exposed to the page as window.TV before it loads. */
    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface", "AddJavascriptInterface"})
    static WebView create(Context c, Object bridge) {
        WebView web = new WebView(c);
        web.setBackgroundColor(Color.BLACK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, int code, String desc, String failingUrl) {
                // No network yet (e.g. right after the TV wakes): try again shortly.
                view.postDelayed(() -> view.loadUrl(url(view.getContext())), 15000);
            }
        });
        web.setFocusable(false);
        if (bridge != null) web.addJavascriptInterface(bridge, "TV");
        web.loadUrl(url(c));
        return web;
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
