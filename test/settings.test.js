// Unit tests for Settings.js, run with `node test/settings.test.js`.
// Settings.js is a QML .js file (no exports), so it is evaluated into a
// shared scope the same way the QML engine does it.

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const s = {}
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "Settings.js"), "utf8"), s)
// vm-realm values fail strict deepEqual on prototype identity.
const plain = (x) => JSON.parse(JSON.stringify(x))

const tests = []
function test(name, fn) { tests.push([name, fn]) }

// Settings with display A's preference `pa` and auto `aa` where given.
const A = JSON.stringify(["Apple Computer Inc", "StudioDisplay", "0x0000A001"])
const B = "internal"
// The switches at their defaults unless `extra` sets them.
const SWITCHES = { screens: true, keyboard: false, keyboardAuto: true }
function cfg(auto, pa, extra = {}) {
  const displays = {}
  if (pa !== undefined) displays[A] = { preference: pa }
  return { auto, ...SWITCHES, displays, ...extra }
}
const prefOf = (settings, id = A) => s.displaySettings(settings, id).preference

// Feed config events in order; return how many changed the held settings,
// and the final state.
function events(state, list) {
  let changes = 0
  for (const next of list) {
    const r = s.configEvent(state, next)
    state = r.state
    if (r.changed) changes++
  }
  return { state, changes }
}

test("read applies the defaults and drops what it cannot use", () => {
  assert.deepEqual(plain(s.read(undefined)), { auto: true, ...SWITCHES, displays: {} })
  assert.deepEqual(plain(s.read({ auto: false, offset: 7 })), { auto: false, ...SWITCHES, displays: {}, offset: 7 })
  assert.deepEqual(plain(s.read({ offset: 0 })), { auto: true, ...SWITCHES, displays: {} })
  const r = s.read({ displays: { [A]: { auto: false, preference: 0.125, junk: 1 }, bad: 3, [B]: { preference: "x" } } })
  assert.deepEqual(plain(r.displays), { [A]: { auto: false, preference: 0.125 }, [B]: {} })
})

test("a display runs with its own record over the defaults", () => {
  const settings = { auto: false, displays: { [A]: { auto: true, preference: 0.2 } } }
  assert.deepEqual(plain(s.displaySettings(settings, A)), { auto: true, preference: 0.2 })
  assert.deepEqual(plain(s.displaySettings(settings, B)), { auto: false, preference: 0 })
})

test("display ids may hold the path separator", () => {
  const id = JSON.stringify(["Odd/Make", "M/1", ""]) + "@DP-3"
  const r = s.own(s.start(cfg(true)), { displays: { [id]: { preference: 0.05 } } })
  assert.equal(prefOf(r.state.held, id), 0.05)
})

test("a restarted service keeps the held settings, not a lagging config", () => {
  let st = s.start(cfg(true))
  st = s.own(st, { displays: { [A]: { preference: 0.13 } } }).state
  const again = s.start(cfg(true), st)
  assert.equal(prefOf(again.held), 0.13)
  assert.equal(events(again, [cfg(true), cfg(true, 0.13)]).changes, 0)
})

test("re-published config changes nothing", () => {
  assert.equal(events(s.start(cfg(true, 0.03)), Array(24).fill(cfg(true, 0.03))).changes, 0)
})

test("a learned preference is not undone, however late its echo", () => {
  // Learned +13, then -2, before the shell reports either: first the old
  // config, then each write in turn.
  let st = s.start(cfg(true))
  st = s.own(st, { displays: { [A]: { preference: 0.13 } } }).state
  st = s.own(st, { displays: { [A]: { preference: -0.02 } } }).state
  const r = events(st, [cfg(true), cfg(true), cfg(true, 0.13), cfg(true, -0.02)])
  assert.equal(r.changes, 0)
  assert.equal(prefOf(r.state.held), -0.02)
})

test("an own action changes the held settings at once and its echo is ignored", () => {
  let r = s.own(s.start(cfg(true, 0.2)), { displays: { [A]: { preference: null } } })
  assert.equal(r.changed, true)
  assert.equal(prefOf(r.state.held), 0)
  r = s.own(r.state, { displays: { [A]: { auto: false } } })
  assert.equal(events(r.state, [cfg(true, 0.2), cfg(true), { auto: true, displays: { [A]: { auto: false } } }]).changes, 0)
})

test("a change made elsewhere is adopted", () => {
  const r = events(s.start(cfg(true, 0.04)), [cfg(true, 0.04), cfg(false, 0.09)])
  assert.equal(r.changes, 1)
  assert.deepEqual(plain(r.state.held), cfg(false, 0.09))
})

