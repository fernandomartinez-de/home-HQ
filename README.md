# Home HQ

Everything for running the home, in one repo.

| Project | What it is | Status |
|---|---|---|
| [TV Dashboard](tv-dashboard/) | A minimal Fire TV home screen: time, weather, portfolio, health, calendar, subway and a row of favorite apps | Live |
| [Home Control](home-control/) | Water heater, air conditioning and lighting through Home Assistant, a Next.js control UI and Supabase analytics ([architecture diagram](home-control/docs/home-architecture.html)) | In progress |

## Layout

```
tv-dashboard/        Fire TV app, dashboard page, background videos, Supabase functions, docs
home-control/        Home Assistant, ESPHome, event logger, Next.js control center, docs
.github/workflows/   publish the TV page to GitHub Pages and build the TV app
```

## Privacy

This repository holds no personal data: no keys, locations, names or calendar entries. Personal
settings live in private Supabase tables; secrets live in Supabase function secrets and local
`.env.local` files that are never committed.
