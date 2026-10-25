# Rheem water heater

Reads and controls the water heater through the Rheem EcoNet cloud, the same service the Rheem
app uses.

## How it connects

```
home-dashboard ──> rheem function (Supabase) ──> Rheem EcoNet API ──> water heater (EcoNet WiFi module)
```

* **API:** EcoNet has no official public API. This uses the endpoints the Rheem app uses, as
  documented by the open source `pyeconet` library (what Home Assistant's EcoNet integration is
  built on). It has been stable for years but could change without notice.
* **Auth:** your Rheem account email and password, stored only as Supabase function secrets
  (`RHEEM_EMAIL`, `RHEEM_PASSWORD`). Never in this repo.
* **Latency:** changes reach the heater in a few seconds; readings refresh on each poll.

## What it will do

| Read | Control |
|---|---|
| Set point, tank status, mode, running state, alerts, energy use (if the model reports it) | Set point, mode (energy saver, heat pump, high demand, electric, vacation), on and off |

## Folder

```
functions/rheem/   Supabase Edge Function: state, commands, poll (to come)
```

## Setup

1. Make sure the heater shows up and works in the Rheem EcoNet app.
2. Add `RHEEM_EMAIL` and `RHEEM_PASSWORD` as Supabase function secrets.
3. Deploy the function; the first poll adds the heater to `home_devices`.
