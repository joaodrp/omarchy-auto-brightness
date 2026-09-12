import QtQuick
import QtQuick.Controls
import Quickshell.Io
import qs.Ui
import qs.Commons

// Brightness for the Apple Studio Display: a slider, the Auto chip, and
// the room's light.
// The stock Display panel is untouched; this widget only shows while an
// Apple display with a light sensor is connected.
Panel {
  id: root
  moduleName: "io.github.joaodrp.auto-brightness"
  ipcTarget: "io.github.joaodrp.auto-brightness"

  property var service: null
  readonly property bool available: service?.hardwareAvailable ?? false
  readonly property bool autoEnabled: service?.enabled ?? false
  readonly property int offset: service?.offset ?? 0
  readonly property int lux: Math.round(service?.lux ?? 0)
  readonly property bool canRestore: autoEnabled && offset !== 0
  readonly property string icon: autoEnabled ? "󰃟" : "󰃠"

  // The slider follows the controller, except while the pointer drags it.
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
    if (service) service.setBrightness(root.brightnessPercent)
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
    selectedIndex = Util.clamp(selectedIndex + delta, -1, canRestore ? 1 : 0)
  }

  function activateCursor() {
    if (!service) return
    if (selectedIndex === 0) service.setEnabled(!autoEnabled)
    else if (selectedIndex === 1) service.clearOffset()
  }

  onOpenedChanged: {
    if (opened) {
      bindService()
      selectedIndex = -1
      cursorActive = false
    }
  }

  Connections {
    target: root.service
    function onBrightnessChanged() {
      if (!brightnessSlider.dragging && root.service.brightness > 0)
        root.brightnessPercent = root.service.brightness
    }
  }

  visible: available
  implicitWidth: available ? button.implicitWidth : 0
  implicitHeight: available ? button.implicitHeight : 0

  // Dragging sends at most one value per beat; the controller writes at most
  // one per poll anyway.
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
          meta: !root.service ? "Starting" : (root.service.error || root.lux + " lux")
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

              // Back to the curve. Only while an offset is set.
              Button {
                visible: root.canRestore
                iconText: "\u{F099B}"
                tooltipText: "Back to the curve, dropping " + (root.offset > 0 ? "+" : "") + root.offset
                bordered: true
                foreground: root.bar.foreground
                fontFamily: root.bar.fontFamily
                hasCursor: root.cursorActive && root.selectedIndex === 1
                anchors.verticalCenter: parent.verticalCenter
                onHovered: function(on) { if (on) root.focusCursor(1) }
                onClicked: root.service.clearOffset()
              }

              Button {
                text: root.chipText()
                tooltipText: root.autoEnabled ? "Switch to manual" : "Follow the room's light"
                selected: root.autoEnabled
                bordered: true
                foreground: root.bar.foreground
                fontFamily: root.bar.fontFamily
                hasCursor: root.cursorActive && root.selectedIndex === 0
                anchors.verticalCenter: parent.verticalCenter
                onHovered: function(on) { if (on) root.focusCursor(0) }
                onClicked: root.service.setEnabled(!root.autoEnabled)
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
