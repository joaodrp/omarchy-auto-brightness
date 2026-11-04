// Pure, Qt-free brightness control, so it runs under node too
// (test/control.test.js). The service samples sensors and drives displays;
// everything here is arithmetic on the state it passes in.
//
// Procedure, per sensor sample (the shape Android documents and macOS shows):
//   lux -> smoothing -> asymmetric hysteresis + debounce -> curve -> ramp
// Smoothing belongs to the sensor; the rest to each display it serves.
// Times are in seconds, brightness in percent of the display's range unless
// named units.
//
// The curve is in nits, so displays with different peaks land on the same
// luminance. A display's percent is linear in nits between its floor (at 0%)
// and its peak (at 100%), from its EDID where it says. A manual change while
// auto is on is held while the light stands, and becomes the display's
// preference: a bend of the curve, as Android adjusts its own, kept at every
// light level until the user clears it.

var config = {
  luxTau: -0.5 / Math.log(0.75), // EMA weight 0.25 per 0.5 s sample: settles in about 2 s
  brightenThreshold: 0.10, // accept a brighter room at 10% above the accepted lux
  darkenThreshold: 0.20,   // and a darker one at 20% below
  brightenDebounce: 4,     // seconds the new level must hold before it is accepted
  darkenDebounce: 8,
  // Ramp: a fixed rate in points per second, but any change completes within
  // the cap, the shape Android uses for automatic changes.
  brightenRate: 20,
  brightenCap: 2,
  dimRate: 13,
  dimCap: 3,
  samplePeriod: 0.5,       // seconds between sensor samples
  sensorDeadline: 3,       // seconds without a good reading before a sensor is reported
  maxFrameRate: 60,        // past what the eye resolves as steps
  // A preference p in [-1, 1] raises the curve's luminance, as a fraction of
  // its top, to the power maxGamma^-p: Android's
  // config_autoBrightnessAdjustmentMaxGamma default.
  maxGamma: 3,
  // A choice is held while the accepted lux stays within this ratio of where
  // it was made, either way: Android's SHORT_TERM_MODEL_THRESHOLD_RATIO.
  holdRatio: 0.6
}

// Lux anchors -> nits, interpolated in log2(lux + 1). Tuned on a 600-nit
// Studio Display: between the sRGB reference (80 nits at 64 lux) and the
// display's own idea of "dim". See docs/design.md, section 4.
var luxPoints = [0, 5, 20, 50, 100, 200, 400, 800, 1500, 3000, 5000]
var nitsPoints = [30, 54, 84, 114, 144, 180, 228, 288, 360, 480, 600]

// A display whose EDID gives no luminance is taken as the curve's own.
var defaultLuminance = { peak: 600, floor: 0 }

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }
function clampPct(v) { return clamp(v, 1, 100) }

function curve(lux) { return interpolate(lux, luxPoints, nitsPoints) }

// Piecewise linear in log2(lux + 1), flat past either end.
function interpolate(lux, xs, ys) {
  var n = xs.length
  if (lux <= xs[0]) return ys[0]
  if (lux >= xs[n - 1]) return ys[n - 1]
  var x = Math.log2(lux + 1)
  for (var i = 1; i < n; i++) {
    if (lux <= xs[i]) {
      var xa = Math.log2(xs[i - 1] + 1)
      var xb = Math.log2(xs[i] + 1)
      return ys[i - 1] + (x - xa) / (xb - xa) * (ys[i] - ys[i - 1])
    }
  }
  return ys[n - 1]
}

function luminance(peak, floor) {
  if (!(peak > 0)) return defaultLuminance
  var f = floor >= 0 && floor < peak ? floor : 0
  return { peak: peak, floor: f }
}

function nitsAt(pct, lum) { return lum.floor + (lum.peak - lum.floor) * pct / 100 }
function pctAt(nits, lum) { return (nits - lum.floor) / (lum.peak - lum.floor) * 100 }

// Brightness percent for the accepted lux, before clamping to the display.
function curvePct(lux, lum) { return pctAt(curve(lux), lum) }

// The curve's luminance bent by `preference`. The top stays put and the
// dark end moves most in luminance, about evenly in percent.
function bent(nits, preference) {
  var top = nitsPoints[nitsPoints.length - 1]
  return top * Math.pow(nits / top, Math.pow(config.maxGamma, -preference))
}

function target(lux, lum, preference) {
  return clampPct(pctAt(bent(curve(lux), preference), lum))
}

// Whether a choice `held` ({ lux, pct }) still stands at `lux`: within
// holdRatio of where it was made, around at least 1 lux as hysteresis is.
function holding(held, lux) {
  if (!held) return false
  var base = held.lux > 1 ? held.lux : 1
  return lux >= held.lux * (1 - config.holdRatio) && lux <= base * (1 + config.holdRatio)
}

// What to drive to: a held choice exactly while it stands, else the bent
// curve. Android likewise keeps the user's point while the light stays near.
function goal(lux, lum, preference, held) {
  return holding(held, lux) ? held.pct : target(lux, lum, preference)
}

// Points over the plain curve, as the chip shows them: each side as the
// slider would.
function points(lux, lum, preference, held) {
  return Math.round(goal(lux, lum, preference, held)) - Math.round(target(lux, lum, 0))
}

