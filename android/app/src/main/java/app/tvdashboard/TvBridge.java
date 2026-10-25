package app.tvdashboard;

import android.app.Activity;
import android.content.Context;
import android.content.ComponentName;
import android.content.Intent;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.os.SystemClock;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;

/** What the dashboard page can ask of the TV: the app row and launching an app from it. */
final class TvBridge {
    /** The app row, in order: package, label. Only these can be launched from the page. */
    static final String[][] APPS = {
            {"com.netflix.ninja", "Netflix"},
            {"com.amazon.firetv.youtube", "YouTube"},
            {"com.amazon.firebat", "Prime Video"},
            {"com.hbo.hbonow", "HBO Max"},
            {"com.disney.disneyplus", "Disney+"},
            {"com.univision.prendetv", "ViX"},
            {"folder:news", "News"},
            {"com.spotify.tv.android", "Spotify"},
            {HomeService.AMAZON_HOME, "Fire TV"},
    };

    /**
     * Folders on the app row. Their apps are found by name among the installed apps, so the
     * exact package names don't need to be known: {shown label, text the app's own name contains}.
     */
    static final String[][] NEWS = {
            {"NBC News", "nbc news"},
            {"ABC News", "abc news"},
            {"CBS News", "cbs news"},
    };

    private final Activity activity;
    private final java.util.Set<String> folderPkgs = new java.util.HashSet<>();
    private String cached;

    TvBridge(Activity activity) { this.activity = activity; }

    /** JSON list of {pkg, label, icon} where icon is the app's own TV banner (or icon) as a data URL. */
    @JavascriptInterface
    public String apps() {
        // Rebuilt on every page load (once a day, or ☰ Menu) so newly installed folder apps show up.
        PackageManager pm = activity.getPackageManager();
        JSONArray out = new JSONArray();
        for (String[] a : APPS) {
            if (a[0].startsWith("folder:")) {
                try {
                    JSONArray items = folderItems(pm, NEWS);
                    if (items.length() == 0) continue; // nothing installed yet: no folder
                    JSONObject o = new JSONObject();
                    o.put("pkg", a[0]);
                    o.put("label", a[1]);
                    o.put("folder", true);
                    o.put("items", items);
                    out.put(o);
                } catch (Exception ignored) { }
                continue;
            }
            try {
                pm.getPackageInfo(a[0], 0); // skip apps that are not installed
                Drawable d = pm.getApplicationBanner(a[0]);
                boolean banner = d != null;
                if (d == null) d = pm.getApplicationIcon(a[0]);
                JSONObject o = new JSONObject();
                o.put("pkg", a[0]);
                o.put("label", a[1]);
                o.put("banner", banner);
                o.put("icon", dataUrl(d, banner ? 320 : 144, banner ? 180 : 144));
                out.put(o);
            } catch (Exception ignored) {
            }
        }
        cached = out.toString();
        return cached;
    }

