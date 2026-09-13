# Why the controller works the way it does

Evidence behind each stage of the auto brightness procedure, collected so
the design can be argued for upstream. Where a choice rests on a
measurement made on one display or on taste, that is said.

## Summary

The controller follows the shape that Android documents in source and
that macOS shows in use: filter the sensor, accept a new light level only
past a hysteresis band and after a debounce, map lux to luminance on a
log-shaped curve, ramp to it, and treat a manual change as a correction to
learn rather than a reason to stop. No published system uses a fixed
lux-to-percent table from another display, and none turns auto off when
the user touches the keys.

## Principles

- **Transitions are as smooth as the hardware allows.** The step is the
  smallest the display can take in the time one write costs, and the
  number of writes is whatever the rate then requires. Nothing about the
  fade is a per-display constant; the controller measures its own write
  latency and derives the step from it, so a faster display gets finer
  steps for free and a slower link gets coarser ones without stalling.
- **The user's hand always wins.** A manual change is adopted, never
  fought, and becomes the standing correction.
- **Stability comes from hysteresis and debounce, not from a slow ramp.**
  The ramp only hides the transition.

## Measured on the hardware

Apple Studio Display, 27", firmware as of September 2026, on Omarchy
Quattro with Hyprland reporting make `Apple Computer Inc`, model
`StudioDisplay`.

| Fact | Measurement | Consequence |
|------|-------------|-------------|
| One ambient light sensor | A single `als` IIO device under the display's USB HID path (`05ac:1114`). The Pro Display XDR exposes two. | Any controller written for the XDR that requires two sensors fails here. |
| Illuminance unit | `in_illuminance_raw` reads about 10000 in a lamp-lit evening room while `in_illuminance_scale` reads 1.0. | The raw value is millilux. A scale of 0.001 gives about 10 lux for that room, which is the expected order for dim domestic lighting. |
| Colour channels | The same device reports `in_colortemp_raw` (about 3100 K under warm bulbs) and CIE `in_chromaticity_x/y_raw`. | Ambient colour temperature is available for a future True Tone-like feature. |
| Brightness scale | `asdcontrol` raw values are linear in Omarchy's percent: 10% -> 6360, 50% -> 30200, range 400 to 60000. | With a panel Apple rates at 600 nits, the raw unit is 0.01 nit and one percent is about 6 nits. |
| Visible steps | Setting values below a granularity of about 2980 raw does not change the backlight; about 20 steps end to end (asdcontrol README). | Every transition is a sequence of roughly 5% hops. The ramp can only choose how far apart they land. |

## The procedure, stage by stage

### 1. Smoothing

Exponential moving average with weight 0.25 per 0.5 s poll, so a step
settles in about 2 s.

Android keeps a history of timestamped samples and derives short- and
long-horizon estimates from it, historically over a 10 s window
(`AutomaticBrightnessController.java`). An EMA is the simplest filter
with the same intent. The weight is a choice, not a measurement.

### 2. Hysteresis

The smoothed lux replaces the accepted lux only when 10% above it or 20%
below it.

Android's historical defaults are 10% brightening and 20% darkening
hysteresis, later made lux-dependent through
`config_ambientBrighteningThresholds` and
`config_ambientDarkeningThresholds`. The larger darkening margin exists
because shadows, hands and passing bodies produce short downward dips
far more often than upward spikes.

### 3. Debounce

The new level must hold for 4 s (brighter) or 8 s (darker) before it is
accepted.

Android's resource defaults are
`config_autoBrightnessBrighteningLightDebounce` = 4000 ms and
`config_autoBrightnessDarkeningLightDebounce` = 8000 ms. Windows adaptive
brightness likewise requires a minimum lux delta before any transition
starts. Debounce, not the ramp, is what keeps the display from chasing
noise.

### 4. Curve

Lux to brightness percent, linear in log2(lux) between anchors:

