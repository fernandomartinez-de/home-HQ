# Shelly plugs

Controls Shelly plugs (the espresso machine) through the Shelly Cloud Control API.

```
home-dashboard ──> shelly function (Supabase) ──> Shelly Cloud ──> plug (WiFi)
```

* **Auth:** the account's cloud key and server, stored only as the Supabase function secrets
  `SHELLY_AUTH_KEY` and `SHELLY_SERVER`.
* **Read:** on or off, live power draw (watts) and total energy. **Control:** on and off.
* **Limits:** about one request a second, so the poll reads every device in one call (every 5 minutes).

## Setup

1. In the Shelly app: User settings, **Authorization cloud key**, Get key. Copy the key and the server address.
2. Add them as the Supabase function secrets `SHELLY_AUTH_KEY` and `SHELLY_SERVER`.
3. The scheduled poll adds each plug to `home_devices` as kind `switch`; set its room to Kitchen to put it in the Living & Kitchen tab.
