# LIFX lights

Controls LIFX lights (the living room wall washer) through the official LIFX HTTP API.

```
home-dashboard ──> lifx function (Supabase) ──> LIFX Cloud API ──> lights (WiFi)
```

* **Auth:** a personal access token, stored only as the Supabase function secret `LIFX_TOKEN`.
* **Read:** online, power, brightness, color, color temperature. The LIFX room fills in the
  dashboard room the first time; a room set by hand is kept.
* **Control:** power, brightness, color, color temperature, scenes saved in the LIFX app.

## Setup

1. Sign in at cloud.lifx.com, open Settings, **Generate New Token**.
2. Add it as the Supabase function secret `LIFX_TOKEN`.
3. The scheduled poll (every 5 minutes) adds each light to `home_devices`.

## API

All calls need the header `x-home-key`.

| Call | Does |
|---|---|
| `GET /lifx` | Live state of every light |
| `POST /lifx {"action":"poll"}` | Sync lights and store a reading |
| `POST /lifx {"action":"command","device_id":"lifx_<id>","command":{"action":"power","on":true}}` | power, brightness, color, color_temp, scene |
