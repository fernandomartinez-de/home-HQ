# Home Dashboard

The control center for the home: one screen to see and control the water heater, AC and lights,
with history and schedules. Works on iPad, phone, laptop and TV.

**[Architecture diagram](docs/architecture.html)** (source in [`docs/architecture.json`](docs/architecture.json))

## How it works

* **UI:** Next.js on Vercel. It never talks to an appliance directly; it calls the appliance
  functions in Supabase.
* **Appliance functions:** one Supabase Edge Function per appliance, living in that appliance's
  folder ([rheem/](../rheem/), [ac/](../ac/), [govee/](../govee/), [lifx/](../lifx/), [switchbot/](../switchbot/)). Each one reads state and runs
  commands, and holds that appliance's credentials as function secrets.
* **Always on:** Supabase scheduled jobs (pg_cron) poll every appliance every few minutes for
  history and run schedules. No server at home.
* **AC:** the ESP32 checks Supabase for pending commands and pushes its state, so it never needs
  a port open on your router.

## Data

Shared schema in [`supabase/migrations/`](supabase/migrations/). All tables have RLS on with no
public policies; only the edge functions (service role) read and write them.

| Table | Holds |
|---|---|
| `home_devices` | Each appliance: kind, provider, name, provider device ids, capabilities |
| `home_readings` | State history: one JSON snapshot per poll or ESP32 push |
| `home_commands` | Command queue and audit log (pending, sent, done, failed) |
| `home_schedules` | Weekly time blocks: day, start, stop, command (mode and temperature for the heater); off outside blocks |
| `home_device_latest` (view) | Each device with its latest reading |

## Folders

```
app/                  Next.js app (see app/README.md to deploy)
supabase/functions/   home: one read endpoint for the app
supabase/migrations/  shared home_* schema
docs/                 architecture diagram
```

## Roadmap

Done
- [x] Shared Supabase schema
- [x] Govee function, connected (7 lights)
- [x] Rheem function, connected
- [x] Polling every 5 minutes (pg_cron)
- [x] Schedules: weekly time blocks with start and stop, edited in the app, run every minute by Supabase
- [x] Next.js app with live state and controls
- [x] Deploy to Vercel
- [x] Command center design: sections per room, alerts, scenes, Tailwind (2026-10-31)
- [x] Fire TV remote control through the TV app (2026-10-31)
- [x] Ring camera: sign in from the dashboard, snapshots, live view, events (2026-11-01)
- [x] Light buttons with power and dim slider; kitchen ceiling as one circuit (2026-11-01)
- [x] Con Edison connected: bill so far, projected and unposted bill estimates in Power & Energy (2026-11-01)
- [x] Overview layout: Climate and Water Heater (with 24 h tank chart) left, Security (camera and lock) and TV middle; Camera tab became Security (2026-11-01)
- [x] History tab: a year of Con Edison daily usage and bills, room lit hours, hot water heating, TV, camera and activity (2026-11-01)
- [x] Power & Energy: compact overview tile that opens a full report (cycle, 12 months, by hour, day of week, bills, always on load, insights) (2026-11-01)
- [x] Water tab redesign: animated glass tank, setpoint dial, mode buttons, schedule timeline with now line, tank chart with heating bands (2026-11-01)
- [x] Water tab tank insights (6/12/24 h, low point, cycles, schedule and heating lanes); violet theme to match the logo; animations throughout (2026-11-01)
- [x] Balcony lights: Govee outdoor smart plug through the Govee function, as a tile in the Lighting Console (2026-11-02)
- [x] LIFX (Coffee Station lamp, kitchen) and SwitchBot functions; Water tab became Bathroom with an Appliances & Tech box: towel warmer with power and its own weekly schedule, pressed over Bluetooth by the TV app since there is no hub (2026-11-02)

- [x] Living and Kitchen tabs merged into one Living & Kitchen tab (shared AC, both rooms' lights, TV, camera and the espresso machine) (2026-11-02)

Outstanding
- [ ] AC: ESP32 bridges for both LG zones, then the ac function and live AC controls (waiting on parts)
- [ ] Espresso machine plug: Shelly Plug US Gen4 for on/off, a morning warm up schedule and power use (waiting on purchase)
- [ ] Towel warmer: install TV app build 18 so the TV can reach the Bot
- [ ] Bedframe LED (arrives 2026-11-03): preview tile on the Bedroom tab until it's connected
- [ ] Espresso machine plug (arrives 2026-11-03): preview row in Living & Kitchen until it's connected
- [ ] Braava jet m6 mop: credentials script ready (get-braava.ps1), relay through the TV app (paused)
- [ ] Front door smart lock in the Security box (waiting on purchase)
- [ ] Power by appliance (meter total, Rheem energy, AC runtime, lights, espresso plug)

## Updating the diagram

Generated with [Archify](https://github.com/tt-a1i/archify). Edit `docs/architecture.json`, then
from the repo root:

```bash
node <archify>/bin/archify.mjs finalize architecture home-dashboard/docs/architecture.json home-dashboard/docs/architecture.html --quality showcase
```
