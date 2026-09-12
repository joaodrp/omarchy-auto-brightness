# Brightness

A bar widget for the Apple Studio Display: a brightness slider and an
**Auto** mode driven by the display's own ambient light sensor. The stock
Display panel is left as it is.

- Shows in the bar only while an Apple display with a light sensor is
  connected. The icon changes with the mode.
- Auto follows the room the way macOS and Android do: smoothed lux,
  asymmetric hysteresis and debounce, a log-shaped curve, then a ramp.
  Brightening is quick, dimming is slow.
- Auto learns. Move the slider, the bar wheel, or the brightness hotkeys and
  the change is kept as an offset at the current light level, shown in the
  panel as `AUTO +8`. It fades after four hours or when the room changes a
  lot. Click the chip, or press Enter on it, to switch between Auto and
  Manual.
- The switch only shows when an Apple display and its light sensor are
  connected.

## Requirements

- An Apple display that Hyprland reports with make `Apple Computer Inc`.
  Tested on the 27" Studio Display; the XDR exposes the same interfaces.
- `asdcontrol` and the passwordless sudo rule for it. Omarchy installs both.

## Install

```sh
omarchy plugin add https://github.com/joaodrp/omarchy-auto-brightness.git --enable
```

The widget lands in the right section of the bar. Move it with
`omarchy plugin enable io.github.joaodrp.auto-brightness --section left`.

## Settings

Inline on the plugin's entry in `~/.config/omarchy/shell.json`:

| Key      | Default | Meaning                                              |
|----------|---------|------------------------------------------------------|
| `auto`   | `true`  | Auto brightness on. The switch persists here.        |
| `offset` | `0`     | Shift the whole curve by N points. Calibration knob. |

IPC, for keybindings or scripts:

```sh
omarchy-shell auto-brightness status
omarchy-shell auto-brightness toggle   # also enable / disable
```

## How it works

Every half second:

| Stage | What happens |
|-------|--------------|
| Lux | `in_illuminance_raw` x 0.001; the sensor reports millilux. |
| Smoothing | Exponential average, weight 0.25, so a jump settles in about 2 s. |
| Hysteresis | The smoothed value replaces the accepted one only when 10% above it or 20% below. |
| Debounce | And only after holding there for 4 s (brighter) or 8 s (darker). |
| Curve | Accepted lux to brightness, linear in log2(lux) between anchors, plus `offset`, plus the learned correction. |
| Ramp | 20 points per second up, 13 down, and any change completes within 2 s up or 3 s down. The display has about 20 visible steps, so a quick fade reads smoother than a slow one. |

Curve anchors:

| Lux | 0 | 5 | 20 | 50 | 100 | 200 | 400 | 800 | 1500 | 3000 | 5000 |
|-----|---|---|----|----|-----|-----|-----|-----|------|------|------|
| %   | 5 | 9 | 14 | 19 | 24  | 30  | 38  | 48  | 60   | 80   | 100  |

One percent is about 6 nits: the display's raw brightness runs linearly from
400 to 60000 over a panel that spans roughly 4 to 600 nits. That puts the
curve between the sRGB reference condition (80 nits at 64 lux) and what the
display's own scale suggests.

A manual change is stored as `chosen - curve(lux)` and added to the curve
until it expires. Changes made in the panel reach the controller at once
over stdin; hotkey changes are picked up by the next brightness read-back.

| File            | Role                                                                 |
|-----------------|----------------------------------------------------------------------|
| `controller`    | Bash loop: the pipeline above, writing through `omarchy-brightness-display`. |
| `Service.qml`   | Runs the controller, persists `auto`, forwards manual changes, exposes state to the panel and IPC. |
| `Panel.qml`     | The bar icon and panel: slider, Auto chip, lux readout.               |

The loop structure started from
[miharekar/omarchy-auto-brightness-auto-brightness](https://github.com/miharekar/omarchy-auto-brightness-auto-brightness),
which needs the XDR's two sensors. The hysteresis, debounce and learning
follow the design Android documents in `AutomaticBrightnessController`.

The evidence behind each stage is in [docs/design.md](docs/design.md).

### Check

```sh
./controller --self-test
```

## Known limits

- Manual changes made outside the panel are noticed within 10 s. Each check
  is a `sudo asdcontrol` call, which the journal logs.
- The curve is tuned by eye against published reference conditions, not
  with a light meter. `offset` and the learned correction cover the gap.
- Brightness only. The display exposes no colour temperature control over
  USB, and Night Light stays with `hyprsunset`.
