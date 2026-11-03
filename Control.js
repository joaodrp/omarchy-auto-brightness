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
// auto is on becomes the display's preference: a ratio to the curve, in
// percent, kept at every light level until the user clears it.

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
  maxFrameRate: 60,        // past what the eye resolves as steps
  minPreference: -99.99    // a ratio of 0.0001, so 1% stays reachable on a dim display; at -100 the curve would be lost
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

function curve(lux) {
  var n = luxPoints.length
  if (lux <= luxPoints[0]) return nitsPoints[0]
  if (lux >= luxPoints[n - 1]) return nitsPoints[n - 1]
  var x = Math.log2(lux + 1)
  for (var i = 1; i < n; i++) {
    if (lux <= luxPoints[i]) {
      var xa = Math.log2(luxPoints[i - 1] + 1)
      var xb = Math.log2(luxPoints[i] + 1)
      return nitsPoints[i - 1] + (x - xa) / (xb - xa) * (nitsPoints[i] - nitsPoints[i - 1])
    }
  }
  return nitsPoints[n - 1]
}

// A display's luminance model, from EDID values that may be missing or wrong.
function luminance(peak, floor) {
  if (!(peak > 0)) return defaultLuminance
  var f = floor >= 0 && floor < peak ? floor : 0
  return { peak: peak, floor: f }
}

function nitsAt(pct, lum) { return lum.floor + (lum.peak - lum.floor) * pct / 100 }
function pctAt(nits, lum) { return (nits - lum.floor) / (lum.peak - lum.floor) * 100 }

// Brightness percent for the accepted lux, before clamping to the display.
function curvePct(lux, lum) { return pctAt(curve(lux), lum) }

function target(lux, lum, preference) {
  return clampPct(pctAt(curve(lux) * (1 + preference / 100), lum))
}

// The preference a manual choice of `pct` at `lux` teaches, to 0.01%.
function learn(pct, lux, lum) {
  var ratio = nitsAt(clampPct(pct), lum) / curve(lux)
  return Math.max(config.minPreference, Math.round((ratio - 1) * 10000) / 100)
}

// An additive offset in points, from before preferences were ratios, as the
// ratio that gives the same brightness at `lux`. The offset was added to the
// old percent table, which is this curve on a display of the default
// luminance.
function preferenceFromOffset(offset, lux, lum) {
  return offset ? learn(curvePct(lux, defaultLuminance) + offset, lux, lum) : 0
}

// Sensor smoothing: an EMA over elapsed time, so a late sample weighs more
// rather than the filter slowing down. `prev` is null for the first sample.
function smooth(prev, lux, dt) {
  if (prev === null || prev === undefined) return lux
  return prev + (1 - Math.exp(-dt / config.luxTau)) * (lux - prev)
}

// Hysteresis and debounce, per display.
//   state: { accepted, dir, since }, accepted null until the first sample
function accept(state, filtered, now) {
  if (state.accepted === null || state.accepted === undefined)
    return { accepted: filtered, dir: 0, since: now }
  var base = state.accepted > 1 ? state.accepted : 1
  var dir = 0
  if (filtered > state.accepted + base * config.brightenThreshold) dir = 1
  else if (filtered < state.accepted - base * config.darkenThreshold) dir = -1
  var since = dir !== state.dir ? now : state.since
  if (dir !== 0 && now - since >= (dir > 0 ? config.brightenDebounce : config.darkenDebounce))
    return { accepted: filtered, dir: 0, since: now }
  return { accepted: state.accepted, dir: dir, since: since }
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