| Lux | 0 | 5 | 20 | 50 | 100 | 200 | 400 | 800 | 1500 | 3000 | 5000 |
|-----|---|---|----|----|-----|-----|-----|-----|------|------|------|
| %   | 5 | 9 | 14 | 19 | 24  | 30  | 38  | 48  | 60   | 80   | 100  |
| nits, approx | 30 | 54 | 84 | 114 | 144 | 180 | 228 | 288 | 360 | 480 | 600 |

Why log-shaped: Weber's law says detectability follows relative change
in luminance, and Fechner's reading of it makes perceived brightness
roughly logarithmic in luminance. Stevens' power law with an exponent
well below 1 gives the same compressed shape. Android's curve is a spline
in lux to nits with control points spaced roughly geometrically; Apple's
observed behaviour is a compressed monotone curve that flattens near the
panel limit.

Why these anchors: the standards give reference points, not comfort
curves. sRGB's encoding condition is 80 nits at 64 lux; ITU-R BT.2035's
reference environment is 100 nits at 10 lux; both are colour-evaluation
conditions with dim surrounds. A compressed power-law heuristic through
the sRGB point with exponent 0.5 gives about 34 nits at 10 lux, 80 at
64, 136 at 200, 300 at 1000. A cockpit study over 1 to 10000 lux fitted
a power function for preferred luminance; a reading-comfort study found
low ambient light favoured lower luminance with a strong interaction
between the two. The anchors above sit between that heuristic and the
display's own idea of dim, because the offset (stage 6) absorbs personal
preference. They were tuned by eye
against these references, not with a light meter.

The previous table, inherited from an XDR plugin, floored at 12%, about
72 nits in a dark room, and reached 40% (240 nits) at 100 lux. Against
every reference above that is two to three times too bright at the
low end.

### 5. Ramp

Fixed rate, 20 points per second brightening and 13 dimming, with any
change completing within 2 s up or 3 s down.

Android's per-display configuration uses exactly this shape for
sensor-driven changes: `screenBrightnessRampSlowIncrease` /
`SlowDecrease` rates with `screenBrightnessRampIncreaseMaxMillis` = 2000
and `DecreaseMaxMillis` = 3000 in the documented example. Its generic
resource defaults are 60 units per second for automatic changes and 180
for slider moves, so the user's own action is always faster than the
sensor's.

Why brighten faster than dim: brightening is a legibility fix, dimming is
comfort. The vision literature does not settle whether increments or
decrements are easier to see, so the asymmetry is a product convention
shared by Android and, by observation, macOS.

Why not slower: perception research offers no rate below which a change
is invisible. Step-detection thresholds sit around 6 to 30% Weber
contrast depending on adaptation, and luminance transients make changes
more detectable, not less (blocking the transient cut detection by about
30% in one study). The engineering target for an invisible fade is a per
update change of 1 to 2%. A write to this display takes about 80 ms, so
each poll's move is written as a run of steps, one per write: the step is
what the rate covers in one write's time, which here is two points
brightening and one dimming; the fade is then as fine as the panel can
show, and the rule carries to any display without a new constant. The `asdcontrol` README reports about 20
visible backlight levels on 2022 firmware; the firmware accepts every
percent (raw values 596 apart), and whether each is visible has not been
measured. The earlier exponential ramp spread a 40-point dim over 15 s,
one hop every 2 s.

### 6. Learning from manual changes

A manual change while auto is on becomes the offset: chosen minus
curve(lux) at that moment. It is added to the curve at every light level
from then on, persisted with the plugin's settings, and cleared only by
the user, through the restore button or the setting.

Android's short-term model records the (lux, chosen brightness) pair,
biases the mapping around that lux, and discards it after a configurable
timeout. macOS keeps auto on when the keys are pressed, treats the change
as a bias, and by observation never expires it by the clock; the display
returns near the chosen level when the room returns to that light. KDE
Plasma 6 refits one of six calibration points. No shipping system turns
auto off on a keypress.

