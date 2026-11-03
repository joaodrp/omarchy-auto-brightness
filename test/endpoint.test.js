// Unit tests for Endpoint.js, run with `node test/endpoint.test.js`.
// Endpoint.js is a QML .js file (no exports), so it is evaluated into a
// shared scope the same way the QML engine does it.

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const e = {}
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "Endpoint.js"), "utf8"), e)
const plain = (x) => JSON.parse(JSON.stringify(x))

const tests = []
function test(name, fn) { tests.push([name, fn]) }

// Run the next operation at `now`, completing it at `done` with `ok` and,
// for a read, the value read. Returns { state, op, moved }.
function run(st, now, done = now, ok = true, value) {
  const r = e.next(st, now)
  assert.ok(r.op, `an operation at ${now}`)
  const c = e.complete(r.state, r.op.id, ok, done, value)
  return { state: c.state, op: r.op, moved: c.moved }
}

// An endpoint that read 30 back at t=0 and is idle.
function idle(kind, generation = 1) {
  const r = run(e.create(kind, generation), 0, 0, true, 30)
  assert.equal(r.op.op, "read")
  return r.state
}

test("a new endpoint reads back first", () => {
  const r = e.next(e.create("apple", 1), 0)
  assert.equal(r.op.op, "read")
})

test("an automatic write is preceded by a fresh read-back", () => {
  // Read at 0; an automatic target at 5 must not be written on that old read:
  // a hotkey may have moved the display since.
  let st = e.requestAuto(idle("apple"), 40)
  let r = e.next(st, 5)
  assert.equal(r.op.op, "read")
  const c = e.complete(r.state, r.op.id, true, 5.05, 30)
  r = e.next(c.state, 5.05)
  assert.deepEqual(plain(r.op).op, "write")
  assert.equal(r.op.units, 40)
})

test("a read-back that finds the display moved reports it, and drops the automatic target", () => {
  let st = e.requestAuto(idle("apple"), 40)
  let r = e.next(st, 5)
  const c = e.complete(r.state, r.op.id, true, 5.05, 55)
  assert.equal(c.moved, 55)
  assert.equal(c.state.auto, null)
  assert.equal(c.state.value, 55)
})

test("every automatic write is preceded by its own read-back", () => {
  // A hotkey can land at any moment of a fade; only a read just before each
  // write sees it before it would be overwritten.
  for (const kind of ["apple", "panel", "ddc"]) {
    let st = idle(kind)
    const gap = kind === "ddc" ? 5 : 0.02  // DDC writes the room's changes 5 s apart
    let now = 100, ops = []
    for (let units = 31; units <= 40; units++) {
      st = e.requestAuto(st, units)
      for (let i = 0; i < 2; i++) {
        const r = run(st, now, now + 0.005, true, st.value)
        ops.push(r.op.op)
        st = r.state
        now += 0.005
      }
      now += gap
    }
    assert.deepEqual(ops, Array(10).fill(["read", "write"]).flat(), kind)
  }
})

test("a hotkey press during a fade is seen before the next frame", () => {
  let st = e.requestAuto(idle("panel"), 31)
  st = run(st, 1, 1, true, 30).state           // read
  st = run(st, 1, 1.01).state                  // write 31
  st = e.requestAuto(st, 32)
  const r = e.next(st, 1.02)
  assert.equal(r.op.op, "read")
  const c = e.complete(r.state, r.op.id, true, 1.03, 50)  // the hotkey set 50
  assert.equal(c.moved, 50)
  assert.equal(e.next(c.state, 1.03).op, null)
})

test("a read that started after a write is fresh, even in the same instant", () => {
  // Clocks are coarse: a write and the read after it can share a timestamp.
  let st = e.requestAuto(idle("panel"), 31)
  st = run(st, 1, 1, true, 30).state     // read
  st = run(st, 1, 1).state               // write 31
  st = e.requestAuto(st, 32)
  st = run(st, 1, 1, true, 31).state     // read, same instant
  assert.equal(e.next(st, 1).op.op, "write")
})

