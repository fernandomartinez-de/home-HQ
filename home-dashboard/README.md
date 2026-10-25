# Home Dashboard

The control center for the home: one screen to see and control the water heater, AC and lights,
with history and schedules. Works on iPad, phone, laptop and TV.

**[Architecture diagram](docs/architecture.html)** (source in [`docs/architecture.json`](docs/architecture.json))

## How it works

* **UI:** Next.js on Vercel. It never talks to an appliance directly; it calls the appliance
  functions in Supabase.
* **Appliance functions:** one Supabase Edge Function per appliance, living in that appliance's
  folder ([rheem/](../rheem/), [ac/](../ac/), [govee/](../govee/)). Each one reads state and runs
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
| `home_schedules` | Recurring actions: days, local time, command |
| `home_device_latest` (view) | Each device with its latest reading |

## Folders

```
app/                  Next.js app (to come)
supabase/migrations/  shared home_* schema
docs/                 architecture diagram
```

## Roadmap

- [x] Shared Supabase schema
- [x] Govee function (waiting on API key)
- [x] Rheem function (waiting on login secrets)
- [x] Polling every 5 minutes (pg_cron)
- [ ] Schedules runner
- [ ] Next.js app with live state and controls
- [ ] ESP32 bridge for the AC, then its function
- [ ] History and analytics views
- [ ] Home status tile on the TV dashboard

## Updating the diagram

Generated with [Archify](https://github.com/tt-a1i/archify). Edit `docs/architecture.json`, then
from the repo root:

```bash
node <archify>/bin/archify.mjs finalize architecture home-dashboard/docs/architecture.json home-dashboard/docs/architecture.html --quality showcase
```
