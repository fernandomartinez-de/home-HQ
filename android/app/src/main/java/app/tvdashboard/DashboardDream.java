package app.tvdashboard;

import android.service.dreams.DreamService;
import android.webkit.WebView;

/** Screensaver that shows the dashboard. Any button press wakes the TV as usual. */
public class DashboardDream extends DreamService {
    private WebView web;

    @Override
    public void onAttachedToWindow() {
        super.onAttachedToWindow();
        setInteractive(false);
        setFullscreen(true);
        setScreenBright(true);
        web = Dash.create(this);
        setContentView(web);
    }

    @Override
    public void onDetachedFromWindow() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDetachedFromWindow();
    }
}
