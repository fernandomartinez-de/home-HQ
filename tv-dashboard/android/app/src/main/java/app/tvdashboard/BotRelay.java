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

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Stands in for a hub over Bluetooth, for devices Home HQ can't reach through a cloud:
 *
 *  - SwitchBot Bots with no SwitchBot Hub (the towel warmer before its hub). Scanning reads each
 *    Bot's advertisement (mode, on or off, battery); commands connect, write one of the Bot's three
 *    commands and disconnect. SwitchBot's open Bluetooth protocol, for Bots without a password.
 *  - Govee lights that only have Bluetooth (the bedframe strip). Scanning lists the Govee lights it
 *    hears with their names (which carry the model, like "ihoment_H6125_1A2B"); commands write the
 *    20 byte packets the server builds for that model.
 */
final class BotRelay {
    private static final String TAG = "TvDashBot";
    private static final ParcelUuid SERVICE_DATA_NEW = ParcelUuid.fromString("0000fd3d-0000-1000-8000-00805f9b34fb");
    private static final ParcelUuid SERVICE_DATA_OLD = ParcelUuid.fromString("00000d00-0000-1000-8000-00805f9b34fb");
    private static final UUID BOT_SERVICE = UUID.fromString("cba20d00-224d-11e6-9fb8-0002a5d5c51b");
    private static final UUID BOT_WRITE = UUID.fromString("cba20002-224d-11e6-9fb8-0002a5d5c51b");
    private static final UUID GOVEE_SERVICE = UUID.fromString("00010203-0405-0607-0809-0a0b0c0d1910");
    private static final UUID GOVEE_WRITE = UUID.fromString("00010203-0405-0607-0809-0a0b0c0d2b11");
    private static final int GOVEE_COMPANY = 0x88EC;
    private static final byte BOT = 0x48; // 'H'

    private final Context context;
    /** Devices seen by the last scans, by MAC. */
    private final Map<String, BluetoothDevice> devices = new ConcurrentHashMap<>();

    BotRelay(Context context) { this.context = context.getApplicationContext(); }

    private BluetoothAdapter adapter() {
        BluetoothManager m = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter a = m == null ? null : m.getAdapter();
        return a != null && a.isEnabled() ? a : null;
    }

    /**
     * Listens for a few seconds. Returns what it heard: Bots as {mac, mode, on, battery, rssi} and
     * Govee lights as {mac, govee: true, name, rssi}.
     */
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
                    JSONObject heard = parse(r);
                    if (heard != null) {
                        found.put(heard.getString("mac"), heard);
                        devices.put(heard.getString("mac"), r.getDevice());
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
        for (JSONObject heard : found.values()) out.put(heard);
        return out;
    }

    private static JSONObject parse(ScanResult r) throws Exception {
        ScanRecord rec = r.getScanRecord();
        if (rec == null) return null;
        String mac = r.getDevice().getAddress();
        byte[] d = rec.getServiceData(SERVICE_DATA_NEW);
        if (d == null) d = rec.getServiceData(SERVICE_DATA_OLD);
        if (d != null && d.length >= 3 && (d[0] & 0x7F) == BOT) {
            boolean switchMode = (d[1] & 0x80) != 0;
            return new JSONObject()
                    .put("mac", mac)
                    .put("mode", switchMode ? "switchMode" : "pressMode")
                    .put("on", (d[1] & 0x40) == 0) // the Bot sends 0 for on
                    .put("battery", d[2] & 0x7F)
                    .put("rssi", r.getRssi());
        }
        String name = rec.getDeviceName();
        boolean goveeName = name != null && name.matches("(?i)^(govee|ihoment|gbk|minger)_.*");
        if (goveeName || rec.getManufacturerSpecificData(GOVEE_COMPANY) != null) {
            return new JSONObject().put("mac", mac).put("govee", true)
                    .put("name", name == null ? JSONObject.NULL : name).put("rssi", r.getRssi());
        }
        return null;
    }

