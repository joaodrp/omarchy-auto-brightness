import QtQuick
import QtQuick.Controls
import Quickshell.Io
import qs.Ui
import qs.Commons

// Studio Display brightness: a slider, the Auto chip, and the room's light.
// The stock Display panel is untouched; this widget only shows while an
// Apple display with a light sensor is connected.
Panel {
  id: root
  moduleName: "io.github.joaodrp.studio-display"
  ipcTarget: "io.github.joaodrp.studio-display"

  property var service: null
  readonly property bool available: !!service && service.hardwareAvailable
  readonly property bool autoEnabled: !!service && service.enabled
  readonly property string monitor: service ? service.monitor : ""

  property int brightnessPercent: 0
  property int pendingBrightnessPercent: 0
  property bool brightnessSetQueued: false
  property real wheelAccumulator: 0

  // Keyboard cursor: -1 is the slider, 0 is the Auto chip.
  property bool cursorActive: false
  property int selectedIndex: -1

  function bindService() {
    service = bar && bar.shell ? bar.shell.serviceFor(root.moduleName) : null
  }
  onBarChanged: bindService()
  Component.onCompleted: {
    bindService()
    refresh()
  }

  function refresh() {
    if (root.monitor === "" || stateProc.running) return
    stateProc.command = ["omarchy-brightness-display", "--monitor", root.monitor]
    stateProc.running = true
  }

  function setAuto(on) { if (service) service.setEnabled(on) }

  function autoDetail() {
    if (!autoEnabled || !service) return ""
    var learned = service.learned
    if (learned) return "Learned " + (learned > 0 ? "+" : "") + learned + " at " + Math.round(service.lux) + " lux"
    return Math.round(service.lux) + " lux"
  }

  function chipText() {
    if (!autoEnabled) return "Manual"
    var learned = service ? service.learned : 0
    return "Auto" + (learned ? (learned > 0 ? " +" : " ") + learned : "")
  }

  function setBrightness(value) {
    var percent = Math.max(1, Math.min(100, Math.round(Number(value))))
    root.brightnessPercent = percent
    root.pendingBrightnessPercent = percent
    if (root.autoEnabled) root.service.noteManual(percent)

    if (setBrightnessProc.running) {
      root.brightnessSetQueued = true
      return
    }
    root.brightnessSetQueued = false
    setBrightnessProc.command = ["omarchy-brightness-display", "--no-osd", "--monitor", root.monitor, percent + "%"]
    setBrightnessProc.running = true
  }

  function previewBrightness(value) {
    root.brightnessPercent = Math.max(1, Math.min(100, Math.round(Number(value))))
    brightnessDebounce.restart()
  }

  function showBrightnessOsd(percent) {
    if (!bar || !bar.shell) return
    bar.shell.summon("omarchy.osd", JSON.stringify({ icon: "brightness", value: percent }))
  }

  function moveCursor(delta) {
    var next = selectedIndex + delta
    selectedIndex = Math.max(-1, Math.min(0, next))
  }

  function activateCursor() {
    if (selectedIndex === 0) root.setAuto(!root.autoEnabled)
  }

  onOpenedChanged: {
    if (opened) {
      bindService()
      refresh()
      selectedIndex = -1
      cursorActive = false
    }
  }

  // Follow the controller's ramp live while auto is on.
  Connections {
    target: root.service
    function onBrightnessChanged() {
      if (!root.autoEnabled || brightnessSlider.dragging) return
      var value = root.service.brightness
      if (value > 0) root.brightnessPercent = value
    }
  }

  visible: available
  implicitWidth: available ? button.implicitWidth : 0
  implicitHeight: available ? button.implicitHeight : 0

  Timer {
    interval: 5000
    running: root.opened
    repeat: true
    onTriggered: root.refresh()
  }

  Process {
    id: stateProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var value = parseInt(String(text || "").trim(), 10)
        if (!isNaN(value) && !brightnessSlider.dragging) root.brightnessPercent = Math.max(0, Math.min(100, value))
      }
    }
  }

  Timer {
    id: brightnessDebounce
    interval: 180
    repeat: false
    onTriggered: root.setBrightness(root.brightnessPercent)
  }

  Process {
    id: setBrightnessProc
    stdout: StdioCollector { waitForEnd: true }
    onRunningChanged: {
      if (running) return
      if (root.brightnessSetQueued) root.setBrightness(root.pendingBrightnessPercent)
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.autoEnabled ? "󰃟" : "󰃠"
    onPressed: function(b) { root.toggle() }
    onWheelMoved: function(delta) {
      var wheel = Util.wheelSteps(root.wheelAccumulator, delta)
      root.wheelAccumulator = wheel.remainder
      if (wheel.steps === 0) return
      root.setBrightness(root.brightnessPercent + wheel.steps * 5)
      root.showBrightnessOsd(root.brightnessPercent)
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(panelColumn.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        if (dy !== 0) root.moveCursor(dy)
        else if (dx !== 0 && root.selectedIndex === -1) root.setBrightness(root.brightnessPercent + dx * 5)
      }
      onActivateRequested: if (root.cursorActive) root.activateCursor()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: panelColumn
        width: parent.width
        spacing: Style.space(14)

        // ---------- Hero ----------
        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight)

          Text {
            id: heroIcon
            text: "󰍹"
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.display
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
          }

          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(14)
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              text: "Studio Display"
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
              width: parent.width
            }

            Text {
              text: {
                if (!root.service) return "STARTING"
                if (root.service.error) return root.service.error.toUpperCase()
                var lux = Math.round(root.service.lux)
                return root.autoEnabled ? lux + " LUX · FOLLOWING THE ROOM" : lux + " LUX · MANUAL"
              }
              color: Qt.darker(root.bar.foreground, 1.4)
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
              elide: Text.ElideRight
              width: parent.width
            }
          }
        }

        // ---------- Brightness ----------
        PanelSeparator { foreground: root.bar.foreground }

        Column {
          width: parent.width
          spacing: Style.space(6)

          Item {
            width: parent.width
            implicitHeight: Math.max(brightnessHeader.implicitHeight, brightnessPercent.implicitHeight, autoChip.implicitHeight)

            PanelSectionHeader {
              id: brightnessHeader
              text: "BRIGHTNESS"
              foreground: root.bar.foreground
              fontFamily: root.bar.fontFamily
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
            }

            Button {
              id: autoChip
              text: root.chipText()
              tooltipText: root.autoDetail() || "Follow the room's light"
              selected: root.autoEnabled
              bordered: true
              fontSize: Style.font.caption
              horizontalPadding: Style.space(8)
              verticalPadding: Style.space(2)
              foreground: root.bar.foreground
              fontFamily: root.bar.fontFamily
              hasCursor: root.cursorActive && root.selectedIndex === 0
              anchors.left: brightnessHeader.right
              anchors.leftMargin: Style.space(10)
              anchors.verticalCenter: parent.verticalCenter
              anchors.verticalCenterOffset: brightnessHeader.topPadding / 2
              onHovered: function(on) {
                if (on) { root.cursorActive = true; root.selectedIndex = 0 }
              }
              onClicked: root.setAuto(!root.autoEnabled)
            }

            Text {
              id: brightnessPercent
              text: Math.round(brightnessSlider.dragging ? brightnessSlider.liveValue : root.brightnessPercent) + "%"
              color: Qt.darker(root.bar.foreground, 1.4)
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              anchors.right: parent.right
              anchors.rightMargin: Style.space(6)
              anchors.baseline: brightnessHeader.baseline
            }
          }

          CursorSurface {
            id: brightnessRow
            width: parent.width
            height: brightnessSlider.implicitHeight + Style.spacing.controlGap
            hasCursor: root.cursorActive && root.selectedIndex === -1
            foreground: root.bar.foreground
            outline: true

            PanelSlider {
              id: brightnessSlider
              bar: root.bar
              anchors.fill: parent
              anchors.leftMargin: Style.space(6)
              anchors.rightMargin: Style.space(6)
              minimum: 1
              maximum: 100
              step: 1
              value: root.brightnessPercent
              integer: true
              onMoved: function(v) { root.previewBrightness(v) }
              onReleased: function(v) {
                brightnessDebounce.stop()
                root.setBrightness(v)
              }
            }

            HoverHandler {
              onHoveredChanged: if (hovered) { root.cursorActive = true; root.selectedIndex = -1 }
            }
          }
        }
      }
    }
  }
}