test("a change made elsewhere keeps a learned preference it did not touch", () => {
  // Learned +13; before its echo, Setup turns the default auto off from a
  // config that still lacks the preference. Only auto changed there.
  let st = s.start(cfg(true))
  st = s.own(st, { displays: { [A]: { preference: 0.13 } } }).state
  const r = s.configEvent(st, cfg(false))
  assert.deepEqual(plain(r.state.held), cfg(false, 0.13))
  // The config lost the preference, so it is written back, as held, later.
  assert.equal(r.restore, true)
  const back = s.own(r.state, {})
  assert.deepEqual(plain(back.persist), cfg(false, 0.13))
  assert.equal(back.changed, false)
  // The late echo of the learned write, then of the write-back, change nothing.
  const after = events(back.state, [cfg(true, 0.13), cfg(false, 0.13)])
  assert.equal(after.changes, 0)
  assert.deepEqual(plain(after.state.held), cfg(false, 0.13))
  assert.equal(after.state.pending.length, 0)
})

test("one display's change elsewhere leaves another display's alone", () => {
  // Learned +13 on A; before its echo, someone edits B's preference.
  let st = s.start(cfg(true))
  st = s.own(st, { displays: { [A]: { preference: 0.13 } } }).state
  const edited = { auto: true, displays: { [B]: { preference: 0.07 } } }
  const r = s.configEvent(st, edited)
  assert.equal(prefOf(r.state.held, A), 0.13)
  assert.equal(prefOf(r.state.held, B), 0.07)
  assert.equal(r.restore, true)
})

test("a write-back superseded before it is made leaves no false echo", () => {
  // The write-back of (off, 13) is due, but Setup sets 5 first, so the
  // write-back finds nothing to write. Later real edits must all land.
  let st = s.start(cfg(true))
  st = s.own(st, { displays: { [A]: { preference: 0.13 } } }).state
  let r = s.configEvent(st, cfg(false))
  r = s.configEvent(r.state, cfg(false, 0.05))
  assert.equal(prefOf(r.state.held), 0.05)
  const back = s.own(r.state, {})
  assert.deepEqual(plain(back.persist), cfg(false, 0.05))
  assert.equal(back.state.pending.length, 0)
  const after = events(back.state, [cfg(false, 0.05), cfg(false, 0.13), cfg(false, 0.05)])
  assert.equal(after.changes, 2)
  assert.equal(prefOf(after.state.held), 0.05)
})

test("echoes match the oldest write they equal, overtaken or not", () => {
  // Learn 13, Setup turns auto off, the write-back lands, then the user turns
  // auto on: (on, 13) is both an overtaken write and the latest one.
  let st = s.start(cfg(true))
  st = s.own(st, { displays: { [A]: { preference: 0.13 } } }).state
  st = s.configEvent(st, cfg(false)).state
  st = s.own(st, {}).state
  st = s.own(st, { auto: true }).state
  const after = events(st, [cfg(true, 0.13), cfg(false, 0.13), cfg(true, 0.13)])
  assert.equal(after.changes, 0)
  assert.deepEqual(plain(after.state.held), cfg(true, 0.13))
})

test("a field changed elsewhere wins over a pending write to it", () => {
  let st = s.start(cfg(true))
  st = s.own(st, { displays: { [A]: { preference: 0.13 } } }).state
  const r = s.configEvent(st, cfg(true, 0.05))
  assert.equal(prefOf(r.state.held), 0.05)
  assert.equal(r.restore, undefined)
})

test("an action that changes nothing leaves no pending echo", () => {
  let st = s.start(cfg(true))
  st = s.own(st, { displays: { [A]: { preference: null } } }).state
  st = s.own(st, { auto: true }).state
  assert.equal(st.pending.length, 0)
  assert.equal(events(st, [cfg(true, 0.05), cfg(true)]).changes, 2)
})

test("repeating the latest pending write queues nothing", () => {
  let st = s.start(cfg(true))
  st = s.own(st, { displays: { [A]: { preference: 0.13 } } }).state
  st = s.own(st, { displays: { [A]: { preference: 0.13 } } }).state
  assert.equal(st.pending.length, 1)
})

test("every pending write is an echo, however many", () => {
  let st = s.start(cfg(true))
  for (let i = 1; i <= 50; i++) st = s.own(st, { displays: { [A]: { preference: i / 100 } } }).state
  const r = events(st, [cfg(true, 0.01), cfg(true, 0.02), cfg(true, 0.3), cfg(true, 0.5)])
  assert.equal(r.changes, 0)
  assert.equal(prefOf(r.state.held), 0.5)
  assert.equal(r.state.pending.length, 0)
})

test("migrating the old offset removes it in the same write", () => {
  let st = s.start(s.read({ auto: true, offset: 6 }))
  const r = s.own(st, { offset: null, displays: { [A]: { preference: 0.43 } } })
  assert.equal(r.persist.offset, undefined)
  assert.equal(prefOf(r.persist), 0.43)
})