    /** Sends press, on or off to the Bot at mac. Returns null when it worked, or what went wrong. */
    String send(String mac, String op) {
        byte[] value = "press".equals(op) ? new byte[]{0x57, 0x01, 0x00}
                : "on".equals(op) ? new byte[]{0x57, 0x01, 0x01}
                : "off".equals(op) ? new byte[]{0x57, 0x01, 0x02} : null;
        if (value == null) return "unknown Bot command " + op;
        List<byte[]> packets = new ArrayList<>();
        packets.add(value);
        return withRetries(mac, BOT_SERVICE, BOT_WRITE, packets, "the Bot");
    }

    /** Writes the given packets (hex strings, built by the server for the model) to a Govee light. */
    String sendGovee(String mac, JSONArray hex) {
        List<byte[]> packets = new ArrayList<>();
        for (int i = 0; i < hex.length(); i++) {
            String h = hex.optString(i).replaceAll("[^0-9A-Fa-f]", "");
            if (h.length() != 40) return "each Govee packet must be 20 bytes";
            byte[] b = new byte[20];
            for (int j = 0; j < 20; j++) b[j] = (byte) Integer.parseInt(h.substring(j * 2, j * 2 + 2), 16);
            packets.add(b);
        }
        if (packets.isEmpty()) return "no Govee packets";
        return withRetries(mac, GOVEE_SERVICE, GOVEE_WRITE, packets, "the light");
    }

    private String withRetries(String mac, UUID service, UUID characteristic, List<byte[]> packets, String what) {
        if (mac == null || !BluetoothAdapter.checkBluetoothAddress(mac)) return what + "'s address is missing";
        if (adapter() == null) return "Bluetooth is off on the TV";
        String err = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0 || !devices.containsKey(mac)) scan(4000); // find it (or refresh a stale address)
            err = write(mac, service, characteristic, packets, what);
            if (err == null) return null;
            Log.w(TAG, what + " attempt " + (attempt + 1) + ": " + err);
        }
        return err;
    }

    /** Connects, writes each packet in turn (waiting for each to land), and disconnects. */
    private String write(String mac, UUID serviceId, UUID charId, List<byte[]> packets, String what) {
        BluetoothAdapter a = adapter();
        if (a == null) return "Bluetooth is off on the TV";
        BluetoothDevice dev = devices.get(mac);
        if (dev == null) dev = a.getRemoteDevice(mac);
        final String[] err = {what + " didn't answer (out of range, or connected to a phone?)"};
        final int[] next = {0};
        CountDownLatch done = new CountDownLatch(1);
        BluetoothGattCallback cb = new BluetoothGattCallback() {
            private BluetoothGattCharacteristic target;

            private void writeNext(BluetoothGatt g) {
                if (next[0] >= packets.size()) { err[0] = null; done.countDown(); return; }
                target.setValue(packets.get(next[0]++));
                if (!g.writeCharacteristic(target)) { err[0] = what + " refused the command"; done.countDown(); }
            }

            @Override
            public void onConnectionStateChange(BluetoothGatt g, int status, int state) {
                if (state == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                    if (!g.discoverServices()) { err[0] = "couldn't read " + what; done.countDown(); }
                } else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                    done.countDown();
                }
            }
            @Override
            public void onServicesDiscovered(BluetoothGatt g, int status) {
                BluetoothGattService s = g.getService(serviceId);
                target = s == null ? null : s.getCharacteristic(charId);
                if (target == null) { err[0] = what + " isn't the expected device"; done.countDown(); return; }
                boolean noResponse = (target.getProperties() & BluetoothGattCharacteristic.PROPERTY_WRITE) == 0;
                target.setWriteType(noResponse ? BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE : BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                writeNext(g);
            }
            @Override
            public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
                if (status != BluetoothGatt.GATT_SUCCESS) { err[0] = what + " refused the command (" + status + ")"; done.countDown(); return; }
                writeNext(g);
            }
        };
        BluetoothGatt gatt = null;
        try {
            gatt = Build.VERSION.SDK_INT >= 23
                    ? dev.connectGatt(context, false, cb, BluetoothDevice.TRANSPORT_LE)
                    : dev.connectGatt(context, false, cb);
            if (gatt == null) return "couldn't connect to " + what;
            if (!done.await(15, TimeUnit.SECONDS)) return what + " didn't answer in time (out of range?)";
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
