# Brightness

[![CI](https://github.com/joaodrp/omarchy-auto-brightness/actions/workflows/ci.yml/badge.svg)](https://github.com/joaodrp/omarchy-auto-brightness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Auto brightness for Omarchy: every connected display follows the room,
each with its own ambient light sensor or one it borrows. Drives the Apple
Studio Display, the laptop's internal panel and DDC/CI monitors, all at
once; see [Displays](#displays).

<img src="docs/demo.gif" alt="The panel open under the bar: a nudge on the slider becomes Auto +6, a jump becomes Auto -35, restore ramps back to the curve, and the chip switches to Manual and back" width="422">

- The widget on each monitor's bar shows and controls that monitor's
  display, and appears only on displays the plugin drives.
- Auto follows the room the way macOS and Android do: smoothed lux,
  hysteresis and debounce, a log-shaped curve in nits, a quick brighten and
  a slow dim.
- Auto learns, per display. Any manual change, slider, wheel or hotkey,
  becomes that display's preference: how much brighter or dimmer than the
  curve, shown on the chip as `Auto +24` and kept until you press the
  restore button beside it.
- Optionally, the laptop's keyboard backlight too: lit in a dark room, off
  in a lit one; see [Keyboard backlight](#keyboard-backlight).

## Requirements

Any of:

- An Apple Studio Display with its USB side connected, so Hyprland reports
  make `Apple Computer Inc` and the light sensor appears under
  `/sys/bus/iio`. Needs `asdcontrol` and its passwordless sudo rule, which
  Omarchy installs. The Pro Display XDR is untested; its two sensors are
  not used, so its Auto borrows another sensor, a laptop's or a USB one.
- A laptop with a backlight `brightnessctl` can drive.
- An external monitor that answers DDC/CI, through Omarchy's
  `omarchy-brightness-display-ddc`.

Auto needs an ambient light sensor under `/sys/bus/iio`: the Studio
Display's, or a laptop's. Without one, the displays get manual control only.

## Install

```sh
omarchy plugin add https://github.com/joaodrp/omarchy-auto-brightness.git --enable
```

## Settings

Inline on the plugin's entry in `~/.config/omarchy/shell.json`, or via
Setup > Plugins:

| Key | Default | Meaning |
| --- | --- | --- |
| `screens` | `true` | Control the displays' brightness. Off, no display is read or written and the bar shows only the keyboard, if any. |
| `auto` | `true` | Follow the room, on a display seen for the first time. Each display then keeps its own. |
| `keyboard` | `false` | Control the keyboard backlight from the laptop's sensor. See [Keyboard backlight](#keyboard-backlight). |

Each display's own Auto and preference (your correction to the curve, a
bend in [-1, 1]; see [docs/design.md](docs/design.md), stage 6) are kept
under `displays`, keyed by the display's make, model and serial. The chip and the slider set them; restore
clears the preference.

IPC, on one display by its output name:

```sh
omarchy-shell auto-brightness status            # every display, under `displays`
omarchy-shell auto-brightness toggleFor eDP-1   # Auto on or off
omarchy-shell auto-brightness forgetFor eDP-1   # clear the preference
omarchy-shell auto-brightness setFor eDP-1 40   # as if you moved the slider
```

`toggle`, `enable`, `disable`, `forget` and `set 40` do the same on the
primary display: the Studio Display if active, else the laptop panel, else
the first other active one. `keyboard` in place of an output name acts on
the keyboard backlight; `status` reports it under `keyboard`.

## How it works

Every half second the plugin reads each light sensor an active display
uses, smooths it once, and for each display it serves:

| Stage | |
| --- | --- |
| Smooth | Exponential average, settles in about 2 s. Per sensor. |
| Accept | Only a change of +10% or -20%, held for 4 s or 8 s. |
| Map | Lux to luminance, log-shaped: 30 nits in the dark, 144 at 100 lux, 600 at 5000. Bent by the display's preference, then to percent between the display's floor and peak. A manual choice is held while the light stays within 0.4x to 1.6x of where it was made, or up to 1.6 lux below 1 lux. |
| Ramp | 20 points per second up, 13 down, capped at 2 s and 3 s. Written as evenly paced steps, up to 60 a second, in the display's own units and, where those are fine, in log luminance, so the fade is as smooth as the display allows. |

The evidence for each stage is in [docs/design.md](docs/design.md). The
loop structure started from
[miharekar/omarchy-studio-display-auto-brightness](https://github.com/miharekar/omarchy-studio-display-auto-brightness).

## Displays

Every display Hyprland reports is driven independently, each with its
own target, fade and record, from the kind that fits it:

| What | Studio Display | Laptop panel | Other monitors |
|------|----------------|--------------|----------------|
| Detection | Make `Apple Computer Inc` | An `eDP`, `LVDS` or `DSI` output | Any other output |
| Writes | `omarchy-brightness-display-apple` | `brightnessctl` on `omarchy-hw-display`'s backlight, in its own units | `omarchy-brightness-display-ddc`; automatic changes at most every 5 s, no fade |
| Read back | Every 10 s, to adopt hotkey changes | Every 10 s, from sysfs | Every 30 s |
| Luminance | From the EDID's HDR metadata, else 600 nits | The same | The same |

Each display takes a sensor in this order:

1. Its own, as the Studio Display has.
2. The laptop's, while the lid is open, whatever the panel shows.
3. Any other, kept across rescans while it stays.
4. None: manual control only.

A sensor reads the light where it sits, so a monitor borrowing one gets
the right curve only if they share a room. Its preference absorbs a
constant difference.

A display stops being driven while it is off: disabled, DPMS off, or the
laptop panel with the lid closed. Only blanked, by DPMS or the lock, it
keeps its widget, and an open pop-up stays open. Turning it back on, waking from sleep or
plugging it in reads its brightness back before any change. Outputs are
rescanned on Hyprland's monitor events and every 10 s.

Settings are keyed by the display's make, model and serial, so a monitor
keeps its record across ports; the laptop panel is keyed as `internal`. A
display without a serial is keyed by its port too. Two displays reporting
the same serial are told apart by output name while both are connected.

## Keyboard backlight

With `keyboard` on, the keyboard backlight Omarchy's hotkeys drive, the
first `*kbd_backlight*` LED, follows the laptop's light sensor:

| | |
| --- | --- |
| Curve | 50% in the dark, 30% at 15 lux, 20% at 30; the keys light up below 30 lux and go out above 60, so the edge does not flicker. |
| Accept | A darker room after 2 s, a brighter one after 4 s. |
| Fade | Linear, over about a second. |
| Your choice | The slider or a hotkey is held, whatever the light does, until you lock, close the lid or sleep; a restore button beside the chip shows it. Nothing is learnt: the curve comes back after that, or with the restore button. Manual is only ever chosen on the chip. |

The keyboard row sits on the laptop's bar, or the primary display's while
the panel is off; with `screens` off it is the widget's only row. The keys
are driven only while the session is unlocked, a screen is on and the lid
is open; Omarchy turns them off on lock and restores them on unlock, and
the plugin waits 2 s after either before taking over again. With the lid
closed and Auto on they are turned off.

Run one keyboard controller: another, such as the one some Omarchy forks
ship, would take this one's writes for hotkey presses, and the other way
round. An external keyboard whose LED name matches `*kbd_backlight*` and
sorts first is the one driven, as it is for the hotkeys.

Omarchy has open pull requests for built-in auto brightness. If one lands,
this plugin will shrink to whatever the built-in version does not cover.

## Known limits

- Hotkey changes are noticed at the next idle read-back, every 10 s or
  30 s over DDC/CI, later while a display is failing. On the Studio
  Display each check is a `sudo asdcontrol` call, which the journal logs.
- A monitor that does not answer DDC/CI still shows the widget, with
  "Cannot reach the display".
- Two Apple displays at once are not driven: Omarchy's Apple helper
  cannot tell them apart.
- Brightness only. The Studio Display has no colour temperature control
  over USB.
- The keyboard pauses within about 2 s of a lock: the lock screen offers
  plugins no service and Hyprland no event, so it is asked over IPC every
  2 s while the keyboard is on Auto. Without Omarchy's lock screen the
  answer never comes, and the keyboard is not driven. A change made in
  those 2 s is the level Omarchy saves and restores on unlock; the curve
  takes over again about 2 s later.
- The keyboard stays lit in the dark while you are not typing; turning it
  off when idle is not done yet.
- With the lid closed the laptop panel is not driven, and its sensor is
  not lent to other displays.
- Some laptop light sensors read 0 after a resume until their driver is
  bound again. Rebinding brings them back:

  ```sh
  for dev in /sys/bus/platform/drivers/hid_sensor_als/HID-SENSOR-*; do
    name=${dev##*/}
    echo "$name" | sudo tee /sys/bus/platform/drivers/hid_sensor_als/unbind >/dev/null
    echo "$name" | sudo tee /sys/bus/platform/drivers/hid_sensor_als/bind >/dev/null
  done
  ```