// The preference a manual choice of `pct` at `lux` teaches, to 0.001, or
// null when none can express it: at the curve's top every bend gives the top.
function learn(pct, lux, lum) {
  var top = nitsPoints[nitsPoints.length - 1]
  var x = curve(lux) / top, y = nitsAt(clampPct(pct), lum) / top
  if (x >= 1) return null
  if (y >= 1) return 1
  // x^gamma = y, gamma = maxGamma^-p
  var p = -Math.log(Math.log(y) / Math.log(x)) / Math.log(config.maxGamma)
  return Math.round(clamp(p, -1, 1) * 1000) / 1000
}

// An additive offset in points, from before preferences bent the curve, as
// the preference that gives the same brightness at `lux`, or none. The
// offset was added to the old percent table, which is this curve on a
// display of the default luminance.
function preferenceFromOffset(offset, lux, lum) {
  var p = offset ? learn(legacyPct(offset, lux), lux, lum) : 0
  return p === null ? 0 : p
}

// The brightness an old offset gave at `lux`, to hold while migrating: a
// bend may not reach it.
function legacyPct(offset, lux) { return clampPct(curvePct(lux, defaultLuminance) + offset) }

// Sensor smoothing: an EMA over elapsed time, so a late sample weighs more
// rather than the filter slowing down. `prev` is null for the first sample.
function smooth(prev, lux, dt) {
  if (prev === null || prev === undefined) return lux
  return prev + (1 - Math.exp(-dt / config.luxTau)) * (lux - prev)
}

// Hysteresis and debounce, per display.
//   state: { accepted, dir, since }, accepted null until the first sample
//   debounce: optional { brighten, darken } seconds, the config's by default
function accept(state, filtered, now, debounce) {
  var brighten = debounce ? debounce.brighten : config.brightenDebounce
  var darken = debounce ? debounce.darken : config.darkenDebounce
  if (state.accepted === null || state.accepted === undefined)
    return { accepted: filtered, dir: 0, since: now }
  var base = state.accepted > 1 ? state.accepted : 1
  var dir = 0
  if (filtered > state.accepted + base * config.brightenThreshold) dir = 1
  else if (filtered < state.accepted - base * config.darkenThreshold) dir = -1
  var since = dir !== state.dir ? now : state.since
  if (dir !== 0 && now - since >= (dir > 0 ? brighten : darken))
    return { accepted: filtered, dir: 0, since: now }
  return { accepted: state.accepted, dir: dir, since: since }
}

// Whether a sensor is overdue at `t`, and its state after the check.
//   state: { good, checked }, the times of its last good reading and check
// Checks run every sample period; a longer gap since the last one means
// nothing was sampling, a suspend or a stalled shell, not that the sensor
// failed, so its clock restarts.
function sensorCheck(state, t) {
  var good = t - state.checked > 4 * config.samplePeriod ? t : state.good
  return { state: { good: good, checked: t }, stale: t - good > config.sensorDeadline }
}

// Seconds since the previous sample, for the ramp: one sample period for the
// first, so a start fades at the ramp's rate from where the display is.
function stepSeconds(lastSample, t) {
  return lastSample < 0 ? config.samplePeriod : clamp(t - lastSample, 0, 5)
}

// One ramp step of `dt` seconds towards `goal`.
//   state: { brightness, goal, span }, brightness null when unknown
// The cap is measured from where the ramp started, so a large change really
// does finish within it instead of decaying towards it.
function ramp(state, goal, dt) {
  if (state.brightness === null || state.brightness === undefined)
    return { brightness: goal, goal: goal, span: 0 }
  var delta = goal - state.brightness
  var distance = Math.abs(delta)
  var span = state.goal === goal ? state.span : distance
  var up = delta > 0
  var step = Math.max((up ? config.brightenRate : config.dimRate) * dt,
                      span * dt / (up ? config.brightenCap : config.dimCap))
  // Within rounding of the goal is on it, or drift would leave a last no-op step.
  var next = distance <= step + 1e-9 ? goal : state.brightness + (up ? step : -step)
  return { brightness: next, goal: goal, span: span }
}

// Seconds per write while fading: the write's own time, but at most
// maxFrameRate writes a second.
function frameSeconds(writeSeconds) {
  return Math.max(writeSeconds, 1 / config.maxFrameRate)
}

// The writes that take the display from units `from` to `to` over `seconds`,
// one per frame: interpolated in log luminance when levels are fine, linearly
// when coarse, since a log fade would only bunch a few visible steps
// together. Rounded to whole units, repeats dropped, always ending on `to`.
function rampFrames(from, to, seconds, frame, levels) {
  var n = Math.max(1, Math.floor(seconds / frame))
  var a = Math.max(1, from), b = Math.max(1, to)
  var frames = []
  var prev = from
  for (var i = 1; i <= n; i++) {
    var t = i / n
    var v = levels > 100 ? Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t) : a + (b - a) * t
    v = i === n ? to : Math.round(v)
    if (v !== prev) frames.push(v)
    prev = v
  }
  return frames
}

// At least one unit: on a coarse backlight 1% would round to off.
function toUnits(pct, levels) { return Math.max(1, Math.round(clampPct(pct) * levels / 100)) }
function toPct(units, levels) { return Math.round(units * 100 / levels) }
