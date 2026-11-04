.import "Control.js" as Control

// Pure keyboard backlight control, so it runs under node too
// (test/keyboard.test.js). The keyboard channel feeds it chassis sensor
// samples and the changes others make to the LED; it answers the level to
// drive, in percent of the LED's range, or null for none.
//
// The keys light up in a dark room and go out in a lit one, with separate
// on and off thresholds so the edge does not flicker. A darker room is
// accepted sooner than for a display: that is when the keys are needed.
//
// Nothing is learnt. A choice (the slider, or a hotkey once settled) is held
// whatever the light does until a pause (locked, the lid closed, asleep,
// every screen blanked): keys turned off at night stay off while in use, and
// the curve is back at the next session. After a pause the
// channel settles first: Omarchy restores the keyboard on wake, and what it
// writes then is adopted as the current level, not held as a choice.
//
//   state: { paused, resumed, accepted, on, held }
//     resumed: when the last pause ended, null while never resumed
//     accepted: Control.accept's state for the chassis sensor
//     on: the keys are lit by the curve, for the thresholds' hysteresis
//     held: the percent chosen, or null

var config = {
  onBelow: 30,     // lux: off, the keys light up below this
  offAbove: 60,    // on, they go out above this
  luxPoints: [0, 5, 15, 30, 60],
  pctPoints: [50, 40, 30, 20, 15],
  debounce: { brighten: 4, darken: 2 },
  settle: 2,       // seconds after a pause before anything is driven or held
  fadeSeconds: 1,  // a change of level, linear: a handful of visible steps
  frame: 0.1
}

function level(lux, wasOn) {
  var on = wasOn ? lux <= config.offAbove : lux < config.onBelow
  return { on: on, pct: on ? Control.interpolate(lux, config.luxPoints, config.pctPoints) : 0 }
}

function create() {
  return { paused: true, resumed: null, accepted: { accepted: null }, on: false, held: null }
}

function with_(s, changes) {
  var out = {}
  for (var k in s) out[k] = s[k]
  for (var c in changes) out[c] = changes[c]
  return out
}

function pause(s) { return with_(s, { paused: true, held: null }) }

// A fresh sensor sample is needed after a pause: the room may have changed.
function resume(s, now) {
  return with_(s, { paused: false, resumed: now, accepted: { accepted: null } })
}

function settling(s, now) {
  return s.paused || s.resumed === null || now - s.resumed < config.settle
}

function sample(s, lux, now) {
  var accepted = Control.accept(s.accepted, lux, now, config.debounce)
  return with_(s, { accepted: accepted, on: level(accepted.accepted, s.on).on })
}

function goal(s, now, auto) {
  if (!auto || settling(s, now) || s.accepted.accepted === null) return null
  if (s.held !== null) return s.held
  return level(s.accepted.accepted, s.on).pct
}

// A change someone else made to the LED: a hotkey, or Omarchy's restore.
function observed(s, pct, now) {
  if (settling(s, now)) return s
  return chose(s, pct)
}

function chose(s, pct) { return with_(s, { held: pct }) }

function forget(s) { return with_(s, { held: null }) }

// The writes that go from units `from` to `to`, one per frame: { at, units }
// with `at` seconds from the start, repeats dropped, ending on `to`. Each
// keeps its frame's time, so a coarse change takes the whole fade too.
function fade(from, to) {
  var n = Math.round(config.fadeSeconds / config.frame)
  var frames = [], prev = from
  for (var i = 1; i <= n; i++) {
    var v = Math.round(from + (to - from) * i / n)
    if (v !== prev) frames.push({ at: (i - 1) * config.frame, units: v })
    prev = v
  }
  return frames
}

// Units of an LED that has an off: 0 is a level, unlike a display's.
function toUnits(pct, levels) { return Math.round(Control.clamp(pct, 0, 100) * levels / 100) }
function toPct(units, levels) { return Math.round(units * 100 / levels) }