test("a user's change is written at once, without a read-back, and replaces the automatic target", () => {
  let st = e.requestAuto(idle("ddc"), 70)
  st = e.requestUser(st, 20)
  assert.equal(st.auto, null)
  const r = e.next(st, 50)
  assert.equal(r.op.op, "write")
  assert.equal(r.op.units, 20)
})

test("an automatic target after a user's change does not inherit its priority", () => {
  let st = e.requestUser(idle("ddc"), 20)
  st = e.requestAuto(st, 70)
  assert.equal(st.user, 20)
  let r = run(st, 1)
  assert.equal(r.op.units, 20)
  // The automatic target now waits for DDC's interval and a fresh read.
  r = e.next(r.state, 2)
  assert.notEqual(r.op && r.op.op, "write")
})

test("DDC: automatic writes at least 5 s apart", () => {
  let st = run(e.requestAuto(idle("ddc"), 40), 1, 1, true, 30).state  // read
  st = run(st, 1, 1.2).state                                           // write 40
  st = e.requestAuto(st, 45)
  const r = e.next(st, 3)
  assert.equal(r.op, null)
  assert.equal(r.wake, 6.2)
})

test("a read that falls due while a write waits on DDC's interval runs now", () => {
  // Written at 1.2; a read-back is asked for at 2, while the next automatic
  // target waits for 6.2. No wake may lie in the past.
  let st = run(e.requestAuto(idle("ddc"), 40), 1, 1.2, true, 30).state
  st = run(st, 1.2, 1.2).state
  st = e.requestAuto(e.requestRead(st), 45)
  const r = e.next(st, 2)
  assert.equal(r.op && r.op.op, "read")
  const after = e.complete(r.state, r.op.id, true, 2.1, 40).state
  const w = e.next(after, 2.1)
  assert.equal(w.op, null)
  assert.equal(w.wake, 6.2)
})

test("idle read-backs follow the kind: 10 s, or 30 s over DDC", () => {
  assert.equal(e.next(idle("panel"), 9.9).wake, 10)
  assert.equal(e.next(idle("panel"), 10).op.op, "read")
  assert.equal(e.next(idle("ddc"), 10).op, null)
  assert.equal(e.next(idle("ddc"), 30).op.op, "read")
})

test("a failure backs off exponentially, capped at a minute, and a user's write is retried", () => {
  let st = e.requestUser(idle("apple"), 40)
  let now = 1
  const waits = []
  for (let i = 0; i < 8; i++) {
    const r = e.next(st, now)
    assert.equal(r.op.units, 40, "the write is retried")
    st = e.complete(r.state, r.op.id, false, now).state
    waits.push(st.writeRetryAt - now)
    now = st.writeRetryAt
  }
  assert.deepEqual(waits, [1, 2, 4, 8, 16, 32, 60, 60])
  st = run(st, now).state
  assert.equal(st.writeFailures, 0)
})

test("a newer request wins over retrying a failed write", () => {
  let st = e.requestUser(idle("apple"), 40)
  const r = e.next(st, 1)
  st = e.requestUser(r.state, 50)
  st = e.complete(st, r.op.id, false, 1.1).state
  assert.equal(st.user, 50)
})

test("a timed-out operation is killed once, and the slot stays busy until it exits", () => {
  let st = e.requestUser(idle("apple"), 40)
  const r = e.next(st, 1)
  st = r.state
  let n = e.next(st, 10.9)
  assert.equal(n.kill, null)
  assert.equal(n.wake, 11)
  n = e.next(st, 11)
  assert.equal(n.kill, r.op.id)
  assert.equal(n.op, null, "nothing overlaps the dying operation")
  assert.equal(n.wake, Infinity, "only its exit can change anything")
  st = e.requestUser(n.state, 50)
  assert.equal(e.next(st, 12).kill, null, "killed once")
  st = e.complete(st, r.op.id, false, 11.2).state
  assert.equal(st.busy, null)
  assert.equal(st.writeFailures, 1)
})

