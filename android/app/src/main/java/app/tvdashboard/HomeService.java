package app.tvdashboard;

import android.accessibilityservice.AccessibilityService;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.util.Log;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityEvent;

/**
 * Makes the dashboard act as the home screen on Fire OS, which does not allow a
 * third party launcher:
 *  - the Home button opens the dashboard,
 *  - if Amazon's home screen comes up on its own (an app exits to it), the dashboard opens instead,
 *  - when the TV wakes, the dashboard opens.
 * The "Fire TV" tile on the dashboard opens Amazon's home on purpose; pressing Home there
 * comes back to the dashboard. Fire OS hides this service from its menus; see docs/tv-setup.md
 * for turning it on and off over ADB. Apps cannot catch the Home key on Fire OS, so the
 * stock home appears briefly before the dashboard replaces it.
 */
public class HomeService extends AccessibilityService {
    static final String AMAZON_HOME = "com.amazon.tv.launcher";
    private static final String TAG = "TvDashHome";
    private static volatile boolean amazonHomeAllowed = false;

    private final BroadcastReceiver screenOn = new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent i) { openDashboard(); }
    };

    /** Called when the user picks the Fire TV tile: let Amazon's home stay up until they leave it. */
    static void allowAmazonHome() { amazonHomeAllowed = true; }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        registerReceiver(screenOn, new IntentFilter(Intent.ACTION_SCREEN_ON));
    }

    @Override
    public void onDestroy() {
        try { unregisterReceiver(screenOn); } catch (Exception ignored) { }
        super.onDestroy();
    }

    @Override
    protected boolean onKeyEvent(KeyEvent e) {
        if (e.getKeyCode() == KeyEvent.KEYCODE_HOME) {
            if (e.getAction() == KeyEvent.ACTION_UP) {
                amazonHomeAllowed = false;
                openDashboard();
            }
            return true; // swallow both down and up so Amazon's home does not open
        }
        return false;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent ev) {
        if (ev.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;
        CharSequence pkg = ev.getPackageName();
        if (pkg == null) return;
        String p = pkg.toString();
        CharSequence cls = ev.getClassName();
        boolean isHomeScreen = cls != null && cls.toString().contains("HomeActivity");
        if (AMAZON_HOME.equals(p) && isHomeScreen) {
            if (!amazonHomeAllowed) openDashboard();
        } else if (!AMAZON_HOME.equals(p) && !p.equals(getPackageName()) && !p.startsWith("com.android.systemui")) {
            amazonHomeAllowed = false; // they left Amazon's home for another app
        }
    }

    @Override
    public void onInterrupt() { }

    private void openDashboard() {
        Intent i = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        try { startActivity(i); } catch (Exception ex) { Log.w(TAG, "could not open the dashboard", ex); }
    }
}
