package app.tvdashboard;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.os.Build;
import android.os.ParcelUuid;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Stands in for a SwitchBot Hub: finds SwitchBot Bots over Bluetooth and presses them, so a Bot
 * with no hub (like the one on the towel warmer) still works from the home dashboard.
 *
 * Scanning reads each Bot's advertisement (mode, on or off, battery). Commands connect, write
 * one of the Bot's three commands, and disconnect. This uses SwitchBot's open Bluetooth protocol
 * (OpenWonderLabs/SwitchBotAPI-BLE) and works for Bots without a password.
 */
final class BotRelay {
    private static final String TAG = "TvDashBot";
    private static final ParcelUuid SERVICE_DATA_NEW = ParcelUuid.fromString("0000fd3d-0000-1000-8000-00805f9b34fb");
    private static final ParcelUuid SERVICE_DATA_OLD = ParcelUuid.fromString("00000d00-0000-1000-8000-00805f9b34fb");
    private static final UUID SERVICE = UUID.fromString("cba20d00-224d-11e6-9fb8-0002a5d5c51b");
    private static final UUID WRITE = UUID.fromString("cba20002-224d-11e6-9fb8-0002a5d5c51b");
    private static final byte BOT = 0x48; // 'H'

    private final Context context;
    /** Bots seen by the last scans, by MAC: the device and its last advertisement. */
    private final Map<String, BluetoothDevice> devices = new ConcurrentHashMap<>();
    private final Map<String, JSONObject> seen = new ConcurrentHashMap<>();

    BotRelay(Context context) { this.context = context.getApplicationContext(); }

    private BluetoothAdapter adapter() {
        BluetoothManager m = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter a = m == null ? null : m.getAdapter();
        return a != null && a.isEnabled() ? a : null;
    }

    /** Listens for Bots for a few seconds; returns what it heard: [{mac, mode, on, battery, rssi}]. */
    JSONArray scan(long ms) {
        JSONArray out = new JSONArray();
        BluetoothAdapter a = adapter();
        BluetoothLeScanner scanner = a == null ? null : a.getBluetoothLeScanner();
        if (scanner == null) return out;
        Map<String, JSONObject> found = new ConcurrentHashMap<>();
        ScanCallback cb = new ScanCallback() {
            @Override
            public void onScanResult(int type, ScanResult r) {
                try {
                    JSONObject bot = parse(r);
                    if (bot != null) {
                        found.put(bot.getString("mac"), bot);
                        devices.put(bot.getString("mac"), r.getDevice());
                    }
                } catch (Exception ignored) { }
            }
            @Override
            public void onScanFailed(int code) { Log.w(TAG, "scan failed: " + code); }
        };
        try {
            scanner.startScan(null, new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), cb);
            Thread.sleep(ms);
        } catch (SecurityException e) {
            Log.w(TAG, "no Bluetooth permission: " + e.getMessage());
            return out;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            try { scanner.stopScan(cb); } catch (Exception ignored) { }
        }
        seen.putAll(found);
        for (JSONObject bot : found.values()) out.put(bot);
        return out;
    }

    private static JSONObject parse(ScanResult r) throws Exception {
        ScanRecord rec = r.getScanRecord();
        if (rec == null) return null;
        byte[] d = rec.getServiceData(SERVICE_DATA_NEW);
        if (d == null) d = rec.getServiceData(SERVICE_DATA_OLD);
        if (d == null || d.length < 3 || (d[0] & 0x7F) != BOT) return null;
        boolean switchMode = (d[1] & 0x80) != 0;
        return new JSONObject()
                .put("mac", r.getDevice().getAddress())
                .put("mode", switchMode ? "switchMode" : "pressMode")
                .put("on", (d[1] & 0x40) == 0) // the Bot sends 0 for on
                .put("battery", d[2] & 0x7F)
                .put("rssi", r.getRssi());
    }

    /** Sends press, on or off to the Bot at mac. Returns null when it worked, or what went wrong. */
    String send(String mac, String op) {
        byte[] value = "press".equals(op) ? new byte[]{0x57, 0x01, 0x00}
                : "on".equals(op) ? new byte[]{0x57, 0x01, 0x01}
                : "off".equals(op) ? new byte[]{0x57, 0x01, 0x02} : null;
        if (value == null) return "unknown Bot command " + op;
        if (mac == null || !BluetoothAdapter.checkBluetoothAddress(mac)) return "the Bot's address is missing";
        if (adapter() == null) return "Bluetooth is off on the TV";
        String err = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0 || !devices.containsKey(mac)) scan(4000); // find it (or refresh a stale address)
            err = write(mac, value);
            if (err == null) return null;
            Log.w(TAG, "Bot " + op + " attempt " + (attempt + 1) + ": " + err);
        }
        return err;
    }

    private String write(String mac, byte[] value) {
        BluetoothAdapter a = adapter();
        if (a == null) return "Bluetooth is off on the TV";
        BluetoothDevice dev = devices.get(mac);
        if (dev == null) dev = a.getRemoteDevice(mac);
        final String[] err = {"the Bot didn't answer (out of range?)"};
        CountDownLatch done = new CountDownLatch(1);
        BluetoothGattCallback cb = new BluetoothGattCallback() {
            @Override
            public void onConnectionStateChange(BluetoothGatt g, int status, int state) {
                if (state == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                    if (!g.discoverServices()) { err[0] = "couldn't read the Bot"; done.countDown(); }
                } else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                    done.countDown();
                }
            }
            @Override
            public void onServicesDiscovered(BluetoothGatt g, int status) {
                BluetoothGattService s = g.getService(SERVICE);
                BluetoothGattCharacteristic c = s == null ? null : s.getCharacteristic(WRITE);
                if (c == null) { err[0] = "that isn't a SwitchBot Bot"; done.countDown(); return; }
                c.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                c.setValue(value);
                if (!g.writeCharacteristic(c)) { err[0] = "the Bot refused the command"; done.countDown(); }
            }
            @Override
            public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
                err[0] = status == BluetoothGatt.GATT_SUCCESS ? null : "the Bot refused the command (" + status + ")";
                done.countDown();
            }
        };
        BluetoothGatt gatt = null;
        try {
            gatt = Build.VERSION.SDK_INT >= 23
                    ? dev.connectGatt(context, false, cb, BluetoothDevice.TRANSPORT_LE)
                    : dev.connectGatt(context, false, cb);
            if (gatt == null) return "couldn't connect to the Bot";
            if (!done.await(12, TimeUnit.SECONDS)) return "the Bot didn't answer in time (out of range?)";
            return err[0];
        } catch (SecurityException e) {
            return "the TV app needs Bluetooth permission";
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "interrupted";
        } finally {
            if (gatt != null) {
                try { gatt.disconnect(); } catch (Exception ignored) { }
                try { gatt.close(); } catch (Exception ignored) { }
            }
        }
    }
}
