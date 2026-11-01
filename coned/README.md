# Con Edison

Whole home electricity on the dashboard: bill so far, projected bill (and how it compares with last
year), today's and yesterday's usage, the latest smart meter reading in kW, and the last bill. It
shows in the **Power & Energy** box on the overview, under the appliance chart.

Con Edison has no public API. The `coned` function signs in the same way as the open source
[opower](https://github.com/tronikos/opower) library (used by Home Assistant) and reads the Opower
service behind coned.com's Energy Use pages, so a change on Con Edison's side can break it until
it's updated.

## Connect

1. In your Con Edison account, set two step verification to an **authenticator app**. Keep the setup
   key shown under the QR code (scan the QR code into your own authenticator app too).
2. On the dashboard, tap **Connect** in Power & Energy and enter your email, password and that key.
   The otpauth:// link from the QR code also works.

Con Edison has no refresh token, so the scheduled poll has to sign in again each time. The email,
password and key are kept in **Supabase Vault** (encrypted), readable only by the service role
through `home_secret_get`. `home_provider_sessions` keeps the device cookie, which lets Con Edison
skip 2FA on a device it knows, and the current Opower token. **Disconnect** in the box removes all of it.

## How it works

* **Poll:** every 2 hours (pg_cron, `home-poll-coned`), in the background because a sign in can take
  longer than pg_net's 30 second timeout.
* **Stored:** the latest summary as a reading of device `coned_electric` (kind `meter`), and daily
  kWh and cost in `home_energy_daily` for history views.
* **Data:** daily usage for 40 days, hourly for 3 days, bills, the current bill forecast, and the
  smart meter's 15 minute reads for the last day. Con Edison often withholds cost below bill level;
  then only usage is kept for those days.
