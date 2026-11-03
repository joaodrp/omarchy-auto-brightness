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

const cfg = (auto, offset) => ({ auto, offset })

// Feed config events in order; return the lines sent and the final state.
function events(state, list) {
  const sent = []
  for (const next of list) {
    const r = s.configEvent(state, next)
    state = r.state
    sent.push(...r.lines)
  }
  return { state, sent: plain(sent) }
}

test("read applies the defaults", () => {
  assert.deepEqual(plain(s.read(undefined)), cfg(true, 0))
  assert.deepEqual(plain(s.read({ auto: false, offset: 7 })), cfg(false, 7))
  assert.deepEqual(plain(s.read({ offset: 2.5 })), cfg(true, 0))
})

test("a controller start sends everything", () => {
  assert.deepEqual(plain(s.start(cfg(true, 3)).lines), ["auto on", "offset 3"])
})

test("a restarted controller gets the held settings, not a lagging config", () => {
  let st = s.start(cfg(true, 0)).state
  st = s.own(st, { offset: 13 }).state
  const r = s.start(cfg(true, 0), st)
  assert.deepEqual(plain(r.lines), ["auto on", "offset 13"])
  assert.deepEqual(events(r.state, [cfg(true, 0), cfg(true, 13)]).sent, [])
})

test("re-published config sends nothing", () => {
  const st = s.start(cfg(true, 3)).state
  assert.deepEqual(events(st, Array(24).fill(cfg(true, 3))).sent, [])
})

test("a learned offset is not pushed back, however late its echo", () => {
  // The controller learns +13, then -2, before the shell reports either:
  // first the old config, then each write in turn.
  let st = s.start(cfg(true, 0)).state
  st = s.own(st, { offset: 13 }).state
  st = s.own(st, { offset: -2 }).state
  const r = events(st, [cfg(true, 0), cfg(true, 0), cfg(true, 13), cfg(true, -2)])
  assert.deepEqual(r.sent, [])
  assert.deepEqual(plain(r.state.held), cfg(true, -2))
})

test("an own action is sent at once and its echo is ignored", () => {
  let st = s.start(cfg(true, 20)).state
  let r = s.own(st, { offset: 0 })
  assert.deepEqual(plain(r.lines), ["offset 0"])
  r = s.own(r.state, { auto: false })
  assert.deepEqual(plain(r.lines), ["auto off"])
  assert.deepEqual(events(r.state, [cfg(true, 20), cfg(true, 0), cfg(false, 0)]).sent, [])
})

test("a change made elsewhere is adopted and sent", () => {
  const st = s.start(cfg(true, 4)).state
  const r = events(st, [cfg(true, 4), cfg(false, 9)])
  assert.deepEqual(r.sent, ["auto off", "offset 9"])
  assert.deepEqual(plain(r.state.held), cfg(false, 9))
})

test("a change made elsewhere keeps a learned offset it did not touch", () => {
  // The controller learns +13; before its echo, Setup turns auto off from a
  // config that still reads offset 0. Only auto changed there.
  let st = s.start(cfg(true, 0)).state
  st = s.own(st, { offset: 13 }).state
  const r = s.configEvent(st, cfg(false, 0))
  assert.deepEqual(plain(r.lines), ["auto off"])
  assert.deepEqual(plain(r.state.held), cfg(false, 13))
  // The config lost the offset, so it is written back.
  assert.deepEqual(plain(r.persist), cfg(false, 13))
  // The late echo of the learned write, then of the write-back, change nothing.
  const after = events(r.state, [cfg(true, 13), cfg(false, 13)])
  assert.deepEqual(after.sent, [])
  assert.deepEqual(plain(after.state.held), cfg(false, 13))
  assert.equal(after.state.pending.length, 0)
})

test("a field changed elsewhere wins over a pending write to it", () => {
  let st = s.start(cfg(true, 0)).state
  st = s.own(st, { offset: 13 }).state
  const r = s.configEvent(st, cfg(true, 5))
  assert.deepEqual(plain(r.lines), ["offset 5"])
  assert.deepEqual(plain(r.state.held), cfg(true, 5))
  assert.equal(r.persist, undefined)
})

test("an action that changes nothing leaves no pending echo", () => {
  // The config already reads offset 0, so `forget` writes nothing and no
  // echo will come. A later change elsewhere to 5 and back to 0 is real.
  let st = s.start(cfg(true, 0)).state
  st = s.own(st, { offset: 0 }).state
  st = s.own(st, { auto: true }).state
  assert.equal(st.pending.length, 0)
  assert.deepEqual(events(st, [cfg(true, 5), cfg(true, 0)]).sent, ["offset 5", "offset 0"])
})

test("repeating the latest pending write queues nothing", () => {
  let st = s.start(cfg(true, 0)).state
  st = s.own(st, { offset: 13 }).state
  st = s.own(st, { offset: 13 }).state
  assert.equal(st.pending.length, 1)
})

test("every pending write is an echo, however many", () => {
  // 50 learned offsets before the shell reports any; then its echoes, oldest
  // first. None may reach the controller, and the last retires them all.
  let st = s.start(cfg(true, 0)).state
  for (let i = 1; i <= 50; i++) st = s.own(st, { offset: i }).state
  const echoes = [cfg(true, 1), cfg(true, 2), cfg(true, 30), cfg(true, 50)]
  const r = events(st, echoes)
  assert.deepEqual(r.sent, [])
  assert.deepEqual(plain(r.state.held), cfg(true, 50))
  assert.equal(r.state.pending.length, 0)
})

test("a status from before the last command teaches nothing", () => {
  // Reset sent `offset 0` as the 7th line; a status still showing +3 was
  // written before the controller read it.
  assert.equal(s.learnedOffset({ offset: 3, seen: 6 }, 7, 0), null)
  assert.equal(s.learnedOffset({ offset: 0, seen: 7 }, 7, 0), null)
})

test("a caught-up status with a new offset was learned", () => {
  assert.equal(s.learnedOffset({ offset: 20, seen: 8 }, 8, 0), 20)
  assert.equal(s.learnedOffset({ seen: 8 }, 8, 0), null)
})

let failed = 0
for (const [name, fn] of tests) {
  try { fn(); console.log("ok   " + name) } catch (e) { failed++; console.log("FAIL " + name + "\n     " + e.message) }
}
if (failed) process.exit(1)
