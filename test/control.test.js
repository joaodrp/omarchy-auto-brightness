// Unit tests for Control.js, run with `node test/control.test.js`.
// Control.js is a QML .js file (no exports), so it is evaluated into a
// shared scope the same way the QML engine does it.

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const c = {}
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "Control.js"), "utf8"), c)
const plain = (x) => JSON.parse(JSON.stringify(x))
const near = (actual, expected, tolerance, what) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual}, want ${expected}`)

const tests = []
function test(name, fn) { tests.push([name, fn]) }

// The Studio Display as its EDID reports it, and this laptop's panel.
const studio = c.luminance(604, 0)
const laptop = c.luminance(702, 7)
const legacy = c.luminance()  // no EDID luminance: the curve's own 600 nits

test("the curve is the documented table in nits", () => {
  assert.equal(c.curve(0), 30)
  assert.equal(c.curve(100), 144)
  assert.equal(c.curve(5000), 600)
  assert.equal(c.curve(100000), 600)
  near(c.curve(10), 68.5, 0.1, "curve(10), between 5 and 20 lux in log2")
})

test("on a 600-nit display the curve gives the old percent table", () => {
  const pct = [5, 9, 14, 19, 24, 30, 38, 48, 60, 80, 100]
  c.luxPoints.forEach((lux, i) => near(c.target(lux, legacy, 0), pct[i], 1e-9, `lux ${lux}`))
})

test("displays with different peaks land on the same luminance", () => {
  for (const lux of [0, 20, 100, 800]) {
    const nits = c.curve(lux)
    near(c.nitsAt(c.target(lux, studio, 0), studio), nits, 1e-9, `Studio at ${lux} lux`)
    near(c.nitsAt(c.target(lux, laptop, 0), laptop), nits, 1e-9, `laptop at ${lux} lux`)
  }
  // The brighter laptop needs fewer percent for the same nits.
  assert.ok(c.target(100, laptop, 0) < c.target(100, studio, 0))
})

test("missing or nonsensical EDID luminance falls back to the curve's own", () => {
  assert.deepEqual(plain(c.luminance(0, 0)), { peak: 600, floor: 0 })
  assert.deepEqual(plain(c.luminance(undefined, undefined)), { peak: 600, floor: 0 })
  assert.deepEqual(plain(c.luminance(500, 900)), { peak: 500, floor: 0 })
})

test("targets clamp to the display's range", () => {
  assert.equal(c.target(0, legacy, -1), 1)
  assert.equal(c.target(5000, legacy, 1), 100)
})

test("a preference bends the curve: a dark-room choice stays modest in daylight", () => {
  // Chosen 35% at 16 lux, where the curve gives about 13%.
  const p = c.learn(35, 16, legacy)
  near(c.target(16, legacy, p), 35, 0.3, "back at 16 lux")
  // About as many points over the curve in a lit room, not 3x its light.
  const room = c.target(200, legacy, p)
  assert.ok(room > c.target(200, legacy, 0) + 15 && room < 65, `200 lux: ${room}`)
  assert.ok(c.target(1500, legacy, p) < 90, "1500 lux stays below full")
  // The top stays put; the dark end moves with the rest.
  assert.equal(c.target(5000, legacy, p), 100)
  assert.ok(c.target(0, legacy, p) > c.target(0, legacy, 0))
})

test("a dimmer choice bends it down, gently at the top", () => {
  const p = c.learn(15, 200, legacy)
  assert.ok(p < 0, `preference ${p}`)
  near(c.target(200, legacy, p), 15, 0.3, "back at 200 lux")
  assert.ok(c.target(0, legacy, p) >= 1)
  assert.equal(c.target(5000, legacy, p), 100)
})

test("a preference is bounded, as Android bounds its gamma", () => {
  assert.equal(c.learn(100, 0, legacy), 1)
  assert.equal(c.learn(1, 100, legacy), -1)
})

test("a choice the curve's top cannot express is not learned", () => {
  assert.equal(c.learn(60, 5000, legacy), null)
  assert.equal(c.learn(60, 20000, studio), null)
})

test("a preference learned on one display maps through its own peak", () => {
  const p = c.learn(c.target(100, laptop, 0) * 1.5, 100, laptop)
  near(c.target(100, laptop, p), c.target(100, laptop, 0) * 1.5, 0.3, "laptop at 100 lux")
  const gamma = Math.pow(c.config.maxGamma, -p)
  near(c.nitsAt(c.target(800, laptop, p), laptop), 600 * Math.pow(c.curve(800) / 600, gamma), 1e-6, "laptop at 800 lux")
})

test("a choice is held exactly while the light stays near where it was made", () => {
  const held = { lux: 16, pct: 35 }
  assert.equal(c.goal(16, legacy, 0.2, held), 35)
  assert.equal(c.goal(5000, legacy, 0, { lux: 5000, pct: 60 }), 60)
  assert.equal(c.goal(16, legacy, 0, null), c.target(16, legacy, 0))
  // Android's short-term model band, 0.4x to 1.6x: a screen's own light on
  // the laptop's sensor, 4.8 -> 6 lux, keeps the choice.
  assert.equal(c.goal(6, legacy, 1, { lux: 4.8, pct: 45 }), 45)
  assert.equal(c.goal(25.6, legacy, 0, held), 35)
  assert.equal(c.goal(6.4, legacy, 0, held), 35)
  assert.equal(c.goal(26, legacy, 0, held), c.target(26, legacy, 0))
  assert.equal(c.goal(6, legacy, 0, held), c.target(6, legacy, 0))
  assert.equal(c.holding(held, 20), true)
  assert.equal(c.holding(held, 30), false)
  assert.equal(c.holding(null, 16), false)
  // In the dark the band is around 1 lux, as hysteresis is.
  assert.equal(c.holding({ lux: 0, pct: 30 }, 1.5), true)
  assert.equal(c.holding({ lux: 0, pct: 30 }, 2), false)
})

test("an old additive offset converts to the preference that keeps brightness still", () => {
  assert.equal(c.preferenceFromOffset(0, 20, legacy), 0)
  // The old offset was on the old percent table: +6 at 20 lux was 20%.
  for (const lum of [legacy, laptop]) {
    const p = c.preferenceFromOffset(6, 20, lum)
    near(c.target(20, lum, p), 20, 0.3, `same brightness at the lux it converted at, peak ${lum.peak}`)
  }
  // One no bend can express is held instead: brightness stays where it was.
  assert.equal(c.preferenceFromOffset(-30, 5000, legacy), 0)
  assert.equal(c.legacyPct(-30, 5000), 70)
  assert.equal(c.goal(5000, legacy, 0, { lux: 5000, pct: c.legacyPct(-30, 5000) }), 70)
  assert.equal(c.legacyPct(6, 20), 20)
})

test("the points over the curve, as the chip shows them", () => {
  const p = c.learn(35, 16, legacy)
  assert.equal(c.points(16, legacy, p, null), 35 - Math.round(c.target(16, legacy, 0)))
  assert.equal(c.points(16, legacy, 0, null), 0)
  assert.equal(c.points(16, legacy, 0, { lux: 16, pct: 40 }), 40 - Math.round(c.target(16, legacy, 0)))
  // As the slider shows each side: 7% and 3% are 4 points apart.
  assert.equal(c.points(1, legacy, -0.2, null), Math.round(c.target(1, legacy, -0.2)) - Math.round(c.target(1, legacy, 0)))
})

test("smoothing weighs 0.25 per half second, and follows elapsed time", () => {
  assert.equal(c.smooth(null, 10, 0.5), 10)
  near(c.smooth(10, 20, 0.5), 12.5, 1e-9, "one 0.5 s sample")
  // One late sample after 1 s moves as far as two on time.
  near(c.smooth(10, 20, 1), c.smooth(c.smooth(10, 20, 0.5), 20, 0.5), 1e-9, "1 s vs two 0.5 s")
})

test("a brighter room is accepted only after 4 s above the band; darker after 8 s", () => {
  let st = c.accept({ accepted: null }, 10, 0)
  assert.deepEqual(plain(st), { accepted: 10, dir: 0, since: 0 })
  st = c.accept(st, 90, 0)
  assert.equal(st.accepted, 10)
  assert.equal(st.dir, 1)
  assert.equal(c.accept(st, 90, 3).accepted, 10)
  assert.deepEqual(plain(c.accept(st, 90, 4)), { accepted: 90, dir: 0, since: 4 })
  const dark = { accepted: 100, dir: -1, since: 0 }
  assert.equal(c.accept(dark, 1, 7).accepted, 100)
  assert.equal(c.accept(dark, 1, 8).accepted, 1)
})

test("a caller can set its own debounce times", () => {
  const fast = { brighten: 4, darken: 2 }
  const dark = { accepted: 100, dir: -1, since: 0 }
  assert.equal(c.accept(dark, 1, 1, fast).accepted, 100)
  assert.equal(c.accept(dark, 1, 2, fast).accepted, 1)
  assert.equal(c.accept({ accepted: 10, dir: 1, since: 0 }, 90, 3, fast).accepted, 10)
})

test("a 5% wobble is ignored and resets nothing", () => {
  const st = c.accept({ accepted: 100, dir: 0, since: 0 }, 105, 30)
  assert.deepEqual(plain(st), { accepted: 100, dir: 0, since: 0 })
})

test("a change of direction restarts the debounce", () => {
  let st = c.accept({ accepted: 100, dir: 1, since: 0 }, 50, 3)
  assert.deepEqual(plain(st), { accepted: 100, dir: -1, since: 3 })
})

test("ramp steps: 20 points per 0.5 s up, 6.5 down, small changes at once", () => {
  assert.equal(c.ramp({ brightness: 20, goal: null, span: 0 }, 100, 0.5).brightness, 40)
  assert.equal(c.ramp({ brightness: 40, goal: null, span: 0 }, 5, 0.5).brightness, 33.5)
  assert.equal(c.ramp({ brightness: 9, goal: null, span: 0 }, 5, 0.5).brightness, 5)
})

test("an unknown brightness lands on the goal", () => {
  assert.equal(c.ramp({ brightness: null }, 42, 0.5).brightness, 42)
})

test("a big change finishes within the cap: 2 s up, 3 s down", () => {
  let st = { brightness: 20, goal: null, span: 0 }
  for (let i = 0; i < 4; i++) st = c.ramp(st, 100, 0.5)
  assert.equal(st.brightness, 100)
  st = { brightness: 100, goal: null, span: 0 }
  for (let i = 0; i < 6; i++) st = c.ramp(st, 5, 0.5)
  assert.equal(st.brightness, 5)
  // The cap follows time, not steps: a fade at 60 frames a second takes as long.
  st = { brightness: 20, goal: null, span: 0 }
  for (let i = 0; i < 120; i++) st = c.ramp(st, 100, 1 / 60)
  assert.equal(st.brightness, 100)
})

test("frames follow the write latency, capped at 60 a second", () => {
  assert.equal(c.frameSeconds(0.08), 0.08)
  near(c.frameSeconds(0.004), 1 / 60, 1e-12, "4 ms backlight")
})

test("coarse levels fade linearly", () => {
  // 20 -> 40% in 0.5 s of 80 ms frames: six writes about 3 points apart.
  assert.deepEqual(plain(c.rampFrames(20, 40, 0.5, 0.08, 100)), [23, 27, 30, 33, 37, 40])
  // Too short a fade: 5 -> 6 is one write, not ten.
  assert.deepEqual(plain(c.rampFrames(5, 6, 0.5, 1 / 60, 100)), [6])
})

test("fine levels fade in log luminance, without repeats", () => {
  // 1000 -> 100000 in 2 frames passes the geometric middle, not the linear one.
  assert.deepEqual(plain(c.rampFrames(1000, 100000, 0.5, 0.25, 192000)), [10000, 100000])
  const frames = c.rampFrames(9600, 76800, 0.5, 1 / 60, 192000)
  assert.ok(frames.length >= 29 && frames.length <= 30, `${frames.length} frames`)
  assert.equal(new Set(frames).size, frames.length)
})

test("units and percent convert through the display's levels", () => {
  assert.equal(c.toPct(44160, 192000), 23)
  assert.equal(c.toUnits(23, 192000), 44160)
  assert.equal(c.toUnits(0, 100), 1)
  assert.equal(c.toUnits(140, 100), 100)
})

test("the lowest percent is never raw zero, however coarse the backlight", () => {
  assert.equal(c.toUnits(1, 15), 1)
  assert.equal(c.toUnits(5, 7), 1)
})

test("the first sample after a start steps one sample period, not the whole cap", () => {
  assert.equal(c.stepSeconds(-1, 10), c.config.samplePeriod)
  assert.equal(c.stepSeconds(9.5, 10), 0.5)
  assert.equal(c.stepSeconds(0, 60), 5)
  const step = c.ramp({ brightness: 80, goal: null, span: 0 }, 30, c.stepSeconds(-1, 10))
  // 50 points within the 3 s cap: one sample period's share of it, not 2 s worth.
  const rate = Math.max(c.config.dimRate, 50 / c.config.dimCap)
  near(step.brightness, 80 - rate * c.config.samplePeriod, 1e-9, "after one step")
})

test("a sensor with no good reading for 3 s is stale, but a suspend is not its fault", () => {
  // Checked every sample period, last good reading at 10 s.
  let st = { good: 10, checked: 10 }
  let r
  for (let t = 10.5; t <= 13; t += 0.5) { r = c.sensorCheck(st, t); st = r.state }
  assert.equal(r.stale, false, "3 s without a good reading is the limit")
  r = c.sensorCheck(st, 13.5)
  assert.equal(r.stale, true, "past it")
  // A suspend: 12 s with no check at all. Its clock restarts on waking.
  r = c.sensorCheck({ good: 30, checked: 30.5 }, 42.5)
  assert.equal(r.stale, false)
  assert.equal(r.state.good, 42.5)
  // And then fails for real if nothing good arrives.
  st = r.state
  for (let t = 43; t <= 46; t += 0.5) { r = c.sensorCheck(st, t); st = r.state }
  assert.equal(r.stale, true)
})

let failed = 0
for (const [name, fn] of tests) {
  try { fn(); console.log("ok   " + name) } catch (e) { failed++; console.log("FAIL " + name + "\n     " + e.message) }
}
if (failed) process.exit(1)