This plugin keeps the correction indefinitely, and at every light level
rather than near the one it was learned at. Both are deliberate. A desk
display does not move between rooms the way a phone does, so the
timeout Android needs would only surprise: the same room at one in the
morning should not snap back from a level chosen at nine. A single
offset rather than a per-lux one is the simplest model that matches how
people describe the preference, "a bit brighter than it picks", and it
is visible and reversible in one place. An earlier version expired the
correction after four hours or a fourfold change in light; the timer had
no justification and was removed.

## Alternatives considered

| Approach | Why not |
|----------|---------|
| Screen-content-aware brightness (wluma) | Needs a screen capture loop; the gain over ambient-only control is unquantified for a desktop display. |
| Reusing the XDR plugin's curve | Anchored in percent on a different panel with a two-sensor requirement; the floor was 72 nits. |
| Turning auto off on manual change | Contradicts every reference implementation and leaves the user to re-enable it. |
| Slower dim for comfort | On a 20-step panel slower means more visible hops, see stage 5. |

## Open questions

- The nits mapping assumes Apple's 600 nit rating is the raw maximum. A
  light meter reading at two percentages would settle it.
- The curve anchors between 200 and 5000 lux have not been lived with
  for long; the room this was built in reads about 10 lux at night and
  1600 lux in daylight.
- Whether one-point backlight steps are visible on this panel. If not,
  the dim step could be two points at no cost.
- Whether a per-lux correction, as Android and Plasma keep, would beat a
  single offset once someone lives with it across a full day of light.

## Sources

Platform implementations

- Android `AutomaticBrightnessController.java`: filtering horizons,
  hysteresis, debounce, short-term model.
  https://android.googlesource.com/platform/frameworks/base/+/master/services/core/java/com/android/server/display/AutomaticBrightnessController.java
- Android `DisplayDeviceConfig.java`: per-display ramp rates and caps,
  threshold configuration.
  https://android.googlesource.com/platform/frameworks/base/+/master/services/core/java/com/android/server/display/DisplayDeviceConfig.java
- Android `config.xml`: debounce defaults, generic ramp rates, curve
  arrays.
  https://android.googlesource.com/platform/frameworks/base/+/HEAD/core/res/res/values/config.xml
- Windows adaptive brightness: transition intervals and lux delta.
  https://learn.microsoft.com/windows-hardware/design/device-experiences/sensors-adaptive-brightness
- macOS behaviour as observed by users; Apple publishes no algorithm.
  https://apple.stackexchange.com/questions/442587/how-exactly-does-the-auto-brightness-work-in-macos
- Apple, True Tone and ambient sensing.
  https://support.apple.com/en-us/102147
- KDE Plasma 6 automatic brightness design.
  https://planet.kde.org/xavers-blog-2026-04-24-automatic-brightness-in-plasma/
- wluma, content-aware brightness for Wayland.
  https://github.com/max-baz/wluma
- asdcontrol README: brightness range and step granularity.
  https://github.com/nikosdion/asdcontrol

Standards

- sRGB reference viewing conditions, 80 cd/m2 at 64 lux.
  https://en.wikipedia.org/wiki/SRGB
- ITU-R BT.2035, reference environment 100 cd/m2 at 10 lux.
  https://www.itu.int/rec/R-REC-BT.2035/en

Perception and comfort research

- Anstis, properties of the visual channels: step-detection thresholds,
  increment versus decrement.
  https://anstislab.ucsd.edu/files/2012/11/1993-Properties-of-the-visual-channels.pdf
- Transients and change detection: blocking the transient reduces
  detection.
  https://pubmed.ncbi.nlm.nih.gov/17283932/
- Slow change blindness: 16 s fades largely undetected under diverted
  attention.
  https://pmc.ncbi.nlm.nih.gov/articles/PMC10860497/
- Cockpit display luminance versus ambient illuminance, 1 to 10000 lux.
  https://pubmed.ncbi.nlm.nih.gov/36258409/
- Reading comfort versus ambient light and display luminance.
  https://library.imaging.org/admin/apis/public/api/ist/website/downloadArticle/cic/29/1/art00009
