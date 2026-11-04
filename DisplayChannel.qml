import QtQuick
import Quickshell
import Quickshell.Io
import "Control.js" as Control
import "Endpoint.js" as Endpoint

// One display: its hardware operations, ramp and learning. Service.qml makes
// one per display Inventory.js reports, feeds it its sensor's smoothed lux,
// and keeps its settings; the panel binds to its properties.
Item {
  id: channel

  // From the inventory.
  property string displayId: ""
  property string name: ""
  property string kind: ""            // apple, panel or ddc
  property bool active: false
  property bool asleep: false         // only blanked, by DPMS: its widget stays
  property var luminance: null        // { peak, floor } nits, or null
  property string backlight: ""       // panel only
  property int levels: 100
  property string sensorReason: ""    // own, chassis, other, or "" for none
  property string error: ""          // the display cannot be reached
  property string sensorError: ""    // its sensor cannot be read, set by Service.qml

  // From the settings.
  property bool auto: true
  property real preference: 0

  // For the panel and status.
  readonly property bool hasSensor: sensorReason !== ""
  readonly property bool autoActive: auto && hasSensor
  property real lux: 0                // accepted lux
  property int brightness: 0          // percent, as last written or read
  // Percent auto drives to, and its points over the plain curve for the chip.
  readonly property real target: accepted.accepted === null ? 0 : Control.goal(accepted.accepted, lum, preference, held)
  readonly property int points: accepted.accepted === null ? 0 : Control.points(accepted.accepted, lum, preference, held)
  property bool known: false          // brightness has been read

  // A learned preference to keep.
  signal learned(real preference)
  // A light level was accepted and the target is about to follow it: the
  // moment to settle the preference, before it is used.
  signal accepting()

  property var endpoint: null
  property int generation: 0
  property var accepted: ({ accepted: null })
  property var ramp: ({ brightness: null, goal: null, span: 0 })
  property var frames: []             // [{ at, units }], the fade's writes to come
  property real lastSample: -1
  property real readSeconds: 0.02
  property real writeSeconds: 0.02
  // The operation running, { gen, id, op, started }. One from an earlier
  // generation is drained before anything else runs, and its result dropped.
  property var inflight: null
  // A choice made before any light level was accepted: learned on the first.
  property var pendingChoice: null
  // The user's last choice, { lux, pct }, held exactly until the accepted
  // light level moves well away (Control.holding).
  property var held: null
  // The preference change this display is itself about to cause, once: any
  // other arriving, from Setup or a reset, supersedes the hold.
  property var learnt: null
  // Set by an explicit reset or Auto toggle: whatever the next read-back
  // finds is adopted, not learned, since any press it reveals came before.
  property bool quiet: false

  readonly property var lum: Control.luminance(luminance ? luminance.peak : 0, luminance ? luminance.floor : 0)
  readonly property var policy: Endpoint.policies[kind] || Endpoint.policies.ddc

  function now() { return Date.now() / 1000 }

  // Start over: a new endpoint whose first act is to read the display back,
  // and no light level accepted yet, so nothing learns from the gap.
  function attach() {
    generation++
    endpoint = Endpoint.create(kind, generation)
    accepted = { accepted: null }
    ramp = { brightness: null, goal: null, span: 0 }
    frames = []
    known = false
    lastSample = -1
    pendingChoice = null
    held = null
    if (inflight) cancel()
    pump()
  }

  // Whatever is still running is stopped, and its result dropped.
  function detach() {
    generation++
    if (inflight) cancel()
    if (endpoint) endpoint = Endpoint.cancelAuto(endpoint)
    frames = []
    pumpTimer.stop()
    frameTimer.stop()
  }

  onActiveChanged: active ? attach() : detach()
  onAutoChanged: {
    if (!endpoint) return
    if (!auto) { endpoint = Endpoint.cancelAuto(endpoint); frames = [] }
    ramp = { brightness: known ? brightness : null, goal: null, span: 0 }
    rebaseline()
  }

  // Read the display back before anything follows an explicit reset, and
  // adopt what it shows without learning from it.
  function rebaseline() {
    if (!endpoint) return
    quiet = true
    pendingChoice = null
    held = null
    endpoint = Endpoint.requestRead(endpoint)
    pump()
  }
  // Anything the target depends on changed: every automatic write queued
  // for the old one is dropped, and the next sample plans afresh.
  function invalidate() {
    frames = []
    if (endpoint) endpoint = Endpoint.cancelAuto(endpoint)
    ramp = { brightness: rampStart(), goal: null, span: 0 }
  }

  // Where a new ramp starts: the user's value while it is on its way, else
  // the display's.
  function rampStart() {
    if (endpoint && userPending())
      return Control.toPct(endpoint.user !== null ? endpoint.user : endpoint.busy.units, levels)
    return known ? brightness : ramp.brightness
  }

  // Read the display back soon, as after a hotkey: what it finds is adopted
  // as any read-back's is.
  // One already running answers it: a newer request would discard it, and
  // a slow display would never be read.
  function refresh() {
    if (!endpoint || !active || (endpoint.busy && endpoint.busy.op === "read")) return
    endpoint = Endpoint.requestRead(endpoint)
    pump()
  }

  // Another sensor, or none: its light is accepted afresh too.
  function resetLight() {
    held = null
    accepted = { accepted: null }
    lastSample = -1
    invalidate()
  }

  onAutoActiveChanged: if (!autoActive) resetLight()
  onPreferenceChanged: {
    if (preference === learnt) learnt = null
    else held = null
    invalidate()
  }
  onLumChanged: invalidate()

  // The user's hand, still on its way to the display: nothing automatic
  // may start from the value it is replacing.
  function userPending() { return endpoint.user !== null || (endpoint.busy !== null && endpoint.busy.from === "user") }

  // The sensor's smoothed lux at `t`, every sample while this display is
  // active and reads one.
  function sample(filtered, t) {
    if (!active || !endpoint) return
    var dt = Control.stepSeconds(lastSample, t)
    lastSample = t
    accepted = Control.accept(accepted, filtered, t)
    lux = accepted.accepted
    if (held && !Control.holding(held, accepted.accepted)) held = null
    if (pendingChoice !== null) {
      if (autoActive) keep(pendingChoice)
      pendingChoice = null
    }
    accepting()
    if (!autoActive || !known || userPending()) return
    if (!policy.fade) {
      // Only the final value, and the endpoint spaces the writes out.
      var goal = Control.toUnits(target, levels)
      // A target back where the display already is cancels any still queued.
      endpoint = goal !== endpoint.value ? Endpoint.requestAuto(endpoint, goal) : Endpoint.cancelAuto(endpoint)
      pump()
      return
    }
    var from = ramp.brightness === null ? brightness : ramp.brightness
    ramp = Control.ramp({ brightness: from, goal: ramp.goal, span: ramp.span }, target, dt)
    var to = Control.toUnits(ramp.brightness, levels)
    // From where the fade has got to, not where its frames still to come
    // would have taken it.
    var current = reached()
    // Already there, or the write queued is: the frames still to come only
    // overshoot.
    if (to === current) { frames = []; return }
    var frame = Control.frameSeconds(readSeconds + writeSeconds)
    var units = Control.rampFrames(current === null ? to : current, to, Math.max(dt, frame), frame, levels)
    frames = units.map(function (u, i) { return { at: t + i * frame, units: u } })
    playFrames()
  }

  // The user picked `pct`: written at once, and with auto on held and learned
  // at the light level accepted now.
  function setBrightness(pct) {
    if (!endpoint || !isFinite(pct)) return
    var p = Math.max(1, Math.min(100, Math.round(pct)))
    frames = []
    choose(p)
    // After learning, whose invalidate() would seed the ramp from the old value.
    ramp = { brightness: p, goal: null, span: 0 }
    endpoint = Endpoint.requestUser(endpoint, Control.toUnits(p, levels))
    pump()
  }

  // A brightness the user chose, by hand or by hotkey: with auto on it is
  // held and learned, now or at the first light level accepted.
  function choose(p) {
    if (!autoActive) return
    if (accepted.accepted === null) pendingChoice = p
    else keep(p)
  }

  // The units the display is at or on its way to: the automatic write queued
  // or running, else the last value known.
  function reached() {
    if (endpoint.auto !== null) return endpoint.auto
    var b = endpoint.busy
    return b && b.op === "write" ? b.units : endpoint.value
  }

  // Hold `p` at the light level accepted now, and learn what it says about
  // the rest of the curve, if anything can.
  function keep(p) {
    held = { lux: accepted.accepted, pct: p }
    var fit = Control.learn(p, accepted.accepted, lum)
    if (fit === null) return
    // No change, so no notification to consume the exemption.
    learnt = fit !== preference ? fit : null
    learned(fit)
  }

  // A legacy offset migrating to `preference`: what it gave, `pct`, is held,
  // since the bend may not reach it.
  function holdLegacy(pct, preference) {
    held = { lux: accepted.accepted, pct: pct }
    learnt = preference !== channel.preference ? preference : null
  }

  function playFrames() {
    var t = now()
    while (frames.length && frames[0].at <= t) {
      endpoint = Endpoint.requestAuto(endpoint, frames[0].units)
      frames = frames.slice(1)
    }
    pump()
    if (frames.length) {
      frameTimer.interval = Math.max(1, Math.round((frames[0].at - t) * 1000))
      frameTimer.restart()
    }
  }

  // Run whatever the endpoint says is next, and wake when it says.
  function pump() {
    if (!endpoint || !active) return
    if (inflight && inflight.gen !== generation) return  // draining
    var t = now()
    var r = Endpoint.next(endpoint, t)
    endpoint = r.state
    if (r.kill) cancel()
    if (r.op) run(r.op, t)
    if (r.wake !== Infinity && !r.op) {
      pumpTimer.interval = Math.max(1, Math.round((r.wake - t) * 1000))
      pumpTimer.restart()
    } else if (r.op) {
      pumpTimer.interval = Math.round(policy.timeout * 1000) + 10
      pumpTimer.restart()
    }
  }

  function run(op, t) {
    inflight = { gen: generation, id: op.id, op: op.op, started: t }
    if (op.op === "read" && kind === "panel") {
      backlightFile.path = "/sys/class/backlight/" + backlight + "/brightness"
      backlightFile.reload()
      return
    }
    proc.command = command(op)
    proc.running = true
  }

  // Each helper runs under `timeout`, which signals its whole process group,
  // so a hung `ddcutil` or `sudo` beneath it goes too, and is killed outright
  // a second later; all within Endpoint's own timeout.
  function command(op) {
    var pct = Math.round(op.units * 100 / levels) + "%"
    var cmd
    if (kind === "apple")
      cmd = op.op === "write" ? ["omarchy-brightness-display-apple", "--no-osd", pct] : ["omarchy-brightness-display", "--monitor", name]
    else if (kind === "panel")
      cmd = ["brightnessctl", "-q", "-d", backlight, "set", String(op.units)]
    else
      cmd = op.op === "write" ? ["omarchy-brightness-display-ddc", name, pct] : ["omarchy-brightness-display-ddc", name]
    return ["timeout", "-k", "1", "8"].concat(cmd)
  }

  // A panel read is a FileView load, which a change of path cancels.
  function cancel() {
    if (proc.running) { proc.running = false; return }
    var op = inflight
    if (!op || op.op !== "read" || kind !== "panel") return
    backlightFile.path = ""
    Qt.callLater(function() { if (channel.inflight === op) channel.finished(false, "") })
  }

  function finished(ok, text) {
    var op = inflight
    inflight = null
    if (!op) return
    // Never pump from inside a completion: a FileView reload asked for in its
    // own onLoaded is folded into the load that is ending.
    if (op.gen !== generation || !endpoint) { Qt.callLater(channel.pump); return }
    var t = now()
    var seconds = t - op.started
    if (ok && op.op === "read") readSeconds += 0.3 * (seconds - readSeconds)
    if (ok && op.op === "write") writeSeconds += 0.3 * (seconds - writeSeconds)
    var value = null
    if (op.op === "read") {
      var m = /-?[0-9]+/.exec(String(text || ""))
      value = m ? parseInt(m[0], 10) : null
      // Helpers that speak percent read back percent; scale to units.
      if (value !== null && kind !== "panel") value = Math.round(value * levels / 100)
      if (value === null || value < 0) ok = false
    }
    var readSeq = endpoint.readSeq
    var c = Endpoint.complete(endpoint, op.id, ok, t, value)
    endpoint = c.state
    // Only a read the endpoint took, not one that predates the reset, ends
    // the quiet.
    var adoptOnly = quiet && endpoint.readSeq !== readSeq
    if (adoptOnly) quiet = false
    if (endpoint.value !== null) {
      brightness = Control.toPct(endpoint.value, levels)
      if (!known) {
        known = true
        if (!userPending()) ramp = { brightness: brightness, goal: null, span: 0 }
      }
    }
    error = endpoint.writeFailures + endpoint.readFailures >= 3 ? "Cannot reach the display" : ""
    // Someone else set it, a hotkey most likely: adopt it, unless the user
    // has chosen since, which supersedes it.
    if (c.moved !== null && !userPending()) {
      frames = []
      if (!adoptOnly) choose(brightness)
      ramp = { brightness: brightness, goal: null, span: 0 }
    }
    Qt.callLater(channel.pump)
  }

  // The process stopped. If it never reported an exit, it failed to start.
  function stopped() {
    var op = inflight
    if (op) Qt.callLater(function() { if (channel.inflight === op) channel.finished(false, "") })
  }

  Process {
    id: proc
    stdout: StdioCollector { id: procOut; waitForEnd: true }
    onExited: function(exitCode) { channel.finished(exitCode === 0, procOut.text) }
    onRunningChanged: if (!running) channel.stopped()
  }

  FileView {
    id: backlightFile
    blockLoading: false
    printErrors: false
    onLoaded: channel.finished(true, text())
    onLoadFailed: channel.finished(false, "")
  }

  Timer { id: pumpTimer; repeat: false; onTriggered: channel.pump() }
  Timer { id: frameTimer; repeat: false; onTriggered: channel.playFrames() }

  Component.onCompleted: if (active) attach()
  // Destroying a Process kills only `timeout`, whose children would outlive
  // it; signal its process group the way `timeout` itself would.
  Component.onDestruction: {
    var pid = proc.running ? proc.processId : null
    detach()
    if (pid) Quickshell.execDetached(["sh", "-c", "kill -TERM -- -$0 2>/dev/null; sleep 1; kill -KILL -- -$0 2>/dev/null", String(pid)])
  }
}
