# Home HQ

Everything for running the home, in one repo: a control center app, the TV dashboard, and one
folder per appliance.

**[Architecture diagram](home-dashboard/docs/architecture.html)** (open the HTML file in a browser)

| Folder | What it is | Status |
|---|---|---|
| [home-dashboard/](home-dashboard/) | The control center app: Next.js UI plus the shared Supabase schema | In progress |
| [tv-dashboard/](tv-dashboard/) | Fire TV home screen: time, weather, portfolio, health, calendar, subway, apps | Live |
| [rheem/](rheem/) | Water heater through the Rheem EcoNet API | Planned |
| [ac/](ac/) | LG ducted AC through an ESP32 on the wall controller wiring | Planned |
| [govee/](govee/) | Lights through the official Govee API | Planned |

## How it fits together

There is no server at home. The control center runs on Vercel, each appliance has a Supabase
Edge Function that talks to its cloud API (or to the ESP32 for the AC), and Supabase scheduled
jobs handle polling and schedules so everything keeps running when no screen is open.

```
You ──> home-dashboard (Vercel) ──> appliance functions (Supabase) ──> Rheem EcoNet API ──> water heater
                                              │                    ──> Govee API ──────────> lights
                                              │                    <── ESP32 (polls) ──────> AC
                                              └──> Postgres: readings, commands, schedules
```

## Layout

```
home-dashboard/      Next.js app, shared Supabase migrations, architecture diagram
tv-dashboard/        Fire TV app, dashboard page, background videos, its Supabase functions, docs
rheem/               water heater edge function and notes
ac/                  ESPHome firmware config and the AC edge function
govee/               lights edge function and notes
.github/workflows/   publish the TV page to GitHub Pages and build the TV app
```

## Privacy

This repository holds no personal data: no keys, passwords, locations, names or calendar
entries. Personal settings live in private Supabase tables; secrets live in Supabase function
secrets and local `.env.local` files that are never committed.
