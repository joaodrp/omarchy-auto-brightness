// Pure, Qt-free scheduling for one brightness endpoint, a display's or the
// keyboard's, so it runs under node too (test/endpoint.test.js). The
// service runs the operations it returns (a helper process per write or
// read) and reports each completion.
//
// One operation runs at a time, each with its own id; a completion that is
// not the running operation's is ignored. Two targets wait their turn, apart:
//   user  a change the user made: written at once, as soon as the endpoint
//         is free, and it replaces the automatic target
//   auto  the room's latest target: written only after a read-back of its
//         own, so a hotkey press is seen rather than overwritten, and on DDC
//         only so often
// A read-back that finds the display moved by someone else reports it as
// `moved` and drops the automatic target; the caller adopts the new value.
// Failures back off exponentially, apart for reads and writes, so working
// reads do not hide failing writes and failing reads do not hold back the
// user. An operation past its timeout is to be killed, and the endpoint
// stays busy until it exits; however it exits, it failed. A read answers
// only the read requests made before it started.
//
// Policy per kind:
//   fade      write a ramp frame by frame, or only the final value
//   interval  least seconds between automatic writes
//   readEvery seconds between read-backs while idle
//   timeout   seconds an operation may take

var policies = {
  apple: { fade: true, interval: 0, readEvery: 10, timeout: 10 },
  panel: { fade: true, interval: 0, readEvery: 10, timeout: 10 },
  // A keyboard LED through brightnessctl, read from sysfs, as a panel is.
  keyboard: { fade: true, interval: 0, readEvery: 10, timeout: 10 },
  // DDC/CI is slow, a write is not verified, and some monitors keep every
  // change in non-volatile memory: no fade, and changes far apart.
  ddc: { fade: false, interval: 5, readEvery: 30, timeout: 10 }
}

var maxBackoff = 60
var freshRead = 0.5  // seconds a read-back, made since the last write, stays good for one

// `generation` tells this endpoint's operations from those of any earlier
// one for the same display.
function create(kind, generation) {
  return {
    policy: policies[kind],
    generation: generation,
    nextId: 1,
    busy: null,          // { id, op, from, units, started, killed } while one runs
    user: null,          // units waiting, the user's
    auto: null,          // units waiting, the room's
    value: null,         // units last written or read; null until known
    lastWrite: -Infinity,
    lastRead: -Infinity,
    // Which operation, in start order, last wrote and last read: clocks are
    // too coarse to tell a write from the read just after it.
    writeSeq: 0,
    readSeq: 0,
    readEpoch: 0,        // read requests so far; a read started before the latest answers none
    readFailures: 0,
    writeFailures: 0,
    readRetryAt: -Infinity,
    writeRetryAt: -Infinity
  }
}

function copy(state, changes) {
  var next = {}
  for (var k in state) next[k] = state[k]
  for (var c in changes) next[c] = changes[c]
  return next
}

function requestUser(state, units) { return copy(state, { user: units, auto: null }) }
function requestAuto(state, units) { return copy(state, { auto: units }) }
// Drop the automatic target, and any retry of the automatic write running.
function cancelAuto(state) {
  var busy = state.busy && state.busy.from === "auto" ? copy(state.busy, { from: null }) : state.busy
  return copy(state, { auto: null, busy: busy })
}

// Make a read-back due at once: on attach, on wake, and whenever the value
// may have changed behind our back.
function requestRead(state) { return copy(state, { lastRead: -Infinity, readEpoch: state.readEpoch + 1 }) }

// `from` is "user" or "auto" for a write: the target it takes.
function start(state, op, from, now) {
  var units = from ? state[from] : null
  var busy = { id: state.generation + ":" + state.nextId, seq: state.nextId, op: op, from: from, units: units, epoch: state.readEpoch, started: now, killed: false }
  var changes = { busy: busy, nextId: state.nextId + 1 }
  if (from) changes[from] = null
  return { state: copy(state, changes), op: { id: busy.id, op: op, units: units }, kill: null, wake: now + state.policy.timeout }
}

// What to do at `now`: { state, op, kill, wake }. `op` is null or
// { id, op: "write" | "read", units } to start; `kill` is null or the id of
// the running operation, past its timeout, to kill, once; `wake` is the next
// time worth asking again, or Infinity when only a request or completion can
// change anything.
function next(state, now) {
  var p = state.policy
  var busy = state.busy
  if (busy) {
    var deadline = busy.started + p.timeout
    if (busy.killed) return { state: state, op: null, kill: null, wake: Infinity }
    if (now < deadline) return { state: state, op: null, kill: null, wake: deadline }
    return { state: copy(state, { busy: copy(busy, { killed: true }) }), op: null, kill: busy.id, wake: Infinity }
  }
  var canRead = now >= state.readRetryAt
  var wakes = []
  if (state.user !== null) {
    if (now >= state.writeRetryAt) return start(state, "write", "user", now)
    wakes.push(state.writeRetryAt)
  }
  var readDue = state.lastRead + p.readEvery
  var needRead = now >= readDue
  if (state.auto !== null) {
    var writable = Math.max(state.lastWrite + p.interval, state.writeRetryAt)
    if (now >= writable) {
      if (state.readSeq > state.writeSeq && now - state.lastRead <= freshRead) return start(state, "write", "auto", now)
      needRead = true
    } else {
      wakes.push(writable)
    }
  }
  if (needRead) {
    if (canRead) return start(state, "read", null, now)
    wakes.push(state.readRetryAt)
  } else {
    wakes.push(readDue)
  }
  return { state: state, op: null, kill: null, wake: Math.min.apply(null, wakes) }
}

// The operation `id` finished: `ok`, and for a read the units read.
// Returns { state, moved }, `moved` the units someone else set, or null.
function complete(state, id, ok, now, value) {
  var busy = state.busy
  if (!busy || busy.id !== id) return { state: state, moved: null }
  if (!ok || busy.killed) {
    var kind = busy.op === "write" ? "write" : "read"
    var failures = state[kind + "Failures"] + 1
    var changes = { busy: null }
    changes[kind + "Failures"] = failures
    changes[kind + "RetryAt"] = now + Math.min(maxBackoff, Math.pow(2, failures - 1))
    // A failed write is retried, as the target it was, unless a newer one
    // replaced it. A newer user target replaces either.
    if (busy.from && state.user === null && state[busy.from] === null) changes[busy.from] = busy.units
    return { state: copy(state, changes), moved: null }
  }
  if (busy.op === "write")
    return { state: copy(state, { busy: null, writeFailures: 0, value: busy.units, lastWrite: now, writeSeq: busy.seq }), moved: null }
  if (busy.epoch !== state.readEpoch) return { state: copy(state, { busy: null, readFailures: 0 }), moved: null }
  var moved = state.value !== null && value !== state.value ? value : null
  var read = { busy: null, readFailures: 0, value: value, lastRead: now, readSeq: busy.seq }
  if (moved !== null) read.auto = null
  return { state: copy(state, read), moved: moved }
}
