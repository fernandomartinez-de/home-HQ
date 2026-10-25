# Home Dashboard app

Next.js control panel for the water heater and lights (AC to come). The browser never talks to
Supabase: the app's server routes hold the API key and call the appliance functions.

## Run locally with sample data

```bash
npm install
HOME_MOCK=1 npm run dev
```

With no passcode set, the app is open; set `DASHBOARD_PASSCODE` to test the sign in page.

## Deploy on Vercel

1. In Vercel, **Add New Project**, import `home-HQ`, and set **Root Directory** to `home-dashboard/app`.
2. Add these environment variables:

| Name | Value |
|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `HOME_API_KEY` | from Supabase SQL editor: `select decrypted_secret from vault.decrypted_secrets where name = 'home_api_key';` |
| `DASHBOARD_PASSCODE` | the passcode you'll type to sign in |
| `SESSION_SECRET` | any long random string (signs the sign in cookie) |

3. Deploy. Open the URL on the iPad, sign in once (it remembers the device for 90 days), and use
   Share, **Add to Home Screen** to get a full screen app icon.

## How it works

| Route | Does |
|---|---|
| `/` | The dashboard; redirects to `/login` when signed out |
| `GET /api/home` | Devices with latest state and 24 hours of history (Supabase `home` function) |
| `POST /api/refresh` | Polls every appliance now (`home` function, action refresh) |
| `POST /api/command` | Sends one command to `rheem`, `govee` or `ac` |

The page refreshes every 30 seconds and right after each command, so it shows the appliance's
real state a few seconds after you tap.
