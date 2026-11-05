import QtQuick
import Quickshell.Hyprland
import Quickshell.Io
import "Control.js" as Control
import "Inventory.js" as Inventory
import "Settings.js" as Settings

// Auto brightness for every display that can be driven, and optionally the
// keyboard backlight. The probe reports outputs, sensors, the lid, EDIDs and
// the keyboard's LED; Inventory.js turns that into displays, each a
// DisplayChannel, and the keyboard's state, for a KeyboardChannel. Sensors
// some active channel reads are sampled every half second, smoothed once
// each, and their lux fed to the channels they serve. Settings live inline
// on this plugin's shell.json entry, per display (Settings.js); a change
// made in Setup arrives through the config. No channel exists before the
// settings are read, so one switched off never touches its hardware.
Item {
  id: root

  // Injected by the shell's service loader.
  property var shell: null
  property var manifest: null

  property var settings: null          // Settings.js state, null until the config is read
  property var channels: ({})          // display id -> DisplayChannel
  property var channelList: []         // the same, in inventory order, for bindings
  property var sensors: ({})           // sensor path -> { sensor, view, filtered, at }
  property var keyboard: null          // KeyboardChannel, while the setting is on and an LED found
  // The session is locked: true, false, or null when not known.
  property var locked: null
  property var lastProbe: null
  // The switches the channels were last built for.
  property var built: null
  property bool tearingDown: false

  // The display IPC commands without a monitor act on: the Studio Display
  // when connected, else the laptop panel, else the first other.
  readonly property var primary: {
    var list = channelList
    var order = ["apple", "panel", "ddc"]
    for (var k = 0; k < order.length; k++)
      for (var i = 0; i < list.length; i++)
        if (list[i].active && list[i].kind === order[k]) return list[i]
    return null
  }

  // The output whose bar shows the keyboard: the laptop's own, unless its
  // lid is closed, else the primary display's, else the first. Blanked
  // outputs count, so the row stays through a lock.
  readonly property string keyboardScreen: {
    if (!keyboard || !lastProbe) return ""
    var closed = Inventory.lidState(lastProbe.lid) === "closed"
    var shown = (lastProbe.monitors || []).filter(function(m) {
      return m && m.name && m.disabled !== true && !(closed && Inventory.isInternal(m.name))
    })
    var internal = shown.filter(function(m) { return Inventory.isInternal(m.name) })
    if (internal.length) return internal[0].name
    if (primary) return primary.name
    return shown.length ? shown[0].name : ""
  }

  // The primary display's, for status.
  readonly property bool hardwareAvailable: primary !== null && primary.hasSensor
  readonly property bool enabled: primary ? primary.auto : (settings ? settings.held.auto : true)
  readonly property int offset: primary ? primary.points : 0
  // The display a legacy offset belongs to, by id, or null.
  readonly property var legacyOwner: Settings.legacyOwner(channelList.map(function(ch) {
    return { id: ch.displayId, kind: ch.kind, active: ch.active }
  }))
  readonly property bool hasPreference: primary !== null && (primary.preference !== 0 || primary.points !== 0)
  readonly property string monitor: primary ? primary.name : ""
  readonly property real lux: primary ? primary.lux : 0
  readonly property int brightness: primary ? primary.brightness : 0
  readonly property real target: primary ? primary.target : 0
  readonly property string error: primary ? (primary.error || primary.sensorError)
    : !lastProbe || !settings ? "Starting"
    : settings.held.screens ? "No supported display connected" : "Screen control is off"

  function now() { return Date.now() / 1000 }

  function configEntry() { return Settings.entry(shell?.barConfig?.layout, manifest?.id) }

  // Settings ---------------------------------------------------------------

  function applySettings() {
    if (!settings) return
    var held = settings.held
    if (!built || built.screens !== held.screens || built.keyboard !== held.keyboard) { applyFacts(); return }
    for (var id in channels) {
      var d = Settings.displaySettings(held, id)
      channels[id].auto = d.auto
      channels[id].preference = d.preference
    }
    if (keyboard) keyboard.auto = held.keyboardAuto
  }

  function syncSettings() {
    if (!shell || !manifest) return
    var next = Settings.read(configEntry())
    if (!settings) {
      settings = Settings.start(next)
      applySettings()
      // A write; not from inside the shell's announcement (see below).
      Qt.callLater(keepFirstAuto)
      return
    }
    var result = Settings.configEvent(settings, next)
    settings = result.state
    if (result.changed) applySettings()
    // The shell announces a config before saving it, so a save from inside
    // the announcement would land first and be overwritten by the one in
    // progress. Write it back once that one is issued, as held by then: an
    // action in between may have changed it.
    if (result.restore) Qt.callLater(restoreHeld)
  }

  function restoreHeld() { change({}) }

  // A change of ours, persisted. `patch` as Settings.own takes it.
  function change(patch) {
    if (!shell || !manifest || !settings) return
    var result = Settings.own(settings, patch)
    settings = result.state
    if (result.changed) applySettings()
    shell.updateEntryInline(manifest.id, Settings.entryWith(configEntry(), result.persist))
  }

  function displayPatch(id, values) { var d = {}; d[id] = values; return { displays: d } }

  // A preference the user sets on the display the legacy offset belongs to
  // supersedes that offset, so a later migration cannot bring it back.
  function preferencePatch(ch, preference) {
    var patch = displayPatch(ch.displayId, { preference: preference })
    if (settings && settings.held.offset !== undefined && ch.displayId === legacyOwner) patch.offset = null
    return patch
  }

  // The additive offset from before displays were kept apart becomes the
  // preference of the display the old controller would drive now
  // (Settings.legacyOwner), once its light level is known. What it gave there
  // is held, so brightness does not jump even where no bend reaches it.
  // Which display it was learned on is not recorded.
  function migrate(channel) {
    if (!settings || settings.held.offset === undefined || channel.displayId !== legacyOwner || channel.accepted.accepted === null) return
    var lux = channel.accepted.accepted, offset = settings.held.offset
    var preference = Control.preferenceFromOffset(offset, lux, channel.lum)
    channel.holdLegacy(Control.legacyPct(offset, lux), preference)
    var patch = displayPatch(channel.displayId, { preference: preference })
    patch.offset = null
    change(patch)
  }

  // The display on output `name`, as a bar on that output shows it.
  function channelOn(name) {
    var list = channelList
    for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i]
    return null
  }

  // Actions on one display: the panel's own, or IPC's.
  function setEnabledFor(ch, value) { if (ch) change(displayPatch(ch.displayId, { auto: value === true })) }
  function clearOffsetFor(ch) {
    if (!ch) return
    ch.rebaseline()
    change(preferencePatch(ch, null))
  }
  function setBrightnessFor(ch, percent) {
    var p = Number(percent)
    // An inactive display would drop the write when it wakes.
    if (!ch || !ch.active || !isFinite(p)) return false
    ch.setBrightness(p)
    return true
  }

  // The keyboard's: its Auto is one switch, and a choice is only held.
  function setKeyboardAuto(value) { if (keyboard) change({ keyboardAuto: value === true }) }
  function forgetKeyboard() { if (keyboard) keyboard.forget() }
  function setKeyboardBrightness(percent) {
    var p = Number(percent)
    if (!keyboard || !keyboard.known || !isFinite(p)) return false
    return keyboard.setBrightness(p)
  }

  function setEnabled(value) { setEnabledFor(primary, value) }
  function clearOffset() { clearOffsetFor(primary) }
  function setBrightness(percent) { return setBrightnessFor(primary, percent) }

  // Inventory ----------------------------------------------------------------

  function applyProbe(line) {
    var facts
    try { facts = JSON.parse(String(line)) } catch (e) { console.warn("auto-brightness probe: " + e); return }
    lastProbe = facts
    applyFacts()
  }

  // The last probe's facts, as Inventory wants them, then reconciled with
  // the channels and sensors there are, for the switches set.
  function applyFacts() {
    var facts = lastProbe
    if (!facts || !settings) return
    var held = settings.held
    built = { screens: held.screens, keyboard: held.keyboard }
    var edid = {}
    for (var name in facts.edid || {}) edid[name] = Inventory.edidLuminance(facts.edid[name])
    var previous = {}
    for (var id in channels) previous[id] = channels[id].sensorPath
    var lid = Inventory.lidState(facts.lid)
    var list = held.screens ? Inventory.displays(facts.monitors || [], facts.sensors || [], lid, edid, previous) : []

    var next = {}, order = []
    for (var i = 0; i < list.length; i++) {
      var d = list[i]
      if (!d.kind) continue
      var panel = d.kind === "panel"
      // A panel is written in its backlight's own units: none without its range.
      if (panel && !(facts.backlight && facts.backlight.max > 0)) continue
      var props = {
        displayId: d.id, name: d.name, kind: d.kind, luminance: d.luminance,
        sensorReason: d.sensorReason || "",
        backlight: panel ? facts.backlight.name : "",
        levels: panel ? facts.backlight.max : 100
      }
      var ch = channels[d.id]
      // A display whose output or way of driving changed starts over.
      if (ch && (ch.name !== props.name || ch.kind !== props.kind || ch.backlight !== props.backlight || ch.levels !== props.levels)) {
        ch.destroy()
        ch = null
      }
      if (!ch) {
        ch = channelComponent.createObject(root, props)
        ch.learned.connect(learnedFor(ch))
        ch.accepting.connect(migratorFor(ch))
      } else {
        // By value: the probe builds new objects every time.
        for (var k in props) if (JSON.stringify(ch[k]) !== JSON.stringify(props[k])) ch[k] = props[k]
      }
      // Another sensor reads another room: accept its light afresh.
      if (ch.sensorPath !== (d.sensor || "")) ch.resetLight()
      ch.sensorPath = d.sensor || ""
      // Asleep first: a display blanking never looks gone in between.
      ch.asleep = d.asleep
      ch.active = d.active
      next[d.id] = ch
      order.push(ch)
    }
    for (var old in channels) if (!next[old]) channels[old].destroy()
    channels = next
    channelList = order
    var kbd = held.keyboard ? Inventory.keyboardState({ led: facts.keyboard, sensors: facts.sensors || [], lid: lid, locked: locked, monitors: facts.monitors || [] }) : null
    applyKeyboard(kbd, facts.keyboard)
    keepFirstAuto()
    applySettings()
    syncSensors(facts.sensors || [], Inventory.sensorsInUse(list, kbd))
  }

  // The keyboard channel for `state` (Inventory.keyboardState), or none.
  function applyKeyboard(state, led) {
    var present = state && state.present && led.max > 0
    if (keyboard && (!present || keyboard.device !== led.name || keyboard.levels !== led.max)) {
      keyboard.destroy()
      keyboard = null
    }
    if (!present) return
    // Blank before active: a lid reopening must not see itself closed.
    var props = { blank: state.blank, hasSensor: state.sensor !== null, sensorPath: state.sensor || "", active: state.active, paused: state.paused || "" }
    if (!keyboard) {
      props.device = led.name
      props.levels = led.max
      props.auto = settings.held.keyboardAuto
      keyboard = keyboardComponent.createObject(root, props)
      return
    }
    for (var k in props) if (keyboard[k] !== props[k]) keyboard[k] = props[k]
  }

  function learnedFor(ch) {
    return function(preference) { root.change(root.preferencePatch(ch, preference)) }
  }

  function migratorFor(ch) { return function() { root.migrate(ch) } }

  // A display seen for the first time takes the default Auto into its own
  // record, so a later change to the default reaches only newer displays.
  function keepFirstAuto() {
    if (!settings) return
    var patch = { displays: {} }, any = false
    for (var id in channels) {
      var record = settings.held.displays[id]
      if (record && record.auto !== undefined) continue
      patch.displays[id] = { auto: settings.held.auto }
      any = true
    }
    if (any) change(patch)
  }

  // Sample exactly the sensors some active display reads.
  function syncSensors(all, inUse) {
    var byPath = {}
    for (var i = 0; i < all.length; i++) byPath[all[i].path] = all[i]
    var next = {}
    for (var j = 0; j < inUse.length; j++) {
      var path = inUse[j]
      var sampled = sensors[path]
      if (sampled && sampled.sensor.file !== byPath[path].file) { sampled.view.destroy(); sampled = null }
      if (!sampled) sampled = { sensor: byPath[path], view: sensorComponent.createObject(root, { path: byPath[path].file, sensorPath: path }), filtered: null, at: -1, good: now(), checked: now(), stale: false }
      else sampled.sensor = byPath[path]
      next[path] = sampled
    }
    for (var old in sensors) if (!next[old]) sensors[old].view.destroy()
    sensors = next
    sampleTimer.running = inUse.length > 0
    checkSensors()
  }

  function sampleAll() {
    checkSensors()
    for (var path in sensors) sensors[path].view.reload()
  }


  // A sensor with no good reading for 3 s, failed, invalid or hung, is
  // reported on every display it serves (Control.sensorCheck). A hung read
  // is left to finish: the view folds reloads into it, and restarting it
  // cannot interrupt the kernel, only tie up another reader thread.
  function checkSensors() {
    var t = now()
    for (var path in sensors) {
      var sampled = sensors[path]
      var r = Control.sensorCheck({ good: sampled.good, checked: sampled.checked }, t)
      sampled.good = r.state.good
      sampled.checked = r.state.checked
      sampled.stale = r.stale
    }
    var list = keyboard ? channelList.concat([keyboard]) : channelList
    for (var i = 0; i < list.length; i++) {
      var ch = list[i], used = sensors[ch.sensorPath]
      var message = used && used.stale ? "Cannot read the light sensor" : ""
      if (ch.sensorError !== message) ch.sensorError = message
    }
  }

  function sensorRead(sensorPath, text) {
    var sampled = sensors[sensorPath]
    if (!sampled) return
    var lux = Inventory.lux(sampled.sensor, text)
    if (lux === null) return
    var t = now()
    sampled.good = t
    sampled.filtered = Control.smooth(sampled.filtered, lux, sampled.at < 0 ? 0 : t - sampled.at)
    sampled.at = t
    for (var id in channels) {
      var ch = channels[id]
      if (ch.sensorPath === sensorPath) ch.sample(sampled.filtered, t)
    }
    if (keyboard && keyboard.active && keyboard.sensorPath === sensorPath) keyboard.sample(sampled.filtered, t)
  }

  function probe() { if (!probeProc.running) probeProc.running = true }

  // The probe sits next to this file; the host strips `__sourceDir` from
  // third-party manifests.
  readonly property string probePath:
    decodeURIComponent(String(Qt.resolvedUrl("probe")).replace(/^file:\/\//, ""))

  Process {
    id: probeProc
    // Bounded as a whole: a stalled sysfs read would hold every later probe.
    command: ["setpriv", "--pdeathsig", "TERM", "timeout", "-k", "1", "10", root.probePath]
    stdout: StdioCollector { id: probeOut; waitForEnd: true }
    onExited: function(exitCode) {
      if (root.tearingDown) return
      if (exitCode === 0) root.applyProbe(probeOut.text)
      else console.warn("auto-brightness probe exited " + exitCode)
    }
  }

  // The lock screen is not a service plugins may bind to, nor does Hyprland
  // announce a lock: ask it over IPC, every 2 s while the keyboard is on
  // Auto, the only time a lock matters. Anything but a clear answer counts
  // as not known, which pauses the keyboard; so does not asking.
  Process {
    id: lockProc
    command: ["timeout", "-k", "1", "2", "omarchy-shell", "lock", "isLocked"]
    stdout: StdioCollector { id: lockOut; waitForEnd: true }
    onExited: function(exitCode) {
      if (root.tearingDown) return
      var m = exitCode === 0 ? /^\s*(true|false)\s*$/i.exec(lockOut.text) : null
      var next = m ? m[1].toLowerCase() === "true" : null
      if (next === root.locked) return
      root.locked = next
      root.applyFacts()
      // The lock blanks the screens and the unlock wakes them, with no
      // event for either: look now rather than at the next scan.
      root.probe()
    }
  }
  Timer {
    interval: 2000
    repeat: true
    running: root.keyboard !== null && root.keyboard.auto
    triggeredOnStart: true
    onTriggered: if (!lockProc.running) lockProc.running = true
    onRunningChanged: {
      if (running || root.locked === null) return
      root.locked = null
      root.applyFacts()
    }
  }

  // Outputs come and go with events; DPMS and the lid have none, so the
  // probe also runs every 10 s. A wall clock far ahead of the last probe
  // means the machine slept: every display reads back afresh.
  property real lastTick: 0
  Timer {
    interval: 10000
    repeat: true
    running: root.manifest !== null
    triggeredOnStart: true
    onTriggered: {
      var t = root.now()
      if (root.lastTick && t - root.lastTick > 30) {
        for (var id in root.channels) if (root.channels[id].active) root.channels[id].attach()
        if (root.keyboard) root.keyboard.wake()
      }
      root.lastTick = t
      root.probe()
    }
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      var name = String(event && event.name ? event.name : "")
      if (/^monitor(added|removed)/.test(name) || name === "configreloaded") root.probe()
    }
  }

  Timer {
    id: sampleTimer
    interval: 500
    repeat: true
    onTriggered: root.sampleAll()
  }

  Component {
    id: channelComponent
    DisplayChannel { property string sensorPath: "" }
  }

  Component {
    id: keyboardComponent
    KeyboardChannel { property string sensorPath: ""; property string sensorError: "" }
  }

  Component {
    id: sensorComponent
    FileView {
      property string sensorPath: ""
      blockLoading: false
      printErrors: false
      onLoaded: root.sensorRead(sensorPath, text())
    }
  }

  Connections {
    target: root.shell
    function onBarConfigChanged() { root.syncSettings() }
  }


  onShellChanged: syncSettings()
  onManifestChanged: syncSettings()

  IpcHandler {
    target: "auto-brightness"

    function status(): string {
      return JSON.stringify({
        auto: root.enabled,
        available: root.hardwareAvailable,
        monitor: root.monitor,
        lux: root.lux,
        brightness: root.brightness,
        target: root.target,
        offset: root.offset,
        error: root.error,
        displays: root.channelList.map(function(ch) {
          return {
            id: ch.displayId, monitor: ch.name, kind: ch.kind, active: ch.active, auto: ch.auto,
            sensor: ch.sensorReason, lux: ch.lux, brightness: ch.brightness, target: ch.target,
            preference: ch.preference, points: ch.points, error: ch.error, sensorError: ch.sensorError
          }
        }),
        keyboard: root.keyboard ? {
          device: root.keyboard.device, active: root.keyboard.active, paused: root.keyboard.paused, blank: root.keyboard.blank,
          auto: root.keyboard.auto, sensor: root.keyboard.hasSensor, locked: root.locked,
          lux: root.keyboard.lux, brightness: root.keyboard.brightness, holding: root.keyboard.holding,
          error: root.keyboard.error, sensorError: root.keyboard.sensorError
        } : null
      })
    }
    function enable(): string { root.setEnabled(true); return "enabled" }
    function disable(): string { root.setEnabled(false); return "disabled" }
    function toggle(): string {
      var next = !root.enabled
      root.setEnabled(next)
      return next ? "enabled" : "disabled"
    }
    function forget(): string { root.clearOffset(); return "forgot" }
    function set(percent: string): string {
      return root.setBrightness(percent) ? "set " + Math.round(Number(percent)) : "not set: no active display, or not a number"
    }
    // The same, on the display on output `monitor`, e.g. eDP-1, or on the
    // keyboard backlight as "keyboard".
    function setFor(monitor: string, percent: string): string {
      if (monitor === "keyboard")
        return root.setKeyboardBrightness(percent) ? "set " + Math.round(Number(percent)) : "not set: no keyboard backlight, the lid is closed, or not a number"
      return root.setBrightnessFor(root.channelOn(monitor), percent) ? "set " + Math.round(Number(percent)) : "not set: no such active display, or not a number"
    }
    function forgetFor(monitor: string): string {
      if (monitor === "keyboard") {
        if (!root.keyboard) return "no keyboard backlight"
        root.forgetKeyboard()
        return "forgot"
      }
      var ch = root.channelOn(monitor)
      if (!ch) return "no such display"
      root.clearOffsetFor(ch)
      return "forgot"
    }
    function toggleFor(monitor: string): string {
      if (monitor === "keyboard") {
        if (!root.keyboard) return "no keyboard backlight"
        var on = !root.keyboard.auto
        root.setKeyboardAuto(on)
        return on ? "enabled" : "disabled"
      }
      var ch = root.channelOn(monitor)
      if (!ch) return "no such display"
      var next = !ch.auto
      root.setEnabledFor(ch, next)
      return next ? "enabled" : "disabled"
    }
  }

  Component.onDestruction: {
    tearingDown = true
    for (var id in channels) channels[id].destroy()
    if (keyboard) keyboard.destroy()
    for (var path in sensors) sensors[path].view.destroy()
  }
}
