# Architecture

Four pieces: a TV app, a static page on GitHub Pages, two Supabase edge functions with a
Postgres database, and an optional Power Automate flow for a work calendar.

## Components

```mermaid
flowchart TB
    subgraph TV["Fire TV"]
        direction TB
        MA["MainActivity<br/>full screen WebView"]
        BR["TvBridge<br/>window.TV: apps, launch,<br/>system screens, network, now playing"]
        HS["HomeService<br/>accessibility: Home and wake redirect"]
        ML["MediaListener<br/>notification access for Spotify now playing"]
        ML -. media sessions .-> BR
        DR["DashboardDream<br/>screensaver"]
        BT["BootReceiver<br/>open on boot"]
        MA --- BR
        HS -. opens .-> MA
        BT -. opens .-> MA
    end

    subgraph WEB["GitHub Pages"]
        IDX["index.html<br/>layout, data rendering, remote handling"]
        BG["bg.js<br/>background video player"]
        VID["videos/*.mp4 + manifest.json"]
        APK["app.apk"]
    end

    subgraph SUPA["Supabase"]
        TVF["tv-dashboard<br/>edge function"]
        INF["work-calendar-ingest<br/>edge function"]
        CFG[("tv_config")]
        HEALTH[("whoop_recovery · whoop_sleep<br/>whoop_cycles · whoop_workouts<br/>training_plan · body_composition<br/>nutrition_log")]
        FIN[("stocks_crypto_history")]
        WCAL[("work_calendar_events")]
        MET[("tv_metrics")]
        MI["tv-metrics-ingest<br/>edge function"]
    end

    subgraph OUT["Public services"]
        OM["Open-Meteo<br/>weather"]
        YF["Yahoo Finance<br/>quotes"]
        MTA["MTA GTFS realtime<br/>subway"]
        GCAL["Google Calendar<br/>secret iCal link"]
    end

    PAF["Power Automate flow<br/>work Outlook calendar"]
    GAS["Apps Script in Gmail<br/>unread count"]

    MA --> IDX
    IDX --> BG --> VID
    IDX --> OM
    IDX -- "x-tv-key" --> TVF
    TVF --> CFG & HEALTH & FIN & WCAL & MET
    TVF --> YF & MTA & GCAL
    PAF -- "x-ingest-key" --> INF --> WCAL
    INF --> CFG
    GAS -- "x-metrics-key" --> MI --> MET
```

| Piece | Where | Role |
|---|---|---|
| TV app | `android/` | Wraps the page in a full screen WebView, passes remote buttons to it, exposes the app row, system screens and network status (`window.TV`), redirects Home and wake to the dashboard, doubles as screensaver |
| Page | `web/index.html` | Draws everything; calls the data function every 5 minutes and Open-Meteo every 20 |
| Background | `web/bg.js` + `videos/` | Plays one clip on a loop; ⏪/⏩ switch clips; remembers the last one |
| Data function | `supabase/functions/tv-dashboard` | One authenticated endpoint that returns all personal data plus settings |
| Calendar receiver | `supabase/functions/work-calendar-ingest` | Accepts the work calendar from Power Automate and replaces the stored copy |

## A refresh, step by step

```mermaid
sequenceDiagram
    autonumber
    participant TV as TV app (WebView)
    participant P as GitHub Pages
    participant F as tv-dashboard function
    participant D as Postgres
    participant X as Public APIs

    TV->>P: GET index.html (key passed in the URL fragment, never sent)
    P-->>TV: page, bg.js?v=<commit>, videos/manifest.json
    TV->>F: GET with header x-tv-key
    F->>D: read tv_config
    F->>F: compare SHA-256 of key with tv_config.tv_key_sha256
    par in parallel
        F->>D: health, finance, work calendar tables
        F->>X: Yahoo quotes, MTA feeds, Google Calendar iCal
    end
    F-->>TV: whoop, portfolio, fitness, trains, calendar, settings
    TV->>X: Open-Meteo forecast for settings.location
```

## Home button on Fire OS

Fire OS does not allow a third party launcher, and apps cannot intercept the Home key.
The app's accessibility service watches for the stock home screen and replaces it:

```mermaid
sequenceDiagram
    participant U as Remote
    participant OS as Fire OS
    participant A as Amazon home
    participant H as HomeService
    participant M as Dashboard

    U->>OS: Home
    OS->>A: open stock home
    A-->>H: window state changed (com.amazon.tv.launcher)
    H->>M: start dashboard (brief flash of the stock home)
    Note over H: The "Fire TV" tile sets a bypass so the stock home<br/>stays open until another app comes to the front.
    OS-->>H: screen on (wake)
    H->>M: start dashboard
```

## Publishing

```mermaid
flowchart LR
    PUSH["push to main"] --> Q{"what changed?"}
    Q -- "web/ or videos/" --> PG["pages.yml<br/>copy page, stamp bg.js version,<br/>ffmpeg videos, write manifest"]
    Q -- "android/" --> AP["app.yml<br/>gradle assembleRelease,<br/>GitHub release 'latest'"]
    AP --> PG
    PG --> GP["GitHub Pages<br/>(also serves /app.apk)"]
    AP -. "install over ADB" .-> TVX["Fire TV"]
    SF["supabase/functions/*"] -. "deployed separately" .-> SUP["Supabase"]
```

* Page changes reach the TV on its daily reload, or right away with ☰ Menu. The version stamp on `bg.js` avoids stale cached copies.
* App changes need a reinstall over ADB ([tv-setup.md](tv-setup.md)).
* Edge functions are deployed to Supabase directly (dashboard, CLI or MCP); the files here are the source of truth.

## Security model

* **No personal data in this repo.** Location, time zone, trips, subway stop and key hashes live in the private `tv_config` table. The Google Calendar link is the `GCAL_ICS_URL` function secret.
* **Separate keys, stored only as SHA-256 hashes.** The TV key is held by the TV app (set once over ADB) and sent as `x-tv-key`. The ingest key lives in the Power Automate flow and is sent as `x-ingest-key`. The metrics key lives in the Gmail Apps Script and is sent as `x-metrics-key`. Either can be rotated by updating its hash in `tv_config`.
* **Tables have row level security on with no policies**, so only the edge functions (service role) can read them.
* **Work calendar minimization:** the flow sends titles and times only; attendees, locations and bodies never leave Outlook.
* **Gmail minimization:** the script sends one number, the inbox unread count. No mail content and no Gmail password leave Google.
* **The app row can only launch apps on its allowlist** (`TvBridge.APPS`), and the top buttons only open Settings, Inputs and Network.
