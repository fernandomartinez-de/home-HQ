# LG ducted AC

Two LG Multi F ducted zones, each with a PREMTB100 wall controller. Neither has WiFi, so each
gets an ESP32 bridge on the controller's 3 wire bus. The bridge talks to Supabase on its own.

| Zone | Indoor unit | Controller | Bridge (ESPHome) |
|---|---|---|---|
| Bedroom | LMDN097HV4 (9k BTU ducted) | PREMTB100 | `esphome/bedroom.yaml` |
| Kitchen / living room | LMDN097HV4 (identical to bedroom) | PREMTB100 | `esphome/living-room.yaml` |

Outdoor unit: LMU183HV (Multi F).

## How it connects

```
home-dashboard ──> ac function (Supabase) <── ESP32 bridge (polls for commands, pushes state) ──> PREMTB100 bus ──> indoor unit
```

* **Protocol:** the bridge uses the `lg_controller` component from
  [esphome-lg-controller](https://github.com/JanM321/esphome-lg-controller) (0BSD), built for the
  PREMTB100's 13 byte protocol. Copied into `esphome/components/`.
* **Master and slave:** the bridge is the master controller. Set each PREMTB100 to **slave** in its
  installer menu; it keeps working normally and changes sync both ways.
* **Room temperature:** read from the indoor unit's own thermistor.
* **No open ports:** the bridge polls the `ac` function every 5 seconds and pushes state on change
  and every 60 seconds, authenticated with a per device key (only its hash is stored).
* **Build:** GitHub Actions compiles both firmwares on every change (`.github/workflows/ac-firmware.yml`).
  Run it by hand after setting the `AC_*` repository secrets to get flashable files.

## Parts (verified October 2026)

| Part | Qty | Notes |
|---|---|---|
| Interface PCB, `hardware-FeatherS3` design, assembled by JLCPCB | 1 order of 5 | Upload the GERBER, BOM and CPL files from the project's `hardware-FeatherS3/jlcpcb/production_files`. Must be 4 layers. About $50 for 5 plus shipping. Not the `hardware-tiny` board (open reports of 12V reaching the ESP32). |
| Unexpected Maker **FeatherS3** (ESP32-S3) | 2 | Adafruit 5399 or Unexpected Maker. Plain FeatherS3, not Neo or [D]. Powered from the board; never plug USB in while installed. |
| JST XH 3 pin cable (Adafruit 4873, or an XH compatible 2.54 mm pre wired pigtail kit) | 2 | Use the female plug with wires; it mates the board's male header. Must be XH, not PH or Dupont. Check wire order against the PREMTB100 before connecting (red 12V, yellow signal, black ground). |
| WAGO 221-413 lever connectors | 6 | 3 per zone, to splice into the controller wires. |
| Case | 2 | 3D printable case in the project, or a small project box. |
| USB C data cable | 1 | For the first firmware load. |

## Setup

1. Order the parts above.
2. Load the firmware on each FeatherS3 from a computer (Chrome web flasher).
3. Seat the FeatherS3 on the interface board.
4. Breaker off. Splice the board into the PREMTB100's red, yellow and black wires with the lever connectors.
5. Set the PREMTB100 to slave. Breaker on. The AC appears on the dashboard in its room.
