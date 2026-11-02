# SwitchBot

Controls SwitchBot devices that switch something on and off (the Bot on the towel warmer, plugs,
relay switches) through the official SwitchBot API v1.1.

```
home-dashboard ──> switchbot function (Supabase) ──> SwitchBot Cloud ──> Hub ──> Bot (Bluetooth)
```

* **Auth:** token and secret, stored only as the Supabase function secrets `SWITCHBOT_TOKEN` and
  `SWITCHBOT_SECRET`. Each request is signed with HMAC SHA256.
* **Hub:** Bluetooth devices like the Bot need a SwitchBot Hub with Cloud Services on.
* **Press mode:** a Bot in press mode only taps a button, so SwitchBot can't tell whether the
  appliance is on. The dashboard remembers what it last asked for and only taps when that changes.
  Switch mode (with the add on) reports real on and off.
* **Limits:** 10,000 calls a day; polling every 5 minutes uses a few hundred.

## No hub: the TV stands in

A Bot without a hub never shows up in the SwitchBot cloud. The Fire TV app (BotRelay in
`tv-dashboard/android`) does the hub's job over Bluetooth instead:

* Every 5 minutes it listens for Bots and reports each one's mode, on or off, and battery. A new
  Bot appears in `home_devices` as "SwitchBot Bot" (provider_ref `{mac, via: "tv"}`); rename it there.
* The dashboard's commands for that Bot are queued for the TV, which connects, presses, and reports
  back. This keeps working with the TV asleep.
* Range is Bluetooth range, about 10 m with few walls. Bots with a password aren't supported.

## Setup

1. SwitchBot app: Profile, Preferences, About, tap **App Version** 10 times, open
   **Developer Options**, copy the token and secret.
2. Add them as the Supabase function secrets `SWITCHBOT_TOKEN` and `SWITCHBOT_SECRET`.
3. The scheduled poll (every 5 minutes) adds each device to `home_devices` as kind `switch`.

## API

All calls need the header `x-home-key`.

| Call | Does |
|---|---|
| `GET /switchbot` | Live state of every supported device |
| `POST /switchbot {"action":"poll"}` | Sync devices and store a reading |
| `POST /switchbot {"action":"command","device_id":"switchbot_<id>","command":{"action":"power","on":true}}` | power, or press (Bot) |
