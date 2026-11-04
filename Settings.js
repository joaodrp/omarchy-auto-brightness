// Pure, Qt-free settings logic, so it runs under node too
// (test/settings.test.js). Service.qml owns the displays.
//
// The service holds the settings and is their only writer apart from Setup
// or a hand edit. Its own changes take effect at once; the config is only
// where they are kept. The shell reports the config back many times per
// write, the old value first, and the new one only after a file round trip
// that can take seconds. So a config event is acted on only when it is
// neither a repeat nor the echo of a write of ours, and then only for the
// fields it changed.
//
// Settings: { auto, displays, offset? }
//   auto      Auto for a display seen for the first time
//   displays  per display id: { auto?, preference? }, preference the curve's
//             bend in [-1, 1] (Control.js)
//   offset    the additive offset from before displays were kept apart, until
//             it is migrated onto the display it was learned on
// Fields are compared and merged by path: `auto`, `offset`, and
// `displays/<id>/<field>`.
//
// state: { held, seen, pending, stale }
//   held     the settings in force
//   seen     the last config event
//   pending  our writes since then the config has not yet reported, oldest
//            first; the latest is the shell's copy. Not capped: the latest
//            write always echoes, and that echo retires every older one,
//            while dropping one would let its late echo pass as a change
//            made elsewhere.
//   stale    our writes a change made elsewhere overtook. A late echo of one
//            is still ignored, but none is the shell's copy any more.

function isObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v) }

// The persisted settings in a shell.json bar entry, with their defaults.
function read(config) {
  var entry = config || {}
  var displays = {}
  var stored = isObject(entry.displays) ? entry.displays : {}
  for (var id in stored) {
    var d = stored[id]
    if (!isObject(d)) continue
    var record = {}
    if (typeof d.auto === "boolean") record.auto = d.auto
    if (typeof d.preference === "number" && d.preference >= -1 && d.preference <= 1) record.preference = d.preference
    displays[id] = record
  }
  var settings = { auto: entry.auto !== false, displays: displays }
  if (Number.isInteger(entry.offset) && entry.offset !== 0) settings.offset = entry.offset
  return settings
}

var sep = "/"

// Settings as { path: value }, every leaf by its path.
function flatten(s) {
  var flat = { auto: s.auto }
  if (s.offset !== undefined) flat.offset = s.offset
  for (var id in s.displays) {
    var d = s.displays[id]
    for (var f in d) flat["displays" + sep + id + sep + f] = d[f]
  }
  return flat
}

function unflatten(flat) {
  var s = { auto: flat.auto !== false, displays: {} }
  for (var path in flat) {
    if (path === "offset") s.offset = flat.offset
    if (path.indexOf("displays" + sep) !== 0) continue
    var rest = path.slice(9)
    var cut = rest.lastIndexOf(sep)
    var id = rest.slice(0, cut)
    if (!s.displays[id]) s.displays[id] = {}
    s.displays[id][rest.slice(cut + 1)] = flat[path]
  }
  return s
}

function same(a, b) {
  if (!a || !b) return false
  var fa = flatten(a), fb = flatten(b)
  var keys = Object.keys(fa)
  if (keys.length !== Object.keys(fb).length) return false
  for (var i = 0; i < keys.length; i++) if (fa[keys[i]] !== fb[keys[i]]) return false
  return true
}

// The display a legacy `offset` goes to, by id, among [{ id, kind, active }]:
// the one the old controller would drive now, the Studio Display else the
// panel, never a DDC monitor. Which it was learned on was not recorded.
// Null for none.
function legacyOwner(displays) {
  var kinds = ["apple", "panel"]
  for (var k = 0; k < kinds.length; k++)
    for (var i = 0; i < displays.length; i++)
      if (displays[i].active && displays[i].kind === kinds[k]) return displays[i].id
  return null
}

// What a display runs with: its own record over the defaults.
function displaySettings(settings, id) {
  var d = settings.displays[id] || {}
  return { auto: d.auto !== undefined ? d.auto : settings.auto, preference: d.preference !== undefined ? d.preference : 0 }
}

// The service's first state; after its restart the held settings stand,
// since the config may still lag our writes.
function start(config, previous) {
  return previous || { held: config, seen: config, pending: [], stale: [] }
}

// A config event. Returns { state, changed, restore }: `changed` when the
// held settings moved, `restore` when the config lost a setting of ours. The
// caller then writes the held settings back through `own`, which records the
// write when it is made.
function configEvent(state, next) {
  if (same(state.seen, next)) return { state: state, changed: false }
  // Echoes come in write order, so one matches the oldest write it equals,
  // and every write older than that has been reported or never will be.
  var stale = state.stale || []
  for (var j = 0; j < stale.length; j++) {
    if (same(stale[j], next))
      return { state: { held: state.held, seen: next, pending: state.pending, stale: stale.slice(j + 1) }, changed: false }
  }
  for (var i = 0; i < state.pending.length; i++) {
    if (same(state.pending[i], next))
      return { state: { held: state.held, seen: next, pending: state.pending.slice(i + 1), stale: [] }, changed: false }
  }
  // A change made elsewhere, from a config that may predate our pending
  // writes. Only the fields it changed are its own; the rest keep what we hold.
  var fn = flatten(next), fs = flatten(state.seen), fh = flatten(state.held), merged = {}
  var paths = {}
  for (var a in fn) paths[a] = true
  for (var b in fs) paths[b] = true
  for (var c in fh) paths[c] = true
  for (var p in paths) {
    var v = fn[p] !== fs[p] ? fn[p] : fh[p]
    if (v !== undefined) merged[p] = v
  }
  var held = unflatten(merged)
  var result = {
    state: { held: held, seen: next, pending: [], stale: stale.concat(state.pending) },
    changed: !same(held, state.held)
  }
  if (!same(held, next)) result.restore = true
  return result
}

// A change of ours: a toggle, a reset, a learned preference, a migration.
// `patch` is { auto?, offset?, displays?: { id: { auto?, preference? } } },
// a null removing the field. Returns { state, changed, persist }.
function own(state, patch) {
  var flat = flatten(state.held)
  function set(path, v) { if (v === null) delete flat[path]; else if (v !== undefined) flat[path] = v }
  set("auto", patch.auto)
  set("offset", patch.offset)
  for (var id in patch.displays || {}) {
    var d = patch.displays[id]
    for (var f in d) set("displays" + sep + id + sep + f, d[f])
  }
  var held = unflatten(flat)
  // The shell's copy is our latest write, or the config last seen. A value
  // equal to it is no write, so no echo will come to retire it.
  var latest = state.pending.length ? state.pending[state.pending.length - 1] : state.seen
  var pending = same(held, latest) ? state.pending : state.pending.concat([held])
  return {
    state: { held: held, seen: state.seen, pending: pending, stale: state.stale || [] },
    changed: !same(held, state.held),
    persist: held
  }
}

// The shell.json entry to write: `entry` with the settings' keys replaced.
function entryWith(entry, settings) {
  var out = {}
  for (var k in entry) if (k !== "auto" && k !== "offset" && k !== "displays") out[k] = entry[k]
  out.auto = settings.auto
  if (settings.offset !== undefined) out.offset = settings.offset
  out.displays = JSON.parse(JSON.stringify(settings.displays))
  return out
}
