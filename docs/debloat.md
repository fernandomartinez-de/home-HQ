# Debloat (Fire OS 7, Toshiba Fire TV)

The TV was cleaned up with the [cleanyourtv](https://github.com/Gathin23/cleanyourtv) approach:
packages are **disabled, not uninstalled**, over ADB, so everything can be restored.

## Disabled

| Group | Packages |
|---|---|
| Ads, shopping, content recognition | `com.amazon.shoptv.client`, `com.amazon.shoptv.firetv.client`, `com.amazon.tv.acr`, `com.amazon.tv.democontent.provider` |
| Telemetry and metrics | `com.amazon.tv.fw.metrics`, `com.amazon.neo.minerva`, `com.amazon.neo.minerva.logcat`, `com.amazon.wirelessmetrics.service`, `com.amazon.perfcollection`, `com.amazon.perfc`, `com.amazon.dp.logger` |
| Tutorials and promos | `com.amazon.storm.lightning.tutorial`, `com.amazon.tmm.tutorial`, `com.amazon.gamehub` |
| Amazon extras (owner's choice) | `com.amazon.bueller.music`, `com.amazon.bueller.photos`, `com.amazon.minitv.android.app`, `com.amazon.naatyam` |
| Unused apps (owner's choice) | `com.tubitv.ott`, `com.espn.gtv`, `com.bamnetworks.mobile.android.gameday.atbat`, `com.redbull.rbtv`, `com.zumobi.msnbc`, `com.att.tv`, `com.univision.prendetv`, `com.apple.atve.amazon.appletv` |

Kept: Alexa, OTA updates, casting and screen mirroring, Netflix, YouTube, Prime Video, HBO Max,
Disney+, Hulu, Spotify, Plex, and the stock home screen (Fire OS protects it).

```powershell
# disable one
adb shell pm disable-user --user 0 <package>
# undo
adb shell pm enable <package>
```

## Ad blocking

Private DNS set to AdGuard's public resolver, which blocks ad and tracking domains for the
whole TV:

```powershell
adb shell settings put global private_dns_specifier dns.adguard-dns.com
adb shell settings put global private_dns_mode hostname
# undo
adb shell settings put global private_dns_mode off
```
