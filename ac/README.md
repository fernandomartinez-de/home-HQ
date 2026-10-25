# LG ducted AC

The AC has no app or API, so an ESP32 on the wall controller wiring gives it one. The ESP32 runs
ESPHome, joins your WiFi, and talks to Supabase on its own.

## How it connects

```
home-dashboard ──> ac function (Supabase) <── ESP32 + ESPHome (polls for commands, pushes state) ──> AC wall controller bus
```

* **Hardware:** an ESP32 board wired to the LG wall controller's signal line (about $10 to $25 in
  parts). The exact board and wiring depend on the controller model; see Setup.
* **No open ports:** the ESP32 makes outgoing requests only. It checks the `ac` function for
  pending commands every few seconds and pushes its state after every change.
* **Auth:** the ESP32 sends a device key; only its hash is stored in Supabase. The key lives in
  the ESPHome `secrets.yaml`, which is never committed.
* **Fallback:** the wall controller keeps working normally, with or without the ESP32.

## What it will do

| Read | Control |
|---|---|
| Power, mode, set point, room temperature, fan speed | Power, mode (cool, heat, fan, dry, auto), set point, fan speed |

## Folder

```
esphome/        ESPHome config for the bridge (secrets.yaml is git ignored)
functions/ac/   Supabase Edge Function: command queue for the ESP32, state ingest (to come)
```

## Setup

1. Photograph the wall controller (front, back and the model label) so the right protocol and
   wiring can be picked.
2. Buy the ESP32 parts for that controller.
3. Flash the ESPHome config, wire it in, and confirm it reports the room temperature.
4. Deploy the function and add the device key.
