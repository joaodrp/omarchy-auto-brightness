# Contributing

Bug reports, displays that misbehave, and pull requests are all welcome.

If the widget never appears, that is a setup worth an issue: say the display
model, how it is connected, what `hyprctl monitors -j` reports for `make` and
`model`, and what `ls /sys/bus/iio/devices/*/name` prints.

## Layout

| File | |
| --- | --- |
| `manifest.json` | Plugin contract: kinds, entry points, settings schema and defaults |
| `controller` | The auto brightness loop. Bash, no dependencies beyond what Omarchy ships |
| `Service.qml` | Runs the controller, persists settings, forwards manual changes, IPC |
| `Panel.qml` | The bar icon and the panel |
| `docs/design.md` | Why each stage of the controller is the way it is, with sources |
| `preview.png` | The listing image the [plugin marketplace](https://plugins.omarchy.org/publish.html) reads from the repository root |
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
./controller --self-test           # curve, hysteresis, debounce, ramp, offset
omarchy plugin validate "$PWD"
python3 .github/check-manifest.py  # manifest, README table and Service.qml reads agree

# QML lint needs an import dir holding a `qs` symlink to the shell
mkdir -p /tmp/qslint && ln -sfn "$OMARCHY_PATH/shell" /tmp/qslint/qs
/usr/lib/qt6/bin/qmllint -I /tmp/qslint Panel.qml Service.qml
```

Use the Qt 6 `qmllint` path above: the one on `PATH` is Qt 5 and fails on every
Quickshell file. It warns `unqualified` and `missing-property` on this plugin
and every first-party panel alike; compare the warning set before and after a
change rather than aiming for silence.

The checks prove the maths and that the files parse. For the rest, watch it:

```sh
omarchy-shell auto-brightness status          # lux, target, brightness, offset
omarchy-brightness-display --monitor DP-3 40%  # a "hotkey" change; becomes the offset within 10 s
omarchy-shell auto-brightness disable          # Manual
```

CI runs the self-test and the manifest check. `omarchy plugin validate` and the
linter need Omarchy and Quickshell on the machine, so run those two yourself.

## Changing the controller

Every constant at the top of `controller` has a reason in
[docs/design.md](docs/design.md). Change the constant and the reason in the
same commit, and add a source if the reason is new. A change to the curve,
the thresholds or the ramp should extend `--self-test`.

## Screenshots

The display is scale 2, so captured pixels are twice the logical size. Switch
to an empty workspace first so the wallpaper, not a window, sits behind the
panel. Quattro's `hyprctl dispatch` takes Lua:

```sh
hyprctl dispatch 'hl.dsp.focus({ workspace = "2" })'
omarchy-shell io.github.joaodrp.auto-brightness open
grim -o DP-3 shot.png
omarchy-shell io.github.joaodrp.auto-brightness close
magick shot.png -gravity NorthEast -crop 1000x330+0+0 +repage preview.png
```

The demo clip is recorded the same way, with `wlrctl pointer move` and
`click` driving the panel (positions are in logical pixels; move to a far
negative corner first, then to the target) and `gpu-screen-recorder -w
region` capturing a frame with equal margins around the panel:

```sh
gpu-screen-recorder -w region -region 460x200+2071+0 -f 30 -c mp4 -cursor yes -o demo.mp4
ffmpeg -i demo.mp4 -vf "fps=15,scale=690:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" demo.gif
```

## Conventions

Native to Omarchy first. Before inventing a component, look for the built-in
that solves it in `$OMARCHY_PATH/shell/Ui/` or in a first-party panel under
`$OMARCHY_PATH/shell/plugins/`. Brightness goes through
`omarchy-brightness-display` for reads and `omarchy-brightness-display-apple`
for writes, never straight to `asdcontrol`.

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
- **A write takes about 80 ms**, so a ramp can afford one-point steps. The
  `asdcontrol` README claims only about 20 visible backlight levels; the
  firmware accepts every percent, and whether each is visible is untested.
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

One display today, by necessity rather than design: see the README's
"Other displays" for what generalising takes. Colour temperature is out of
scope; the display exposes no control for it, and Night Light already owns
`hyprsunset`.
