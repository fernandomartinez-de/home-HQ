package app.tvdashboard;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.WebView;

public class MainActivity extends Activity {
    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Dash.saveKey(this, getIntent().getStringExtra("key"));
        web = Dash.create(this, new TvBridge(this));
        setContentView(web);
        hideBars();
        // Android only reveals the Wi-Fi network name to apps with location access; ask once.
        if (checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.ACCESS_FINE_LOCATION}, 1);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String key = intent.getStringExtra("key");
        if (key != null) {
            Dash.saveKey(this, key);
            web.loadUrl(Dash.url(this));
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideBars();
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        switch (code) {
            // The page handles navigation: Up/Down move between the top buttons and the app row,
            // Left/Right move along a row, OK opens.
            case KeyEvent.KEYCODE_DPAD_LEFT: send("left"); return true;
            case KeyEvent.KEYCODE_DPAD_RIGHT: send("right"); return true;
            case KeyEvent.KEYCODE_DPAD_UP: send("up"); return true;
            case KeyEvent.KEYCODE_DPAD_DOWN: send("down"); return true;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER: send("ok"); return true;
            // Fast forward / rewind: next / previous background video.
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: send("ff"); return true;
            case KeyEvent.KEYCODE_MEDIA_REWIND: send("rw"); return true;
            // Menu (three lines button): reload the dashboard.
            case KeyEvent.KEYCODE_MENU:
                web.loadUrl(Dash.url(this));
                web.reload();
                return true;
            // Back closes an open folder; otherwise it stays on the dashboard (the home screen).
            case KeyEvent.KEYCODE_BACK: send("back"); return true;
            default:
                return super.onKeyDown(code, e);
        }
    }

    private void send(String cmd) {
        web.evaluateJavascript("window.tvKey && window.tvKey('" + cmd + "')", null);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    private void hideBars() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }
}
