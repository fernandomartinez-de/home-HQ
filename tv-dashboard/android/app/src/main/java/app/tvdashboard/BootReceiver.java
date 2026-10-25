package app.tvdashboard;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Opens the dashboard after the TV boots. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(i.getAction())) return;
        c.startActivity(new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }
}
