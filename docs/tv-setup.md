# TV setup and recovery

Everything here runs from a computer on the same network as the TV, with
[Android platform tools](https://developer.android.com/tools/releases/platform-tools) (ADB).

## One time on the TV

1. Settings → My Fire TV → About → select the TV name 7 times (developer mode).
2. Settings → My Fire TV → Developer Options → **ADB debugging: On**.
3. Note the TV's IP address (Settings → My Fire TV → About → Network).

## Install or update the app

```powershell
$tv  = "<tv-ip>:5555"
$app = "app.tvdashboard"
adb connect $tv                                    # accept "Allow USB debugging?" on the TV the first time
# the latest build is published at https://<user>.github.io/<repo>/app.apk
adb -s $tv install -r app.apk
adb -s $tv shell am start -n "$app/.MainActivity" --es key <TV key>   # first install only: stores the TV key
```

The TV key is any random value whose SHA-256 is in `tv_config.tv_key_sha256` ([data.md](data.md)).
Updates with `install -r` keep the key.

## Make it the home screen

Fire OS hides third party accessibility services from its settings menu, so enable the
**Dashboard as home** service over ADB:

```powershell
adb -s $tv shell settings put secure enabled_accessibility_services "$app/.HomeService"
adb -s $tv shell settings put secure accessibility_enabled 1
```

After that, Home and waking the TV open the dashboard, and it opens after a restart. Pressing
Home shows the stock home for a moment before the dashboard replaces it; Fire OS does not allow
anything faster. The **Fire TV** tile on the app row opens the stock home on purpose (for
settings and other apps); press Home there to come back.

Optional, show what Spotify is playing on the dashboard (album art, song, progress; ⏪/⏩ skip
tracks while it shows). Reading media sessions needs notification access for the app:

```powershell
adb -s $tv shell cmd notification allow_listener "$app/.MediaListener"
```

Optional, use the dashboard as the screensaver too:

```powershell
adb -s $tv shell settings put secure screensaver_components "$app/.DashboardDream"
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Home goes to the stock home and stays there | The service got turned off (Fire OS update, reinstall). Rerun the two `enabled_accessibility_services` commands above. Check with `adb shell settings get secure enabled_accessibility_services`. |
| Old version of the page after an update | Press ☰ Menu. If it persists: `adb shell pm clear $app`, then the `am start ... --es key` line again (clearing also clears the key). |
| Data sections missing, "Offline, retrying" | Check the function: `curl -H "x-tv-key: <TV key>" https://<project-ref>.supabase.co/functions/v1/tv-dashboard`. A `401` means the key and `tv_config.tv_key_sha256` don't match. |
| Subway shows "No service here right now" | Usually weekend or overnight track work. The MTA feed has no trips for that stop. |
| No background video | `https://<user>.github.io/<repo>/videos/manifest.json` should list the clips; check the last "Dashboard page" workflow run. |
| `adb connect` refused | ADB debugging got switched off on the TV, or its IP changed. |

## Undo everything

```powershell
adb -s $tv shell settings put secure enabled_accessibility_services '""'
adb -s $tv shell cmd notification disallow_listener "$app/.MediaListener"
adb -s $tv shell settings put secure screensaver_components com.amazon.ftv.screensaver/.app.services.ScreensaverService
adb -s $tv uninstall $app
```