test("an overdue operation never yields a wake in the past", () => {
  const st = e.next(e.requestUser(idle("apple"), 40), 0).state
  const n = e.next(st, 50)
  assert.ok(n.wake >= 50, `wake ${n.wake}`)
})

test("a completion that is not the running operation's is ignored", () => {
  let st = e.requestUser(idle("apple"), 40)
  const a = e.next(st, 1)
  st = e.complete(a.state, a.op.id, true, 1.1).state
  st = e.requestUser(st, 50)
  const b = e.next(st, 1.2)
  const late = e.complete(b.state, a.op.id, true, 1.3)
  assert.equal(late.state, b.state)
  assert.notEqual(a.op.id, b.op.id)
})

test("cancelling auto during an automatic write stops its retry", () => {
  let st = e.requestAuto(idle("apple"), 40)
  st = run(st, 1, 1, true, 30).state
  const w = e.next(st, 1)
  assert.equal(w.op.op, "write")
  st = e.cancelAuto(w.state)
  st = e.complete(st, w.op.id, false, 1.1).state
  assert.equal(st.auto, null)
})

test("failing writes back off even while reads succeed", () => {
  let st = idle("panel")
  let now = 1
  const waits = []
  for (let i = 0; i < 4; i++) {
    st = e.requestAuto(st, 40)
    let r = e.next(st, now)
    if (r.op.op === "read") { st = e.complete(r.state, r.op.id, true, now, 30).state; r = e.next(st, now) }
    assert.equal(r.op.op, "write")
    st = e.complete(r.state, r.op.id, false, now).state
    waits.push(st.writeRetryAt - now)
    now = st.writeRetryAt
  }
  assert.deepEqual(waits, [1, 2, 4, 8])
})

test("ids are unique across endpoints of different generations", () => {
  const a = e.next(e.create("apple", 1), 0).op.id
  const b = e.next(e.create("apple", 2), 0).op.id
  assert.notEqual(a, b)
  const replacement = e.next(e.create("apple", 2), 0)
  assert.equal(e.complete(replacement.state, a, true, 0.1, 30).state, replacement.state)
})

test("failing reads do not hold back a user's change", () => {
  let st = idle("apple")
  let now = 10
  for (let i = 0; i < 7; i++) {
    const r = e.next(st, now)
    assert.equal(r.op.op, "read")
    st = e.complete(r.state, r.op.id, false, now).state
    now = st.readRetryAt
  }
  const r = e.next(e.requestUser(st, 50), st.readRetryAt - 30)
  assert.equal(r.op && r.op.op, "write")
})

test("a read already running does not answer a newer read request", () => {
  // A read starts, the machine sleeps and wakes, a read is requested: the
  // running read's value predates the wake and authorizes nothing.
  let st = e.requestAuto(idle("apple"), 40)
  const r = e.next(st, 1)
  assert.equal(r.op.op, "read")
  st = e.requestRead(r.state)
  st = e.complete(st, r.op.id, true, 1.05, 30).state
  assert.equal(e.next(st, 1.05).op.op, "read")
})

test("a killed operation counts as failed, however it exits", () => {
  let st = e.requestUser(idle("apple"), 40)
  const r = e.next(st, 1)
  st = e.next(r.state, 11).state
  st = e.complete(st, r.op.id, true, 11.1).state
  assert.equal(st.writeFailures, 1)
  assert.equal(st.user, 40, "retried")
  assert.equal(st.value, 30, "not taken as written")
})

test("cancelAuto drops the automatic target, and requestRead makes a read-back due", () => {
  let st = e.cancelAuto(e.requestAuto(idle("ddc"), 40))
  assert.equal(st.auto, null)
  assert.equal(e.next(e.requestRead(idle("ddc")), 1).op.op, "read")
})

let failed = 0
for (const [name, fn] of tests) {
  try { fn(); console.log("ok   " + name) } catch (err) { failed++; console.log("FAIL " + name + "\n     " + err.message) }
}
if (failed) process.exit(1)
