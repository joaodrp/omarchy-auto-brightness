import QtQuick
import Quickshell.Io

// Owns the auto brightness controller. The desired state lives inline on this
// plugin's shell.json entry as `auto` (default on) and `offset` (default 0);
// live readings come back from the controller as JSON lines, and manual
// brightness changes go down to it over stdin so it can learn them.
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
  property int learned: 0
  property string error: "Starting"

  property bool expectedStop: false
  property bool restartPending: false

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

  function syncSettings() {
    var entry = configEntry()
    var nextEnabled = entry.auto !== false
    var nextOffset = Number.isInteger(entry.offset) ? entry.offset : 0
    var changed = enabled !== nextEnabled || offset !== nextOffset
    enabled = nextEnabled
    offset = nextOffset
    if (changed) restartController()
  }

  function persist(values) {
    if (!shell || !manifest) return
    var entry = configEntry()
    var merged = { id: manifest.id }
    for (var key in entry) if (key !== "id") merged[key] = entry[key]
    for (var name in values) merged[name] = values[name]
    shell.updateEntryInline(manifest.id, merged)
  }

  function setEnabled(value) {
    value = value === true
    if (enabled === value) return
    enabled = value
    persist({ auto: value })
    restartController()
  }

  function toggle() { setEnabled(!enabled) }

  // A brightness the user picked while auto is on. The controller keeps it
  // as an offset from the curve at the current light level.
  function noteManual(percent) {
    if (!enabled || !controller.running) return
    controller.write("manual " + Math.round(Number(percent)) + "\n")
  }

  // The controller always runs so the panel can show the toggle whenever the
  // display and its sensor are present; `--paused` only stops it writing.
  function startController() {
    if (controller.running || !manifest?.__sourceDir) return
    expectedStop = false
    var command = [
      "setpriv", "--pdeathsig", "TERM",
      manifest.__sourceDir + "/controller",
      "--offset", String(offset)
    ]
    if (!enabled) command.push("--paused")
    controller.command = command
    controller.running = true
  }

  function restartController() {
    restartTimer.stop()
    if (controller.running) {
      expectedStop = true
      restartPending = true
      controller.running = false
    } else {
      startController()
    }
  }

  function applyStatus(line) {
    try {
      var status = JSON.parse(String(line))
      hardwareAvailable = status.available === true
      monitor = status.monitor || ""
      if (typeof status.lux === "number") lux = status.lux
      if (typeof status.brightness === "number") brightness = status.brightness
      if (typeof status.target === "number") target = status.target
      if (typeof status.learned === "number") learned = status.learned
      error = status.error || ""
    } catch (e) {
      error = "Invalid controller status"
    }
  }

  Process {
    id: controller
    stdinEnabled: true
    stdout: SplitParser { onRead: function(line) { root.applyStatus(line) } }
    stderr: SplitParser {
      onRead: function(line) {
        var message = String(line).trim()
        if (message !== "") root.error = message
      }
    }
    onExited: function(exitCode) {
      if (root.expectedStop) {
        root.expectedStop = false
        if (root.restartPending) {
          root.restartPending = false
          root.startController()
        }
        return
      }
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
        learned: root.learned,
        error: root.error
      })
    }
    function enable(): string { root.setEnabled(true); return "enabled" }
    function disable(): string { root.setEnabled(false); return "disabled" }
    function toggle(): string { root.toggle(); return root.enabled ? "enabled" : "disabled" }
  }

  Component.onDestruction: {
    restartTimer.stop()
    expectedStop = true
    restartPending = false
    controller.running = false
  }
}
