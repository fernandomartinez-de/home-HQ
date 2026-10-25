package app.tvdashboard;

import android.service.notification.NotificationListenerService;

/**
 * Does nothing by itself. Android only lets an app read what is playing (media sessions) when it
 * holds notification access, and this service is what that access is granted to (over ADB, see
 * docs/tv-setup.md). Notifications themselves are never read.
 */
public class MediaListener extends NotificationListenerService {
}
