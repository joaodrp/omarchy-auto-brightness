import QtQuick
import Quickshell.Io

// Owns the auto brightness controller. The desired state lives inline on this
// plugin's shell.json entry as `auto` (default on) and `offset` (default 0),
// which a manual change while auto is on rewrites through the controller;
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

  function readSettings() {
    var entry = configEntry()
    return {
      enabled: entry.auto !== false,
      offset: Number.isInteger(entry.offset) ? entry.offset : 0
    }
  }

  function syncSettings() {
    var next = readSettings()
    var changed = enabled !== next.enabled || offset !== next.offset
    enabled = next.enabled
    offset = next.offset
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

  // A brightness the user picked while auto is on. The controller turns it
  // into the offset, which comes back in its status and is persisted there.
  function noteManual(percent) {
    if (!enabled || !controller.running) return
    controller.write("manual " + Math.round(Number(percent)) + "\n")
  }

  // Clear the offset and go back to the curve.
  function clearOffset() {
    if (!controller.running) return
    controller.write("forget\n")
  }

  // The controller always runs so the panel can show the toggle whenever the
  // display and its sensor are present; `--paused` only stops it writing.
  function startController() {
    if (controller.running || !manifest?.__sourceDir) return
    // The shell and the manifest arrive in either order; read the persisted
    // settings now so the controller never starts with the defaults.
    var current = readSettings()
    enabled = current.enabled
    offset = current.offset
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
    // A process being stopped can still flush a line; it must not win over
    // the settings the restart is about to apply.
    if (expectedStop) return
    try {
      var status = JSON.parse(String(line))
      hardwareAvailable = status.available === true
      monitor = status.monitor || ""
      if (typeof status.lux === "number") lux = status.lux
      if (typeof status.brightness === "number") brightness = status.brightness
      if (typeof status.target === "number") target = status.target
      if (typeof status.offset === "number" && status.offset !== offset) {
        // Set before persisting so the config change is not seen as a new
        // value that restarts the controller.
        offset = status.offset
        persist({ offset: status.offset })
      }
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
        offset: root.offset,
        error: root.error
      })
    }
    function enable(): string { root.setEnabled(true); return "enabled" }
    function disable(): string { root.setEnabled(false); return "disabled" }
    function toggle(): string { root.toggle(); return root.enabled ? "enabled" : "disabled" }
    function forget(): string { root.clearOffset(); return "forgot" }
  }

  Component.onDestruction: {
    restartTimer.stop()
    expectedStop = true
    restartPending = false
    controller.running = false
  }
}
