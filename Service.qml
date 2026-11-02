import QtQuick
import Quickshell.Io
import "Settings.js" as Settings

// Owns the auto brightness controller. Settings live inline on this plugin's
// shell.json entry as `auto` (default on) and `offset` (default 0). Changes
// made here, from the panel, IPC or an offset the controller learned, go to
// the controller at once and are then persisted; a change made in Setup
// arrives through the config. Settings.js keeps the two apart. Live readings
// come back as JSON lines.
Item {
  id: root

  // Injected by the shell's service loader.
  property var shell: null
  property var manifest: null

  property bool enabled: true
  property int offset: 0

  property bool hardwareAvailable: false
  property string monitor: ""
  property real lux: 0
  property int brightness: 0
  property real target: 0
  property string error: "Starting"

  property bool tearingDown: false

  // Settings.js state, null until the first controller starts, and the lines
  // written to the running controller.
  property var settings: null
  property int sentLines: 0

  function configEntry() {
    var sections = ["left", "center", "right"]
    var layout = shell?.barConfig?.layout
    for (var s = 0; layout && s < sections.length; s++) {
      var entries = layout[sections[s]] || []
      for (var i = 0; i < entries.length; i++)
        if (entries[i]?.id === manifest?.id) return entries[i]
    }
    return ({})
  }

  function send(line) {
    if (!controller.running) return false
    controller.write(line + "\n")
    sentLines++
    return true
  }

  function apply(result) {
    settings = result.state
    enabled = settings.held.auto
    offset = settings.held.offset
    for (var i = 0; i < result.lines.length; i++) send(result.lines[i])
  }

  function syncSettings() {
    var next = Settings.read(configEntry())
    if (!settings) {
      enabled = next.auto
      offset = next.offset
      return
    }
    apply(Settings.configEvent(settings, next))
  }

  // A change of ours. `tell` is false when the controller made it.
  function change(values, tell) {
    if (!shell || !manifest) return
    var result = Settings.own(settings || Settings.start(Settings.read(configEntry())).state, values)
    if (!tell) result.lines = []
    apply(result)
    shell.updateEntryInline(manifest.id, Object.assign({}, configEntry(), result.persist, { id: manifest.id }))
  }

  function setEnabled(value) { change({ auto: value === true }, true) }
  function setOffset(value) { change({ offset: Math.round(Number(value)) }, true) }
  function clearOffset() { setOffset(0) }

  // The user picked a brightness. The controller writes it, and with auto on
  // turns it into the offset, which comes back in its status.
  function setBrightness(percent) { send("manual " + Math.round(Number(percent))) }

  // The host strips `__sourceDir` from third-party manifests, so the
  // controller is found next to this file instead.
  readonly property string controllerPath:
    decodeURIComponent(String(Qt.resolvedUrl("controller")).replace(/^file:\/\//, ""))

  function startController() {
    if (controller.running) return
    controller.command = ["setpriv", "--pdeathsig", "TERM", controllerPath]
    controller.running = true
    sentLines = 0
    apply(Settings.start(Settings.read(configEntry()), settings))
  }

  function applyStatus(line) {
    try {
      var status = JSON.parse(String(line))
      hardwareAvailable = status.available === true
      monitor = status.monitor
      lux = status.lux
      brightness = status.brightness
      target = status.target
      error = status.error
      var learned = Settings.learnedOffset(status, sentLines, offset)
      if (learned !== null) change({ offset: learned }, false)
    } catch (e) {
      error = "Invalid controller status"
    }
  }

  Process {
    id: controller
    stdinEnabled: true
    stdout: SplitParser { onRead: function(line) { root.applyStatus(line) } }
    stderr: SplitParser { onRead: function(line) { console.warn("auto-brightness controller: " + line) } }
    onExited: function(exitCode) {
      if (root.tearingDown) return
      root.error = "Controller exited (" + exitCode + ")"
      restartTimer.restart()
    }
  }

  Timer {
    id: restartTimer
    interval: 2000
    repeat: false
    onTriggered: root.startController()
  }

  Connections {
    target: root.shell
    function onBarConfigChanged() { root.syncSettings() }
  }

  onShellChanged: syncSettings()
  onManifestChanged: startController()

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
        error: root.error
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
    function set(percent: string): string { root.setBrightness(percent); return "set " + Math.round(Number(percent)) }
  }

  Component.onDestruction: {
    tearingDown = true
    restartTimer.stop()
    controller.running = false
  }
}