    /** Installed TV apps whose name contains each folder entry's text, in the folder's order. */
    private JSONArray folderItems(PackageManager pm, String[][] wanted) throws Exception {
        Intent tv = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER);
        java.util.List<android.content.pm.ResolveInfo> found = pm.queryIntentActivities(tv, 0);
        JSONArray items = new JSONArray();
        for (String[] w : wanted) {
            for (android.content.pm.ResolveInfo ri : found) {
                String pkg = ri.activityInfo.packageName;
                String name = String.valueOf(ri.loadLabel(pm)).toLowerCase(java.util.Locale.US);
                if (!name.contains(w[1])) continue;
                Drawable d = pm.getApplicationBanner(pkg);
                boolean banner = d != null;
                if (d == null) d = pm.getApplicationIcon(pkg);
                JSONObject o = new JSONObject();
                o.put("pkg", pkg);
                o.put("label", w[0]);
                o.put("banner", banner);
                o.put("icon", dataUrl(d, banner ? 320 : 144, banner ? 180 : 144));
                items.put(o);
                folderPkgs.add(pkg);
                break;
            }
        }
        return items;
    }

    @JavascriptInterface
    public void launch(String pkg) {
        boolean allowed = folderPkgs.contains(pkg);
        for (String[] a : APPS) if (a[0].equals(pkg)) allowed = true;
        if (!allowed) return;
        activity.runOnUiThread(() -> {
            try {
                Intent i;
                if (HomeService.AMAZON_HOME.equals(pkg)) {
                    HomeService.allowAmazonHome();
                    i = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).setPackage(pkg);
                } else {
                    PackageManager pm = activity.getPackageManager();
                    i = pm.getLeanbackLaunchIntentForPackage(pkg);
                    if (i == null) i = pm.getLaunchIntentForPackage(pkg);
                }
                if (i != null) activity.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception ignored) {
            }
        });
    }

    /** Opens a system screen: "settings", "inputs" or "wifi". */
    @JavascriptInterface
    public void openSystem(String kind) {
        final String action;
        if ("settings".equals(kind)) action = "android.settings.SETTINGS";
        else if ("inputs".equals(kind)) action = "com.amazon.tv.inputpreference.action.LAUNCH_INPUTS"; // Fire TV Edition
        else if ("wifi".equals(kind)) action = "android.settings.WIFI_SETTINGS";
        else return;
        activity.runOnUiThread(() -> {
            try {
                activity.startActivity(new Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception e) {
                try { // fall back to the main settings screen
                    activity.startActivity(new Intent("android.settings.SETTINGS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (Exception ignored) { }
            }
        });
    }

    /** {connected, type: "wifi"|"ethernet"|"none", ssid, bars 0..4}. SSID needs the location permission. */
    @JavascriptInterface
    public String network() {
        JSONObject o = new JSONObject();
        try {
            ConnectivityManager cm = (ConnectivityManager) activity.getSystemService(Context.CONNECTIVITY_SERVICE);
            NetworkCapabilities nc = cm.getNetworkCapabilities(cm.getActiveNetwork());
            boolean connected = nc != null && nc.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            String type = nc == null ? "none" : nc.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ? "ethernet"
                    : nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ? "wifi" : "other";
            o.put("connected", connected);
            o.put("type", type);
            if ("wifi".equals(type)) {
                WifiManager wm = (WifiManager) activity.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                WifiInfo info = wm.getConnectionInfo();
                String ssid = info.getSSID();
                if (ssid != null && ssid.startsWith("\"") && ssid.endsWith("\"")) ssid = ssid.substring(1, ssid.length() - 1);
                o.put("ssid", ssid == null || ssid.contains("unknown ssid") ? "" : ssid);
                o.put("bars", WifiManager.calculateSignalLevel(info.getRssi(), 5));
            }
        } catch (Exception ignored) {
        }
        return o.toString();
    }

    static final String SPOTIFY = "com.spotify.tv.android";
    private String artKey, artUrl;

    /** Spotify's media session, or null when Spotify is not playing or paused (or access is not granted). */
    private MediaController spotify() {
        try {
            MediaSessionManager msm = (MediaSessionManager) activity.getSystemService(Context.MEDIA_SESSION_SERVICE);
            for (MediaController c : msm.getActiveSessions(new ComponentName(activity, MediaListener.class))) {
                if (!SPOTIFY.equals(c.getPackageName())) continue;
                PlaybackState st = c.getPlaybackState();
                if (st == null || c.getMetadata() == null) continue;
                int s = st.getState();
                if (s == PlaybackState.STATE_PLAYING || s == PlaybackState.STATE_PAUSED || s == PlaybackState.STATE_BUFFERING) return c;
            }
        } catch (SecurityException e) {
            return null; // notification access not granted yet
        } catch (Exception ignored) {
        }
        return null;
    }

    /** {active:false} or {active, playing, title, artist, album, art (data URL), position, duration} in ms. */
    @JavascriptInterface
    public String nowPlaying() {
        JSONObject o = new JSONObject();
        try {
            MediaController c = spotify();
            o.put("active", c != null);
            if (c == null) return o.toString();
            MediaMetadata m = c.getMetadata();
            PlaybackState st = c.getPlaybackState();
            boolean playing = st.getState() == PlaybackState.STATE_PLAYING;
            long pos = st.getPosition();
            if (playing && st.getLastPositionUpdateTime() > 0) {
                pos += (long) ((SystemClock.elapsedRealtime() - st.getLastPositionUpdateTime()) * st.getPlaybackSpeed());
            }
            String title = m.getString(MediaMetadata.METADATA_KEY_TITLE);
            String artist = m.getString(MediaMetadata.METADATA_KEY_ARTIST);
            o.put("playing", playing);
            o.put("title", title == null ? "" : title);
            o.put("artist", artist == null ? "" : artist);
            o.put("album", m.getString(MediaMetadata.METADATA_KEY_ALBUM));
            o.put("duration", m.getLong(MediaMetadata.METADATA_KEY_DURATION));
            o.put("position", Math.max(0, pos));
            String key = title + "|" + artist;
            if (!key.equals(artKey)) { // encode the cover once per track
                artKey = key;
                artUrl = null;
                Bitmap art = m.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART);
                if (art == null) art = m.getBitmap(MediaMetadata.METADATA_KEY_ART);
                if (art != null) {
                    Bitmap small = Bitmap.createScaledBitmap(art, 240, 240, true);
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    small.compress(Bitmap.CompressFormat.JPEG, 85, bytes);
                    artUrl = "data:image/jpeg;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
                }
            }
            if (artUrl != null) o.put("art", artUrl);
        } catch (Exception ignored) {
        }
        return o.toString();
    }

    /** Spotify transport: "toggle", "next" or "prev". */
    @JavascriptInterface
    public void media(String cmd) {
        MediaController c = spotify();
        if (c == null) return;
        MediaController.TransportControls t = c.getTransportControls();
        if ("next".equals(cmd)) t.skipToNext();
        else if ("prev".equals(cmd)) t.skipToPrevious();
        else if ("toggle".equals(cmd)) {
            if (c.getPlaybackState().getState() == PlaybackState.STATE_PLAYING) t.pause(); else t.play();
        }
    }

    private static String dataUrl(Drawable d, int w, int h) {
        Bitmap bmp;
        if (d instanceof BitmapDrawable && ((BitmapDrawable) d).getBitmap() != null) {
            bmp = Bitmap.createScaledBitmap(((BitmapDrawable) d).getBitmap(), w, h, true);
        } else {
            bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(bmp);
            d.setBounds(0, 0, w, h);
            d.draw(c);
        }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.PNG, 100, bytes);
        return "data:image/png;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
    }
}
