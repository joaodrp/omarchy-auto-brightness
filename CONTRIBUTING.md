# Contributing

Bug reports, displays that misbehave, and pull requests are all welcome.

If the widget never appears, that is a setup worth an issue: say the display
model, how it is connected, what `hyprctl monitors -j` reports for `make` and
`model`, and what `ls /sys/bus/iio/devices/*/name` prints.

## Layout

| File | |
| --- | --- |
| `manifest.json` | Plugin contract: kinds, entry points, settings schema and defaults |
| `Service.qml` | Runs the probe, samples the sensors, keeps one `DisplayChannel` per display and the `KeyboardChannel`, persists settings, IPC |
| `DisplayChannel.qml` | One display: its hardware operations, ramp and learning |
| `KeyboardChannel.qml` | The keyboard backlight: its hardware operations and fade |
| `probe` | Prints the outputs, sensors, lid, EDIDs, backlight and keyboard LED the inventory works from. Bash, no dependencies beyond what Omarchy ships |
| `Settings.js` | Per-display settings and what the service persists, apart from the shell's config echoes. Qt-free |
| `test/settings.test.js` | Unit tests for `Settings.js`, run under node |
| `Control.js` | The control pipeline as pure functions: smoothing, hysteresis, debounce, the curve in nits, ramp and learning. Qt-free |
| `test/control.test.js` | Unit tests for `Control.js`, run under node |
| `Inventory.js` | Which displays exist, which are active, how each is driven and which sensor serves it; when the keyboard is driven. Qt-free |
| `test/inventory.test.js` | Unit tests for `Inventory.js`, run under node |
| `Endpoint.js` | Scheduling for one display's brightness writes and read-backs: one at a time, latest wins, backoff, per-kind policy. Qt-free |
| `test/endpoint.test.js` | Unit tests for `Endpoint.js`, run under node |
| `Keyboard.js` | The keyboard backlight's curve, thresholds, pauses and holds. Qt-free |
| `test/keyboard.test.js` | Unit tests for `Keyboard.js`, run under node |
| `Panel.qml` | The bar icon and the panel |
| `docs/design.md` | Why each stage of the control pipeline is the way it is, with sources |
| `preview.png` | The listing image the [plugin marketplace](https://plugins.omarchy.org/publish.html) reads from the repository root |
| `docs/preview.html`, `docs/panel.png` | The source of `preview.png` and the demo frame it insets; see [Screenshots](#screenshots) |
| `docs/demo.gif`, `docs/demo.mp4` | The README hero and the shareable clip; see [Screenshots](#screenshots) |
| `ROLLBACK.md` | Everything the plugin touches on a machine, and how to undo it |
| `.github/`, `release-please-config.json`, `.release-please-manifest.json` | CI with its manifest check, and the release automation; see [Releases](#releases) |

## Running it

```sh
ln -s "$PWD" ~/.config/omarchy/plugins/io.github.joaodrp.auto-brightness
omarchy-shell shell rescanPlugins
omarchy plugin enable io.github.joaodrp.auto-brightness
```

Hot reload watches the plugins directory with `inotifywait -r`, which ignores a
symlinked checkout. Working from a symlink means restarting the shell for every
change:

```sh
omarchy-restart-shell
qs log -p "$OMARCHY_PATH/shell" --tail 60   # QML errors land here, and only with -p
```

## Checks

```sh
node test/settings.test.js         # what the service sends and persists
node test/control.test.js          # the control pipeline in JS
node test/inventory.test.js        # displays, sensors, identity, EDID luminance
node test/endpoint.test.js         # write and read-back scheduling per display
node test/keyboard.test.js         # the keyboard backlight's curve, pauses and holds
omarchy plugin validate "$PWD"
python3 .github/check-manifest.py  # manifest, README table and Service.qml reads agree

# QML lint needs an import dir holding a `qs` symlink to the shell
mkdir -p /tmp/qslint && ln -sfn "$OMARCHY_PATH/shell" /tmp/qslint/qs
/usr/lib/qt6/bin/qmllint -I /tmp/qslint Panel.qml Service.qml DisplayChannel.qml
```

Use the Qt 6 `qmllint` path above: the one on `PATH` is Qt 5 and fails on every
Quickshell file. It warns `unqualified` and `missing-property` on this plugin
and every first-party panel alike; compare the warning set before and after a
change rather than aiming for silence.

The checks prove the maths and that the files parse. For the rest, watch it:

```sh
omarchy-shell auto-brightness status            # every display: lux, target, brightness, preference
omarchy-brightness-display --monitor DP-1 40%    # a "hotkey" change; becomes DP-1's preference at its next read-back
omarchy-brightness-display --monitor eDP-1 40%   # the same on the laptop panel
omarchy-shell auto-brightness toggleFor eDP-1    # Manual on that display only
```

CI runs the unit tests and the manifest check. `omarchy plugin validate` and the
linter need Omarchy and Quickshell on the machine, so run those two yourself.

## Changing the control pipeline

Every constant in `Control.js` and every policy in `Endpoint.js` has a reason
in [docs/design.md](docs/design.md). Change the constant and the reason in
the same commit, and add a source if the reason is new. A change to the
curve, the thresholds or the ramp should extend `test/control.test.js`.

## Screenshots

The display is scale 2, so captured pixels are twice the logical size. Switch
to an empty workspace first so the wallpaper, not a window, sits behind the
panel. Quattro's `hyprctl dispatch` takes Lua:

```sh
hyprctl dispatch 'hl.dsp.focus({ workspace = "2" })'
omarchy-shell io.github.joaodrp.auto-brightness open
grim -o DP-3 shot.png
omarchy-shell io.github.joaodrp.auto-brightness close
```

The demo clip is recorded the same way, with `wlrctl pointer move` and
`click` driving the panel (positions are in logical pixels; move to a far
negative corner first, then to the target) and `gpu-screen-recorder -w
region` capturing a frame with equal margins around the panel:

```sh
gpu-screen-recorder -w region -region 422x176+2086+0 -f 30 -c mp4 -cursor yes -o demo.mp4
ffmpeg -i demo.mp4 -vf "fps=15,scale=633:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" demo.gif
```

`preview.png` is `docs/preview.html` rendered at 1920x1080. The marketplace
crops it to about 2:1 and shows it 505px wide with the plugin name printed
underneath, so the page keeps everything that matters out of the top and
bottom 60px and spends its headline on the pitch, not the name. It insets
`docs/panel.png`, the frame of the demo clip where the chip reads `Auto +6`,
cut to the panel's border by pixel position; after a new clip, re-extract
the frame and check the cut still holds. The page is set in Nimbus Sans,
from `gsfonts`.

```sh
ffmpeg -ss 8 -i docs/demo.mp4 -frames:v 1 docs/panel.png
chromium --headless --hide-scrollbars --window-size=1920,1080 --screenshot=preview.png docs/preview.html
```

## Conventions

Native to Omarchy first. Before inventing a component, look for the built-in
that solves it in `$OMARCHY_PATH/shell/Ui/` or in a first-party panel under
`$OMARCHY_PATH/shell/plugins/`. Brightness goes through each display
profile's own `_read` and `_write`. The Studio Display's use
`omarchy-brightness-display` and `omarchy-brightness-display-apple`, never
`asdcontrol` directly; the laptop panel's use the backlight's sysfs node and
`brightnessctl`.

Comments carry what the code cannot: why an obvious alternative was rejected.
They describe the current state, never the change; git history holds that.

## Gotchas

- **The display's USB side can drop while video stays up.** Then there is no
  sensor and no brightness control, the widget hides, and Omarchy's own
  brightness keys do nothing either. Replugging the display brings it back.
- **The Apple sensor reports millilux** while the kernel's
  `in_illuminance_scale` reads 1.0. Do not trust the scale file for it.
- **Every brightness read-back is a `sudo asdcontrol` call** and lands in
  the journal. Poll sparingly.
- **`omarchy-brightness-display` drops a colliding call and exits 0.** It
  holds a non-blocking lock against key repeat. Reads go through it, so a
  read during a hotkey press simply fails and the poll skips its write;
  writes go to `omarchy-brightness-display-apple` directly, or a ramp would
  drop half the user's presses.
- **A zero-timeout `read` in bash consumes nothing.** `read -t 0` only
  reports that input is waiting; draining with it spins at 100% CPU.
- **Write latency is per display**: about 80 ms on the Studio Display,
  about 4 ms on a laptop backlight. Fades measure it and pace themselves, so
  never assume either. The `asdcontrol` README claims only about 20 visible
  backlight levels; the firmware accepts every percent, and whether each is
  visible is untested.
- **The shell echoes every config write about 24 times, old value first.**
  The new value arrives only after a file round trip that can take seconds.
  Never act on config state directly; `Settings.js` acts only on
  changes that are neither repeats nor echoes of the service's own writes.
- **A laptop light sensor can read 0 after a resume** until its driver is
  bound again; see the README's known limits. A flat 0 in a lit room is
  that, not the plugin.
- **Icon glyphs lie.** Verify any new Nerd Font codepoint by rendering it
  before shipping; a guessed codepoint here drew a barrel.
- **Reload is a restart.** Never `omarchy-refresh-shell`: that resets the
  user's bar to defaults.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), one logical
change each. Describe what the change does and why, in the body, with
backticks around identifiers.

## Releases

[release-please](https://github.com/googleapis/release-please) reads the
Conventional Commits on `main` and keeps a release pull request open with the
next version and the changelog. Merging it bumps `version` in
`manifest.json`, tags `vX.Y.Z` and publishes the GitHub release; CI checks
that the tag and the manifest agree. `feat` bumps the minor version, `fix`
the patch, a `!` or `BREAKING CHANGE` footer the major.

## Scope

Every display Omarchy can drive: the Studio Display, the laptop panel, and
DDC/CI monitors, each with its own settings. Colour temperature is out of
scope; the display exposes no control for it, and Night Light already owns
`hyprsunset`.