test("the entry written keeps unrelated keys and drops a migrated offset", () => {
  const entry = { id: "x", auto: true, offset: 6, other: 1 }
  const out = s.entryWith(entry, cfg(false, 0.43))
  assert.deepEqual(plain(out), { id: "x", other: 1, auto: false, ...SWITCHES, displays: { [A]: { preference: 0.43 } } })
})

test("a preference outside [-1, 1] is not read: not one Control.js could have learned", () => {
  const read = (pref) => plain(s.read({ displays: { [A]: { auto: true, preference: pref } } })).displays[A]
  assert.deepEqual(read(0.599), { auto: true, preference: 0.599 })
  assert.deepEqual(read(-1), { auto: true, preference: -1 })
  assert.deepEqual(read(114.29), { auto: true })
  assert.deepEqual(read(-1.5), { auto: true })
})

test("the legacy offset belongs to the display the old controller drove, never a DDC one", () => {
  const apple = { id: A, kind: "apple", active: true }
  const panel = { id: B, kind: "panel", active: true }
  const ddc = { id: "dell", kind: "ddc", active: true }
  assert.equal(s.legacyOwner([panel, ddc, apple]), A)
  assert.equal(s.legacyOwner([ddc, panel]), B)
  assert.equal(s.legacyOwner([{ ...apple, active: false }, panel]), B)
  assert.equal(s.legacyOwner([ddc]), null)
  assert.equal(s.legacyOwner([]), null)
})

test("screens default on, the keyboard off and its Auto on; only booleans are read", () => {
  const r = plain(s.read({ screens: false, keyboard: true, keyboardAuto: false }))
  assert.deepEqual([r.screens, r.keyboard, r.keyboardAuto], [false, true, false])
  const junk = plain(s.read({ screens: "no", keyboard: 1, keyboardAuto: null }))
  assert.deepEqual([junk.screens, junk.keyboard, junk.keyboardAuto], [true, false, true])
})

test("the switches are ours to change and are persisted", () => {
  const r = s.own(s.start(cfg(true)), { keyboard: true, keyboardAuto: false })
  assert.equal(r.changed, true)
  assert.deepEqual([r.persist.keyboard, r.persist.keyboardAuto, r.persist.screens], [true, false, true])
  const out = s.entryWith({ id: "x", screens: true, keyboard: false }, r.persist)
  assert.deepEqual([out.id, out.screens, out.keyboard, out.keyboardAuto], ["x", true, true, false])
})

test("a switch flipped in Setup merges with a pending write of ours", () => {
  let st = s.start(cfg(true))
  st = s.own(st, { displays: { [A]: { preference: 0.2 } } }).state
  // Setup turns the keyboard on from a config that predates our write.
  const r = s.configEvent(st, cfg(true, undefined, { keyboard: true }))
  assert.equal(r.changed, true)
  assert.equal(r.state.held.keyboard, true)
  assert.equal(prefOf(r.state.held), 0.2)
  assert.equal(r.restore, true)
})

const ID = "io.github.joaodrp.auto-brightness"

test("entry: found in any section, Omarchy 4.0's or 4.5's", () => {
  for (const section of ["left", "center", "right", "centerBegin", "centerEnd", "tray"]) {
    const layout = { left: [{ id: "omarchy.menu" }], [section]: [{ id: "omarchy.clock" }, { id: ID, keyboard: true }] }
    assert.deepEqual(plain(s.entry(layout, ID)), { id: ID, keyboard: true }, section)
  }
})

test("entry: a section added later is searched too", () => {
  assert.deepEqual(plain(s.entry({ someday: [{ id: ID, auto: false }] }, ID)), { id: ID, auto: false })
})

test("entry: duplicates resolve in the bar's order, not the file's", () => {
  const layout = { tray: [{ id: ID, auto: 1 }], right: [{ id: ID, auto: 2 }], center: [{ id: ID, auto: 3 }], centerBegin: [{ id: ID, auto: 4 }], left: [{ id: ID, auto: 5 }] }
  assert.equal(s.entry(layout, ID).auto, 5)
  delete layout.left
  assert.equal(s.entry(layout, ID).auto, 4)
  assert.equal(s.entry({ someday: [{ id: ID, auto: 1 }], tray: [{ id: ID, auto: 2 }] }, ID).auto, 2)
})

test("entry: none, a bare id or a malformed layout reads as no settings", () => {
  assert.deepEqual(plain(s.entry({ right: [{ id: "omarchy.audio" }] }, ID)), {})
  assert.deepEqual(plain(s.entry({ right: [ID] }, ID)), {})
  assert.deepEqual(plain(s.entry({ right: null, tray: "x", left: [null, 3] }, ID)), {})
  assert.deepEqual(plain(s.entry(undefined, ID)), {})
})

let failed = 0
for (const [name, fn] of tests) {
  try { fn(); console.log("ok   " + name) } catch (e) { failed++; console.log("FAIL " + name + "\n     " + e.message) }
}
if (failed) process.exit(1)
