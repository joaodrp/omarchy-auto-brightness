import QtQuick
import Quickshell
import Quickshell.Io
import "Control.js" as Control
import "Endpoint.js" as Endpoint
import "Keyboard.js" as Keyboard

// The keyboard backlight: its hardware operations and fade, with
// Keyboard.js deciding the level. Service.qml makes one while the keyboard
// setting is on and the probe finds an LED, feeds it the chassis sensor's
// smoothed lux, and keeps its Auto; the panel binds to its properties.
// Writes go through brightnessctl, as Omarchy's hotkeys do; reads from sysfs.
Item {
  id: channel

  // From the probe and Inventory.keyboardState.
  property string device: ""
  property int levels: 100
  property bool active: false          // driven: unlocked, lid open, a screen on
  property bool blank: false           // the lid is closed: keys off
  property string paused: ""           // why not active, as Inventory.keyboardState says
  property bool hasSensor: false

  // From the settings.
  property bool auto: true

  // For the panel and status.
  readonly property bool autoActive: auto && hasSensor
  property real lux: 0
  property int brightness: 0           // percent, as last written or read
  property bool known: false
  property bool seen: false            // read once: its row stays through pauses
  property string error: ""
  readonly property bool holding: kb.held !== null

  property var kb: Keyboard.create()
  property var endpoint: null
  property int generation: 0
  property var frames: []              // [{ at, units }], the fade's writes to come
  property var inflight: null          // { gen, id, op, started }

  function now() { return Date.now() / 1000 }

  // Set by a lifecycle change or an explicit reset: whatever the next
  // read-back finds is adopted, not held, and nothing is driven until it
  // lands, since any change it reveals came before.
  property bool quiet: false
  // From a resume until the read that ends the settle lands: 1 waiting
  // for the settle time, 2 for that read, 0 settled. Nothing is driven or
  // held before, whatever the clock says.
  property int settleStage: 0

  // A new endpoint, whose first act is to read the LED back. Anything
  // queued or being retried for the old one is dropped.
  function attach() {
    generation++
    endpoint = Endpoint.create("keyboard", generation)
    frames = []
    frameTimer.stop()
    known = false
    quiet = true
    if (inflight) cancel()
    off()
    pump()
  }

  // Read the LED back soon, as after a hotkey.
  // One already running answers it: a newer request would discard it.
  function refresh() {
    if (!endpoint || (endpoint.busy && endpoint.busy.op === "read")) return
    endpoint = Endpoint.requestRead(endpoint)
    pump()
  }

  function rebaseline() {
    if (!endpoint) return
    quiet = true
    endpoint = Endpoint.requestRead(endpoint)
    pump()
  }

  // Paused: nothing of before survives, not even a slider write waiting
  // for a retry, which could relight the keys under the lock. Resumed: the
  // settle starts, and ends with a read that adopts whatever Omarchy
  // restored in the meantime.
  onActiveChanged: {
    if (active) {
      kb = Keyboard.resume(kb, now())
      settleStage = 1
      settleTimer.restart()
      // Nothing queued while paused, such as a retry of the lid's off,
      // may land on what Omarchy restores.
      attach()
    } else {
      kb = Keyboard.pause(kb)
      settleStage = 0
      settleTimer.stop()
      attach()
    }
  }
  // Closing the lid on Auto drops a slider write waiting for a retry too,
  // even when the keyboard was already paused, as without a sensor.
  onBlankChanged: {
    if (blank && auto) attach()
    else if (!blank) stopAuto()
  }
  onAutoChanged: {
    kb = Keyboard.forget(kb)
    if (!auto) stopAuto()
    rebaseline()
    off()
  }

  // The machine slept: a pause and resume, whether or not a lock was seen.
  function wake() {
    kb = Keyboard.pause(kb)
    settleStage = 0
    settleTimer.stop()
    if (active) {
      kb = Keyboard.resume(kb, now())
      settleStage = 1
      settleTimer.restart()
    }
    attach()
  }

  function stopAuto() {
    frames = []
    frameTimer.stop()
    if (endpoint) endpoint = Endpoint.cancelAuto(endpoint)
  }

  // A closed lid covers the keys: with Auto on, turn them off, and again
  // whenever something else lights them.
  function off() {
    if (!blank || !auto || !endpoint) return
    stopAuto()
    endpoint = Endpoint.requestAuto(endpoint, 0)
    pump()
  }

  function userPending() { return endpoint.user !== null || (endpoint.busy !== null && endpoint.busy.from === "user") }

  // The units the LED is at or on its way to.
  function reached() {
    if (endpoint.auto !== null) return endpoint.auto
    var b = endpoint.busy
    return b && b.op === "write" ? b.units : endpoint.value
  }

  // The chassis sensor's smoothed lux at `t`.
  function sample(filtered, t) {
    kb = Keyboard.sample(kb, filtered, t)
    lux = kb.accepted.accepted
    drive(t)
  }

  function drive(t) {
    if (!endpoint || !known || quiet || settleStage !== 0 || !hasSensor || userPending()) return
    var goal = Keyboard.goal(kb, t, auto)
    if (goal === null) return
    var to = Keyboard.toUnits(goal, levels)
    var current = reached()
    if (to === current || (frames.length && frames[frames.length - 1].units === to)) return
    frames = Keyboard.fade(current === null ? to : current, to).map(function (f) { return { at: t + f.at, units: f.units } })
    playFrames()
  }

  // The user picked `pct` in the pop-up: written at once, and with Auto on
  // held while the light stays near. Refused under a closed lid with Auto
  // on, which keeps the keys off.
  function setBrightness(pct) {
    if (!endpoint || !isFinite(pct) || (blank && auto)) return false
    var p = Math.max(0, Math.min(100, Math.round(pct)))
    frames = []
    if (autoActive) kb = Keyboard.chose(kb, p)
    endpoint = Endpoint.requestUser(endpoint, Keyboard.toUnits(p, levels))
    pump()
    return true
  }

  // Back to the curve, from the level the LED is at now.
  function forget() {
    kb = Keyboard.forget(kb)
    rebaseline()
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

  function pump() {
    if (!endpoint) return
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
      pumpTimer.interval = Math.round(endpoint.policy.timeout * 1000) + 10
      pumpTimer.restart()
    }
  }

  function run(op, t) {
    inflight = { gen: generation, id: op.id, op: op.op, started: t }
    if (op.op === "read") {
      ledFile.path = "/sys/class/leds/" + device + "/brightness"
      ledFile.reload()
      return
    }
    proc.command = ["timeout", "-k", "1", "8", "brightnessctl", "-q", "-d", device, "set", String(op.units)]
    proc.running = true
  }

  // A read is a FileView load, which a change of path cancels.
  function cancel() {
    if (proc.running) { proc.running = false; return }
    var op = inflight
    if (!op || op.op !== "read") return
    ledFile.path = ""
    Qt.callLater(function() { if (channel.inflight === op) channel.finished(false, "") })
  }

  function finished(ok, text) {
    var op = inflight
    inflight = null
    if (!op) return
    // Never pump from inside a completion: a FileView reload asked for in
    // its own onLoaded is folded into the load that is ending.
    if (op.gen !== generation || !endpoint) { Qt.callLater(channel.pump); return }
    var t = now()
    var value = null
    if (op.op === "read") {
      var m = /^\s*([0-9]+)/.exec(String(text || ""))
      value = m ? parseInt(m[1], 10) : null
      if (value === null) ok = false
    }
    var readSeq = endpoint.readSeq
    var c = Endpoint.complete(endpoint, op.id, ok, t, value)
    endpoint = c.state
    // Only a read the endpoint took, not one that predates the reset, ends
    // the quiet.
    var adoptOnly = quiet && endpoint.readSeq !== readSeq
    if (adoptOnly) quiet = false
    if (adoptOnly && settleStage === 2) settleStage = 0
    if (endpoint.value !== null) {
      brightness = Keyboard.toPct(endpoint.value, levels)
      known = true
      seen = true
    }
    error = endpoint.writeFailures + endpoint.readFailures >= 3 ? "Cannot reach the keyboard backlight" : ""
    // Someone else set it: a hotkey, the lock, or Omarchy's restore on wake.
    if (c.moved !== null && !userPending()) {
      stopAuto()
      if (blank) off()
      else if (autoActive && !adoptOnly && settleStage === 0) kb = Keyboard.observed(kb, brightness, t)
    }
    Qt.callLater(channel.pump)
  }

  function stopped() {
    var op = inflight
    if (op) Qt.callLater(function() { if (channel.inflight === op) channel.finished(false, "") })
  }

  Process {
    id: proc
    onExited: function(exitCode) { channel.finished(exitCode === 0, "") }
    onRunningChanged: if (!running) channel.stopped()
  }

  FileView {
    id: ledFile
    blockLoading: false
    printErrors: false
    onLoaded: channel.finished(true, text())
    onLoadFailed: channel.finished(false, "")
  }

  Timer { id: pumpTimer; repeat: false; onTriggered: channel.pump() }
  Timer { id: frameTimer; repeat: false; onTriggered: channel.playFrames() }
  Timer { id: settleTimer; repeat: false; interval: Keyboard.config.settle * 1000; onTriggered: { channel.settleStage = 2; channel.rebaseline() } }

  Component.onCompleted: {
    if (active) {
      kb = Keyboard.resume(kb, now())
      settleStage = 1
      settleTimer.restart()
    }
    attach()
  }
  // Destroying a Process kills only `timeout`, whose children would outlive
  // it; signal its process group the way `timeout` itself would.
  Component.onDestruction: {
    var pid = proc.running ? proc.processId : null
    generation++
    pumpTimer.stop()
    frameTimer.stop()
    settleTimer.stop()
    if (pid) Quickshell.execDetached(["sh", "-c", "kill -TERM -- -$0 2>/dev/null; sleep 1; kill -KILL -- -$0 2>/dev/null", String(pid)])
  }
}
