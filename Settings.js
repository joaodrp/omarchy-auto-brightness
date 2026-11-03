// Pure, Qt-free settings logic, so it runs under node too
// (test/settings.test.js). Service.qml owns the controller process.
//
// The service holds the settings and is their only writer apart from Setup
// or a hand edit. Its own changes go to the controller at once; the config
// is only where they are kept. The shell reports the config back many times
// per write, the old value first, and the new one only after a file round
// trip that can take seconds. So a config event is acted on only when it is
// neither a repeat nor the echo of a write of ours, and then only for the
// fields it changed.
//
// state: { held, seen, pending, stale }
//   held     the settings in force, sent to the controller
//   seen     the last config event
//   pending  our writes since then the config has not yet reported, oldest
//            first; the latest is the shell's copy. Not capped: the latest
//            write always echoes, and that echo retires every older one,
//            while dropping one would let its late echo pass as a change
//            made elsewhere.
//   stale    our writes a change made elsewhere overtook. A late echo of one
//            is still ignored, but none is the shell's copy any more.

// The persisted settings in a shell.json bar entry, with their defaults.
function read(config) {
  var entry = config || {}
  return { auto: entry.auto !== false, offset: Number.isInteger(entry.offset) ? entry.offset : 0 }
}

function same(a, b) {
  return !!a && !!b && a.auto === b.auto && a.offset === b.offset
}

// Controller lines that take it from `from` to `to`; everything when `from`
// is null.
function diff(from, to) {
  var lines = []
  if (!from || from.auto !== to.auto) lines.push("auto " + (to.auto ? "on" : "off"))
  if (!from || from.offset !== to.offset) lines.push("offset " + to.offset)
  return lines
}

// A fresh controller: send it everything. After a restart the held state
// stands, since the config may still lag our writes.
function start(config, previous) {
  var state = previous || { held: config, seen: config, pending: [], stale: [] }
  return { state: state, lines: diff(null, state.held) }
}

// A config event. Returns the new state, the lines to send, and `restore`
// when the config lost a setting of ours. The caller then writes the held
// settings back through `own`, which records the write when it is made.
function configEvent(state, next) {
  if (same(state.seen, next)) return { state: state, lines: [] }
  // Echoes come in write order, so one matches the oldest write it equals,
  // and every write older than that has been reported or never will be.
  var stale = state.stale || []
  for (var j = 0; j < stale.length; j++) {
    if (same(stale[j], next))
      return { state: { held: state.held, seen: next, pending: state.pending, stale: stale.slice(j + 1) }, lines: [] }
  }
  for (var i = 0; i < state.pending.length; i++) {
    if (same(state.pending[i], next))
      return { state: { held: state.held, seen: next, pending: state.pending.slice(i + 1), stale: [] }, lines: [] }
  }
  // A change made elsewhere, from a config that may predate our pending
  // writes. Only the fields it changed are its own; the rest keep what we hold.
  var held = {
    auto: next.auto !== state.seen.auto ? next.auto : state.held.auto,
    offset: next.offset !== state.seen.offset ? next.offset : state.held.offset
  }
  var result = {
    state: { held: held, seen: next, pending: [], stale: stale.concat(state.pending) },
    lines: diff(state.held, held)
  }
  if (!same(held, next)) result.restore = true
  return result
}

// A change of ours: a toggle, a reset, or an offset the controller learned.
// Returns the new state, the lines to send, and the settings to persist.
function own(state, values) {
  var held = {
    auto: values.auto === undefined ? state.held.auto : values.auto,
    offset: values.offset === undefined ? state.held.offset : values.offset
  }
  // The shell's copy is our latest write, or the config last seen. A value
  // equal to it is no write, so no echo will come to retire it.
  var latest = state.pending.length ? state.pending[state.pending.length - 1] : state.seen
  var pending = same(held, latest) ? state.pending : state.pending.concat([held])
  return { state: { held: held, seen: state.seen, pending: pending, stale: state.stale || [] }, lines: diff(state.held, held), persist: held }
}

// The offset a status line teaches, or null. Lines written before the
// controller handled every command sent still carry the old offset; learning
// from one would undo the command. `sent` counts lines sent to this
// controller process, `known` is the offset held.
function learnedOffset(status, sent, known) {
  if (!Number.isInteger(status.offset) || status.seen !== sent) return null
  return status.offset !== known ? status.offset : null
}
