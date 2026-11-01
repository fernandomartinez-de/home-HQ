# Ring

Ring cameras on the home dashboard: latest snapshot, Ring modes (Disarmed, Home, Away), recent
motion and doorbell events, battery and online status.

Ring has no official API. The `ring` function uses the same calls as the open source
[ring-client-api](https://github.com/dgreif/ring) (used by Home Assistant and Homebridge), so a
change on Ring's side can break it until it's updated.

## Connect

Open the dashboard's **Camera** tab, enter your Ring email and password, then the code Ring sends.
The password goes to Ring once and is never stored. Ring's refresh token is kept in
`home_provider_sessions` and replaced on every use. To disconnect, use the button in Recent Events.

## How it works

* **Snapshots:** fetched from Ring when the dashboard shows the camera, every minute and on Snap.
  Wired cameras take a fresh one on Snap; battery cameras keep Ring's own cadence to save battery.
* **Live view:** opens Ring's web dashboard, which streams in the browser.
* **Poll:** every 5 minutes (pg_cron) for battery, online status, mode and recent events.
