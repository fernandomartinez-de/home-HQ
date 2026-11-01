package app.tvdashboard;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Remote control from the home dashboard. Runs inside HomeService, which Fire OS keeps alive.
 *
 * A background thread holds a long poll open on the tv function (it answers as soon as the
 * dashboard queues a command, or after 25 s with nothing), runs each command, and reports back
 * with the results and what's on screen. It also reports when the app on screen changes, and
 * every few minutes so the dashboard knows the TV is on.
 *
 * Commands: launch (one of the dashboard's apps), home, back, volume up/down/mute, sleep.
 */
final class RemoteControl {
    private static final String TAG = "TvDashRemote";
    private static final long HEARTBEAT_MS = 3 * 60_000;

    private final AccessibilityService service;
    private final Runnable openDashboard;
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean running;
    private volatile boolean screenOn = true;
    private volatile String app;
    private volatile boolean dirty = true;
    private Thread loop;
    private Thread reporter;

    RemoteControl(AccessibilityService service, Runnable openDashboard) {
        this.service = service;
        this.openDashboard = openDashboard;
    }

    void start() {
        if (running) return;
        running = true;
        loop = new Thread(this::pollLoop, "tv-remote");
        loop.setDaemon(true);
        loop.start();
        reporter = new Thread(this::reportLoop, "tv-remote-report");
        reporter.setDaemon(true);
        reporter.start();
    }

    void stop() {
        running = false;
        if (loop != null) loop.interrupt();
        if (reporter != null) reporter.interrupt();
    }

    /** The app on screen changed (from HomeService's window events). */
    void onApp(String pkg) {
        if (pkg == null || pkg.startsWith("com.android.systemui") || pkg.equals(app)) return;
        app = pkg;
        dirty = true;
        if (reporter != null) reporter.interrupt();
    }

    void onScreen(boolean on) {
        screenOn = on;
        dirty = true;
        if (reporter != null) reporter.interrupt();
        if (on && loop != null) loop.interrupt(); // stop any back off and poll right away
    }

    // ---------- loops ----------

    private void pollLoop() {
        long backoff = 5_000;
        while (running) {
            try {
                if (!screenOn) { Thread.sleep(30_000); continue; }
                String key = Dash.key(service);
                if (key.isEmpty()) { Thread.sleep(60_000); continue; }
                JSONObject res = request("GET", null, key, 40_000);
                JSONArray cmds = res.optJSONArray("commands");
                if (cmds != null && cmds.length() > 0) {
                    JSONArray results = new JSONArray();
                    for (int i = 0; i < cmds.length(); i++) {
                        JSONObject c = cmds.getJSONObject(i);
                        String err = run(c.optJSONObject("command"));
                        results.put(new JSONObject().put("id", c.getLong("id")).put("ok", err == null).put("error", err));
                    }
                    Thread.sleep(800); // let the app on screen settle before reporting it
                    report(key, results);
                }
                backoff = 5_000;
            } catch (InterruptedException e) {
                // woken up (screen on) or stopping
            } catch (Exception e) {
                Log.w(TAG, "poll failed: " + e.getMessage());
                try { Thread.sleep(backoff); } catch (InterruptedException ignored) { }
                backoff = Math.min(backoff * 2, 120_000);
            }
        }
    }

    private void reportLoop() {
        long last = 0;
        while (running) {
            try {
                long now = System.currentTimeMillis();
                if (dirty || now - last > HEARTBEAT_MS) {
                    String key = Dash.key(service);
                    if (!key.isEmpty()) {
                        dirty = false;
                        report(key, null);
                        last = now;
                    }
                }
                Thread.sleep(HEARTBEAT_MS);
            } catch (InterruptedException e) {
                // something changed; wait a moment so a burst of window events reports once
                try { Thread.sleep(1500); } catch (InterruptedException ignored) { }
            } catch (Exception e) {
                Log.w(TAG, "report failed: " + e.getMessage());
                dirty = true;
                try { Thread.sleep(30_000); } catch (InterruptedException ignored) { }
            }
        }
    }

    // ---------- commands ----------

    /** Runs one command on the main thread; returns null when it worked, or what went wrong. */
    private String run(JSONObject cmd) throws InterruptedException {
        if (cmd == null) return "empty command";
        final String[] err = {null};
        CountDownLatch done = new CountDownLatch(1);
        main.post(() -> {
            try {
                err[0] = runOnMain(cmd);
            } catch (Exception e) {
                err[0] = String.valueOf(e.getMessage());
            } finally {
                done.countDown();
            }
        });
        if (!done.await(5, TimeUnit.SECONDS)) return "timed out";
        return err[0];
    }

    private String runOnMain(JSONObject cmd) {
        String action = cmd.optString("action");
        AudioManager audio = (AudioManager) service.getSystemService(Context.AUDIO_SERVICE);
        switch (action) {
            case "launch": {
                String pkg = cmd.optString("app");
                boolean listed = false;
                for (String[] a : TvBridge.APPS) if (a[0].equals(pkg)) listed = true;
                if (!listed) return "that app isn't on the dashboard's list";
                PackageManager pm = service.getPackageManager();
                Intent i = pm.getLeanbackLaunchIntentForPackage(pkg);
                if (i == null) i = pm.getLaunchIntentForPackage(pkg);
                if (i == null) return "not installed on the TV";
                service.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                return null;
            }
            case "home":
                openDashboard.run();
                return null;
            case "back":
                return service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK) ? null : "the TV didn't accept Back";
            case "volume": {
                String dir = cmd.optString("dir");
                int adj = "up".equals(dir) ? AudioManager.ADJUST_RAISE
                        : "down".equals(dir) ? AudioManager.ADJUST_LOWER
                        : "mute".equals(dir) ? AudioManager.ADJUST_TOGGLE_MUTE : 0;
                if (adj == 0) return "volume needs up, down or mute";
                audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, adj, AudioManager.FLAG_SHOW_UI);
                dirty = true;
                return null;
            }
            case "sleep":
                if (Build.VERSION.SDK_INT < 28) return "this Fire OS version can't sleep from an app";
                return service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN) ? null : "the TV didn't accept sleep";
            default:
                return "unknown command " + action;
        }
    }

    // ---------- talking to Supabase ----------

    private void report(String key, JSONArray results) throws Exception {
        AudioManager audio = (AudioManager) service.getSystemService(Context.AUDIO_SERVICE);
        JSONObject state = new JSONObject()
                .put("screen", screenOn ? "on" : "off")
                .put("app", app == null ? JSONObject.NULL : app)
                .put("app_name", appName(app))
                .put("volume", audio.getStreamVolume(AudioManager.STREAM_MUSIC))
                .put("max_volume", audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC))
                .put("muted", Build.VERSION.SDK_INT >= 23 && audio.isStreamMute(AudioManager.STREAM_MUSIC))
                .put("version", BuildConfig.VERSION_NAME);
        JSONObject body = new JSONObject().put("action", "report").put("state", state);
        if (results != null) body.put("results", results);
        request("POST", body.toString(), key, 15_000);
    }

    private Object appName(String pkg) {
        if (pkg == null) return JSONObject.NULL;
        if (pkg.equals(service.getPackageName())) return "Dashboard";
        if (HomeService.AMAZON_HOME.equals(pkg)) return "Fire TV";
        for (String[] a : TvBridge.APPS) if (a[0].equals(pkg)) return a[1];
        try {
            ApplicationInfo info = service.getPackageManager().getApplicationInfo(pkg, 0);
            return service.getPackageManager().getApplicationLabel(info).toString();
        } catch (Exception e) {
            return pkg;
        }
    }

    private static JSONObject request(String method, String body, String key, int readTimeoutMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(BuildConfig.TV_REMOTE_URL).openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(10_000);
            c.setReadTimeout(readTimeoutMs);
            c.setRequestProperty("x-tv-key", key);
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                try (OutputStream os = c.getOutputStream()) { os.write(body.getBytes(StandardCharsets.UTF_8)); }
            }
            int code = c.getResponseCode();
            InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            if (in != null) {
                byte[] b = new byte[4096];
                for (int n; (n = in.read(b)) > 0; ) buf.write(b, 0, n);
                in.close();
            }
            String text = buf.toString("UTF-8");
            if (code >= 400) throw new Exception("HTTP " + code + " " + text);
            return text.isEmpty() ? new JSONObject() : new JSONObject(text);
        } finally {
            c.disconnect();
        }
    }
}
