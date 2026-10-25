# Govee lights

Controls the lights through the official Govee developer API.

## How it connects

```
home-dashboard ──> govee function (Supabase) ──> Govee Cloud API ──> lights (WiFi)
```

* **API:** official and documented (Govee Developer API, `openapi.api.govee.com`).
* **Auth:** a free API key, stored only as the Supabase function secret `GOVEE_API_KEY`.
* **Limits:** about 10,000 requests a day per key, plenty for polling every few minutes plus
  manual control.
* **Latency:** a second or two per command.

## What it will do

| Read | Control |
|---|---|
| Device list, online status, power, brightness, color, color temperature | Power, brightness, color, color temperature, scenes |

## Folder

```
functions/govee/   Supabase Edge Function: device sync, live state, poll, commands (deployed)
```

## Setup

1. In the Govee Home app: Profile, Settings (gear), **Apply for API Key**. The key arrives by email.
2. Add it as the Supabase function secret `GOVEE_API_KEY`.
3. Deploy the function; its first sync adds every light to `home_devices`.

## API

All calls need the header `x-home-key`.

| Call | Does |
|---|---|
| `GET /functions/v1/govee` | Live state of every light, nothing stored |
| `POST {"action":"poll"}` | Sync lights into `home_devices` and store readings (runs every 5 minutes via pg_cron) |
| `POST {"action":"command","device_id":"govee_<id>","command":{"action":"power","on":true}}` | Power |
| `command: {"action":"brightness","value":60}` | Brightness in percent |
| `command: {"action":"color","hex":"#ff8800"}` | Color |
| `command: {"action":"color_temp","kelvin":3000}` | White temperature |
