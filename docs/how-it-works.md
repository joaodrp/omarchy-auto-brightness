# How it works

What the plugin does, step by step, and what it touches. Why each step is
the way it is, with sources, is in [design.md](design.md).

## The loop

Every half second the plugin reads each light sensor an active screen or
the keyboard uses, smooths it once, and for each screen it serves:

| Stage | |
| --- | --- |
| Smooth | Exponential average with a 2 s time constant. Per sensor. |
| Accept | Only a change of +10% or -20% (below 1 lux, +0.1 or -0.2 lux), held for 4 s or 8 s. |
| Map | Lux to luminance, log-shaped: 30 nits in the dark, 144 at 100 lux, 600 at 5000. Bent by the screen's preference, then to percent between the screen's floor and peak. A manual choice is held while the light stays within 0.4x to 1.6x of where it was made, or up to 1.6 lux below 1 lux. |
| Ramp | 20 points per second up, 13 down, capped at 2 s and 3 s. Written as evenly paced steps, up to 60 a second, in the screen's own units and, where those are fine, in log luminance, so the fade is as smooth as the screen allows. |

The loop structure started from
[miharekar/omarchy-studio-display-auto-brightness](https://github.com/miharekar/omarchy-studio-display-auto-brightness).

## Screens

Every screen Hyprland reports is driven independently, each with its own
target, fade and record, from the kind that fits it:

| What | Studio Display | Laptop panel | Other monitors |
|------|----------------|--------------|----------------|
| Detection | Make `Apple Computer Inc` | An `eDP`, `LVDS` or `DSI` output | Any other output |
| Writes | `omarchy-brightness-display-apple` | `brightnessctl` on `omarchy-hw-display`'s backlight, in its own units | `omarchy-brightness-display-ddc`; automatic changes at most every 5 s, no fade |
| Read back | Every 10 s; every 1 s with the pop-up open | Every 10 s, from sysfs; every 0.5 s with the pop-up open | Every 30 s |
| Luminance | From the EDID's HDR metadata, else 600 nits | The same | The same |

The Studio Display needs `asdcontrol` and its passwordless sudo rule,
which Omarchy installs; each read is a `sudo asdcontrol` call, which the
journal logs. The Pro Display XDR is untested: its two sensors are not
used, so its Auto borrows another sensor.

Each screen takes a sensor in this order:

1. Its own, as the Studio Display has.
2. The laptop's, while the lid is open, whatever the panel shows.
3. Any other, kept across rescans while it stays.
4. None: manual control only.

A screen stops being driven while it is off: disabled, DPMS off, or the
laptop panel with the lid closed. Only blanked, by DPMS or the lock, it
keeps its widget, and an open pop-up stays open. Turning it back on,
waking from sleep or plugging it in reads its brightness back before any
change. Outputs are rescanned on Hyprland's monitor events and every
10 s. With the lid closed the laptop's sensor is not lent to other
screens.

Settings are keyed by the screen's make, model and serial, so a monitor
keeps its record across ports; the laptop panel is keyed as `internal`. A
screen without a serial is keyed by its port too. Two screens reporting
the same serial are told apart by output name while both are connected.
Each record holds the screen's Auto and its preference, a bend in
[-1, 1] ([design.md](design.md), stage 6).

Hotkeys go through Omarchy's helpers; the plugin sees their change at
its next read-back and adopts it. Each automatic write also reads back,
and a screen that keeps failing is retried with a growing delay, up to
60 s, so its hotkey changes show later. Nothing announces a change, and
plugins cannot see key presses, so the pop-up reads back often while it
is open.

## Keyboard

With `keyboard` on, the keyboard backlight Omarchy's hotkeys drive, the
first `*kbd_backlight*` LED, follows the laptop's sensor:

| | |
| --- | --- |
| Curve | 50% in the dark, 30% at 15 lux, 20% at 30; the keys light up below 30 lux and go out above 60, so the edge does not flicker. |
| Accept | A darker room after 2 s, a brighter one after 4 s. |
| Fade | Linear, over about a second. |
| Your choice | The slider or a hotkey is held, whatever the light does, until you lock, close the lid, sleep or every screen goes dark. Nothing is learnt. Manual is only ever chosen on the chip. |

The keyboard row sits on the laptop's bar, or the primary screen's while
the lid is closed; with `screens` off it is the widget's only row.

The keys are driven only while the session is unlocked, a screen is on
and the lid is open. Omarchy turns them off on lock and restores them on
unlock; after either the plugin waits 2 s, reads the LED, and takes what
it finds as the starting point rather than as your choice. With the lid
closed and Auto on they are turned off.

The lock screen offers plugins no service and Hyprland no event, so the
plugin asks it over IPC, `omarchy-shell lock isLocked`, every 2 s while
the keyboard is on Auto. Without Omarchy's lock screen the answer never
comes, and the keyboard is not driven. A change made in the 2 s before
the plugin notices a lock is the level Omarchy saves and restores on
unlock; the curve takes over again about 2 s later.

Another keyboard controller, such as the one some Omarchy forks ship,
would take this one's writes for hotkey presses, and the other way round.
An external keyboard whose LED name matches `*kbd_backlight*` and sorts
first is the one driven, as it is for the hotkeys.

## A sensor that reads 0 after sleep

Some laptop light sensors read 0 after a resume until their driver is
bound again. Rebinding brings them back:

```sh
for dev in /sys/bus/platform/drivers/hid_sensor_als/HID-SENSOR-*; do
  name=${dev##*/}
  echo "$name" | sudo tee /sys/bus/platform/drivers/hid_sensor_als/unbind >/dev/null
  echo "$name" | sudo tee /sys/bus/platform/drivers/hid_sensor_als/bind >/dev/null
done
```

## Upstream

Omarchy has open pull requests for built-in auto brightness. If one
lands, this plugin will shrink to whatever the built-in version does not
cover.
