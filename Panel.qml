import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Ui
import qs.Commons

// Brightness for the display this bar is on: a slider, the Auto chip, and
// the room's light. A display without a light sensor is manual only.
// The stock Display panel is untouched; this widget only shows on a display
// the service drives.
Panel {
  id: root
  moduleName: "io.github.joaodrp.auto-brightness"
  ipcTarget: "io.github.joaodrp.auto-brightness"

  property var service: null
  readonly property string screenName: root.QsWindow.window?.screen?.name ?? ""
  // This bar's display, a DisplayChannel, or null.
  readonly property var display: service && screenName ? service.channelOn(screenName) : null
  readonly property bool available: display?.active ?? false
  readonly property bool hasSensor: display?.hasSensor ?? false
  readonly property bool autoEnabled: hasSensor && (display?.auto ?? false)
  // Points over the plain curve at the room's light, as the chip shows them.
  readonly property int offset: display?.points ?? 0
  readonly property int lux: Math.round(display?.lux ?? 0)
  readonly property string error: display ? (display.error || display.sensorError) : ""
  readonly property bool canRestore: autoEnabled && ((display?.preference ?? 0) !== 0 || offset !== 0)
  readonly property string icon: autoEnabled ? "󰃟" : "󰃠"

  // The slider follows the display, except while the pointer drags it.
  property int brightnessPercent: 0
  property real wheelAccumulator: 0

  // Keyboard cursor: -1 the slider, 0 the Auto chip, 1 the restore button.
  property bool cursorActive: false
  property int selectedIndex: -1

  function bindService() {
    service = bar && bar.shell ? bar.shell.serviceFor(root.moduleName) : null
  }
  onBarChanged: bindService()
  Component.onCompleted: bindService()

  function chipText() {
    if (!autoEnabled) return "Manual"
    return "Auto" + (offset ? (offset > 0 ? " +" : " ") + offset : "")
  }

  function setBrightness(value) {
    root.brightnessPercent = Util.clamp(Math.round(Number(value)), 1, 100)
    if (service && display) service.setBrightnessFor(display, root.brightnessPercent)
  }

  function previewBrightness(value) {
    root.brightnessPercent = Util.clamp(Math.round(Number(value)), 1, 100)
    brightnessDebounce.restart()
  }

  function showBrightnessOsd(percent) {
    if (!bar || !bar.shell) return
    bar.shell.summon("omarchy.osd", JSON.stringify({ icon: "brightness", value: percent }))
  }

  function focusCursor(index) {
    cursorActive = true
    selectedIndex = index
  }

  function moveCursor(delta) {
    selectedIndex = Util.clamp(selectedIndex + delta, -1, canRestore ? 1 : hasSensor ? 0 : -1)
  }

  function activateCursor() {
    if (!service || !display) return
    if (selectedIndex === 0 && hasSensor) service.setEnabledFor(display, !autoEnabled)
    else if (selectedIndex === 1 && canRestore) service.clearOffsetFor(display)
  }

  onOpenedChanged: {
    if (opened) {
      bindService()
      // Summoned on a monitor whose display this widget does not drive.
      if (!available) { close(); return }
      selectedIndex = -1
      cursorActive = false
    }
  }

  // Another display, or none: a value meant for the old one is dropped.
  onDisplayChanged: {
    brightnessDebounce.stop()
    if (!root.display) { if (root.opened) root.close(); return }
    if (root.display.brightness > 0) root.brightnessPercent = root.display.brightness
  }
  onAvailableChanged: {
    if (root.available) return
    brightnessDebounce.stop()
    if (root.opened) root.close()
  }
  // A control that disappears takes the cursor with it.
  onCanRestoreChanged: moveCursor(0)
  onHasSensorChanged: moveCursor(0)

  Connections {
    target: root.display
    function onBrightnessChanged() {
      if (!brightnessSlider.dragging && root.display.brightness > 0)
        root.brightnessPercent = root.display.brightness
    }
  }

  visible: available
  implicitWidth: available ? button.implicitWidth : 0
  implicitHeight: available ? button.implicitHeight : 0

  // Dragging sends at most one value per beat; the display takes one write
  // at a time anyway.
  Timer {
    id: brightnessDebounce
    interval: 180
    repeat: false
    onTriggered: root.setBrightness(root.brightnessPercent)
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.icon
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

        PanelHero {
          width: parent.width
          title: "Brightness"
          meta: !root.display ? "Starting" : (root.error || (root.hasSensor ? root.lux + " lux" : "No light sensor"))
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily
          iconComponent: Component {
            Text {
              text: root.icon
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.display
            }
          }
          trailingControl: Component {
            Row {
              spacing: Style.space(6)

              // Back to the curve. Only while a preference is set.
              Button {
                visible: root.canRestore
                iconText: "\u{F099B}"
                tooltipText: "Back to the curve, dropping " + (root.offset ? (root.offset > 0 ? "+" : "") + root.offset : "a slight preference")
                bordered: true
                foreground: root.bar.foreground
                fontFamily: root.bar.fontFamily
                hasCursor: root.cursorActive && root.selectedIndex === 1
                anchors.verticalCenter: parent.verticalCenter
                onHovered: function(on) { if (on) root.focusCursor(1) }
                onClicked: root.service.clearOffsetFor(root.display)
              }

              Button {
                visible: root.hasSensor
                text: root.chipText()
                tooltipText: root.autoEnabled ? "Switch to manual" : "Follow the room's light"
                selected: root.autoEnabled
                bordered: true
                foreground: root.bar.foreground
                fontFamily: root.bar.fontFamily
                hasCursor: root.cursorActive && root.selectedIndex === 0
                anchors.verticalCenter: parent.verticalCenter
                onHovered: function(on) { if (on) root.focusCursor(0) }
                onClicked: root.service.setEnabledFor(root.display, !root.autoEnabled)
              }
            }
          }
        }

        PanelSeparator { foreground: root.bar.foreground }

        Item {
          width: parent.width
          implicitHeight: brightnessRow.height

          CursorSurface {
            id: brightnessRow
            anchors.left: parent.left
            anchors.right: brightnessPercent.left
            anchors.rightMargin: Style.space(12)
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
              onHoveredChanged: if (hovered) root.focusCursor(-1)
            }
          }

          Text {
            id: brightnessPercent
            text: Math.round(brightnessSlider.dragging ? brightnessSlider.liveValue : root.brightnessPercent) + "%"
            width: implicitWidth < Style.space(36) ? Style.space(36) : implicitWidth
            horizontalAlignment: Text.AlignRight
            color: Qt.darker(root.bar.foreground, 1.4)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.body
            anchors.right: parent.right
            anchors.verticalCenter: brightnessRow.verticalCenter
          }
        }
      }
    }
  }
}
