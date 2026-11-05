// Unit tests for Keyboard.js, run with `node test/keyboard.test.js`.
// Keyboard.js is a QML .js file that imports Control.js; its `.import` line
// is dropped and Control.js evaluated into its scope in its place.

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8")
const c = {}
vm.runInNewContext(read("Control.js"), c)
const k = { Control: c }
vm.runInNewContext(read("Keyboard.js").replace(/^\.import .*$/gm, ""), k)

const tests = []
function test(name, fn) { tests.push([name, fn]) }

// A keyboard resumed at `t0` and past its settle time, its light accepted.
function settled(lux, t0 = 0) {
  let s = k.resume(k.create(), t0)
  s = k.sample(s, lux, t0 + k.config.settle)
  return s
}
const after = () => k.config.settle + 1

test("the curve lights the keys in the dark and turns them off in a lit room", () => {
  assert.equal(k.level(0, false).pct, 50)
  assert.ok(k.level(10, false).pct > k.level(20, false).pct)
  assert.deepEqual({ ...k.level(200, true) }, { on: false, pct: 0 })
})

test("on and off have separate thresholds, so the edge does not flicker", () => {
  // Off, the room must be darker than onBelow to light the keys.
  assert.equal(k.level(40, false).on, false)
  assert.equal(k.level(25, false).on, true)
  // On, they stay lit until the room is brighter than offAbove.
  assert.equal(k.level(40, true).on, true)
  assert.equal(k.level(70, true).on, false)
  assert.ok(k.level(40, true).pct > 0)
})

test("a darker room is accepted sooner than a brighter one", () => {
  let s = settled(100)
  const t = k.config.settle
  s = k.sample(s, 5, t + 1)
  s = k.sample(s, 5, t + 1 + k.config.debounce.darken)
  assert.equal(s.accepted.accepted, 5)
  assert.ok(k.config.debounce.darken < c.config.darkenDebounce)
})

test("nothing is driven while paused or settling, or before light is known", () => {
  assert.equal(k.goal(k.create(), 100, true), null)
  let s = k.resume(k.create(), 0)
  assert.equal(k.goal(s, k.config.settle / 2, true), null)
  s = k.sample(s, 10, k.config.settle / 2)
  assert.equal(k.goal(s, k.config.settle / 2, true), null, "settling")
  assert.equal(k.goal(s, after(), true), k.level(10, false).pct)
  assert.equal(k.goal(k.pause(s), after(), true), null)
})

test("after a pause the light is read afresh, not debounced from before", () => {
  let s = k.pause(settled(10))
  s = k.resume(s, 100)
  s = k.sample(s, 200, 101)
  assert.equal(s.accepted.accepted, 200)
  assert.equal(k.goal(s, 100 + k.config.settle, true), 0)
})

test("with Auto off nothing is driven", () => {
  assert.equal(k.goal(settled(10), after(), false), null)
})

test("a restore seen while settling is a baseline, not a choice", () => {
  // Unlock: Omarchy restores a stale level just after the pause ends.
  const settle = k.config.settle
  let s = k.resume(k.create(), 0)
  s = k.sample(s, 10, settle / 4)
  s = k.observed(s, 80, settle / 2)
  assert.equal(s.held, null)
  assert.equal(k.goal(s, after(), true), k.level(10, false).pct)
})

test("a hotkey once settled is held, cycle to off included", () => {
  let s = settled(10)
  s = k.observed(s, 0, after())
  assert.equal(k.goal(s, after(), true), 0)
  s = k.observed(s, 30, after())
  assert.equal(k.goal(s, after(), true), 30)
})

test("a hold lasts whatever the light does, until a pause, and is never kept", () => {
  let s = settled(10)
  s = k.chose(s, 0)
  // Far brighter, then dark again, after the debounce: still held.
  const t = after()
  s = k.sample(s, 500, t + 1)
  s = k.sample(s, 500, t + 1 + k.config.debounce.brighten)
  assert.equal(k.goal(s, t + 10, true), 0)
  s = k.sample(s, 1, t + 11)
  s = k.sample(s, 1, t + 11 + k.config.debounce.darken)
  assert.equal(k.goal(s, t + 20, true), 0)
  // A lock, the lid or sleep drops it: nothing outlives a pause.
  assert.equal(k.pause(s).held, null)
})

test("a choice before any light is accepted is held all the same", () => {
  let s = k.resume(k.create(), 0)
  s = k.chose(s, 35)
  s = k.sample(s, 10, after())
  assert.equal(k.goal(s, after(), true), 35)
})

test("units reach zero, so the keys can be turned off", () => {
  assert.equal(k.toUnits(0, 100), 0)
  assert.equal(k.toUnits(-5, 3), 0)
  assert.equal(k.toUnits(50, 3), 2)
  assert.equal(k.toUnits(140, 100), 100)
  assert.equal(k.toPct(1, 3), 33)
})

test("any level above off lights a keyboard with few steps", () => {
  // The curve's dimmest lit level, and a slider nudge, on 1- and 2-step LEDs.
  for (const levels of [1, 2, 3]) {
    assert.equal(k.toUnits(k.level(29, true).pct, levels), 1, `levels ${levels}`)
    assert.equal(k.toUnits(1, levels), 1, `levels ${levels}`)
    assert.equal(k.toUnits(0, levels), 0, `levels ${levels}`)
  }
  assert.equal(k.toUnits(40, 1), 1)
  assert.equal(k.toUnits(20, 100), 20)
  assert.equal(k.toUnits(50, 0), 0)
})

test("a fade is linear, reaches off, skips repeats and keeps its pace", () => {
  const units = (frames) => [...frames.map((f) => f.units)]
  assert.deepEqual(units(k.fade(30, 0)), [27, 24, 21, 18, 15, 12, 9, 6, 3, 0])
  assert.deepEqual(units(k.fade(2, 2)), [])
  // A coarse change still takes the whole fade: each step at its frame.
  const coarse = k.fade(0, 2)
  assert.deepEqual(units(coarse), [1, 2])
  assert.ok(coarse[0].at > 0)
  assert.ok(coarse[1].at - coarse[0].at >= k.config.fadeSeconds / 2 - 1e-9)
})

test("forget drops the hold", () => {
  const s = k.forget(k.chose(settled(10), 20))
  assert.equal(k.goal(s, after(), true), k.level(10, false).pct)
})

let failed = 0
for (const [name, fn] of tests) {
  try { fn(); console.log("ok   " + name) } catch (e) { failed++; console.log("FAIL " + name + "\n     " + e.message) }
}
if (failed) process.exit(1)
