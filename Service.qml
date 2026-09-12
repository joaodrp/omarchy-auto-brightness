import QtQuick
import Quickshell.Io

// Owns the auto brightness controller. Settings live inline on this plugin's
// shell.json entry as `auto` (default on) and `offset` (default 0) and are
// pushed to the controller over stdin; every change, from the panel, Setup,
// IPC or a hotkey the controller noticed, goes through shell.json so there is
// one path. Live readings come back as JSON lines.
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

  function configEntry() {
    var config = shell?.shellConfig
    var sections = ["left", "center", "right"]
    var layout = config?.bar?.layout
    for (var s = 0; layout && s < sections.length; s++) {
      var entries = layout[sections[s]] || []
      for (var i = 0; i < entries.length; i++)
        if (entries[i]?.id === manifest?.id) return entries[i]
    }
    var plugins = config?.plugins || []
    for (var p = 0; p < plugins.length; p++)
      if (plugins[p]?.id === manifest?.id) return plugins[p]
    return ({})
  }

  function send(line) {
    if (controller.running) controller.write(line + "\n")
  }

  // Read the persisted settings and push them. Idempotent, so it runs on
  // every config change and right after the controller starts.
  function syncSettings() {
    var entry = configEntry()
    enabled = entry.auto !== false
    offset = Number.isInteger(entry.offset) ? entry.offset : 0
    send("auto " + (enabled ? "on" : "off"))
    send("offset " + offset)
  }

  function persist(values) {
    if (!shell || !manifest) return
    shell.updateEntryInline(manifest.id, Object.assign({}, configEntry(), values, { id: manifest.id }))
  }

  function setEnabled(value) { persist({ auto: value === true }) }
  function setOffset(value) { persist({ offset: Math.round(Number(value)) }) }
  function clearOffset() { setOffset(0) }

  // The user picked a brightness. The controller writes it, and with auto on
  // turns it into the offset, which comes back in its status.
  function setBrightness(percent) { send("manual " + Math.round(Number(percent))) }

  function startController() {
    if (controller.running || !manifest?.__sourceDir) return
    controller.command = ["setpriv", "--pdeathsig", "TERM", manifest.__sourceDir + "/controller"]
    controller.running = true
    syncSettings()
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
      if (status.offset !== offset) {
        // Set before persisting so the config change reads as already known.
        offset = status.offset
        persist({ offset: status.offset })
      }
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
    function onShellConfigChanged() { root.syncSettings() }
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
    function toggle(): string { root.setEnabled(!root.enabled); return root.enabled ? "disabled" : "enabled" }
    function forget(): string { root.clearOffset(); return "forgot" }
  }

  Component.onDestruction: {
    tearingDown = true
    restartTimer.stop()
    controller.running = false
  }
}
