package app.tvdashboard;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
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
            {"com.spotify.tv.android", "Spotify"},
            {HomeService.AMAZON_HOME, "Fire TV"},
    };

    private final Activity activity;
    private String cached;

    TvBridge(Activity activity) { this.activity = activity; }

    /** JSON list of {pkg, label, icon} where icon is the app's own TV banner (or icon) as a data URL. */
    @JavascriptInterface
    public String apps() {
        if (cached != null) return cached;
        PackageManager pm = activity.getPackageManager();
        JSONArray out = new JSONArray();
        for (String[] a : APPS) {
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

    @JavascriptInterface
    public void launch(String pkg) {
        boolean allowed = false;
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
