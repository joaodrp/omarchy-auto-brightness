# Studio Display

Omarchy's Display panel with an **Auto** switch next to the brightness slider,
driven by the Apple Studio Display's own ambient light sensor.

- Same panel as stock Omarchy: brightness, text size, scale, monitors. This
  plugin replaces `omarchy.monitor` in the bar and keeps its IPC target.
- Auto follows the room: log-shaped lux curve, smoothed, with hysteresis so
  it does not twitch. Brightening is quick, dimming is slow.
- Moving the slider, the bar wheel, or the brightness hotkeys switches Auto
  off. Flip the switch, or press Enter on the brightness row, to hand control
  back.
- The switch only shows when an Apple display and its light sensor are
  connected.

## Requirements

- An Apple display that Hyprland reports with make `Apple Computer Inc`.
  Tested on the 27" Studio Display; the XDR exposes the same interfaces.
- `asdcontrol` and the passwordless sudo rule for it. Omarchy installs both.

## Install

```sh
omarchy plugin add https://github.com/joaodrp/omarchy-studio-display.git --enable
```

Enabling swaps the stock Display widget for this one, in the same bar slot,
and disables `omarchy.monitor`. Disabling puts the stock widget back.

## Settings

Inline on the plugin's entry in `~/.config/omarchy/shell.json`:

| Key      | Default | Meaning                                              |
|----------|---------|------------------------------------------------------|
| `auto`   | `true`  | Auto brightness on. The switch persists here.        |
| `offset` | `0`     | Shift the whole curve by N points. Calibration knob. |

IPC, for keybindings or scripts:

```sh
omarchy-shell studio-display status
omarchy-shell studio-display toggle   # also enable / disable
```

## How it works

| File            | Role                                                                 |
|-----------------|----------------------------------------------------------------------|
| `controller`    | Bash loop: reads `in_illuminance_raw` from the display's IIO device, maps lux to a target, writes it through `omarchy-brightness-display`. |
| `Service.qml`   | Runs the controller, persists `auto`, exposes state to the panel and IPC. |
| `Panel.qml`     | Upstream `omarchy.monitor` panel plus the switch. Generated, see below. |
| `patch-panel.py`| The switch as anchored edits on top of the upstream panel.           |

The lux curve and smoothing come from
[miharekar/omarchy-studio-display-auto-brightness](https://github.com/miharekar/omarchy-studio-display-auto-brightness),
which needs the XDR's two sensors. This plugin works with the Studio
Display's single sensor.

### Tracking upstream

`Panel.qml` and `Model.js` are copies of Omarchy's Display panel. After an
Omarchy update:

```sh
cp ~/.local/share/omarchy/shell/plugins/panels/monitor/{Panel.qml,Model.js} .
./patch-panel.py
```

The script stops if an anchor no longer matches, so a changed upstream
panel is never half-patched.

### Check

```sh
./controller --self-test
```

## Known limits

- Manual changes made outside the panel are noticed within 10 s. Each check
  is a `sudo asdcontrol` call, which the journal logs.
- Brightness only. The display exposes no colour temperature control over
  USB, and Night Light stays with `hyprsunset`.
