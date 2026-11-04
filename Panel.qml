import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Ui
import qs.Commons

// Brightness for the display this bar is on: a slider, the Auto chip, and
// the room's light. A display without a light sensor is manual only. On the
// bar the service names for it, the keyboard backlight too, alone when
// screens are not controlled. The stock Display panel is untouched; this
// widget only shows where it has something to control.
Panel {
  id: root
  moduleName: "io.github.joaodrp.auto-brightness"
  ipcTarget: "io.github.joaodrp.auto-brightness"

  property var service: null
  readonly property string screenName: root.QsWindow.window?.screen?.name ?? ""
  // This bar's display, a DisplayChannel, or null.
  readonly property var display: service && screenName ? service.channelOn(screenName) : null
  // Shown while only blanked too, so a lock leaves the icon and an open
  // pop-up as they were.
  readonly property bool displayShown: (display?.active || display?.asleep) ?? false
  // The keyboard backlight, a KeyboardChannel, on this bar only.
  readonly property var keyboard: service && screenName && service.keyboardScreen === screenName ? service.keyboard : null
  readonly property bool keyboardShown: keyboard?.seen ?? false
  readonly property bool keyboardAuto: (keyboard?.autoActive ?? false)
  readonly property bool keyboardHasSensor: keyboard?.hasSensor ?? false
  readonly property bool keyboardCanRestore: keyboardAuto && (keyboard?.holding ?? false)
  readonly property string keyboardError: keyboard ? (keyboard.error || keyboard.sensorError) : ""
  // What needs saying about the keyboard: a fault, or why Auto is not
  // following the room; empty while it is.
  readonly property string keyboardNote: {
    if (!keyboard) return ""
    if (keyboardError) return keyboardError
    if (!keyboard.hasSensor && keyboard.paused !== "lid closed") return keyboard.paused === "lid unknown" ? "Lid state unknown" : "No light sensor"
    if (!keyboard.auto) return ""
    var why = {
      "lid closed": "Off while the lid is closed",
      "lock unknown": "Lock state unknown",
      "locked": "Paused while locked",
      "screens off": "Paused while the screens are off"
    }
    return why[keyboard.paused] || ""
  }
  readonly property bool available: displayShown || keyboardShown
  readonly property bool hasSensor: display?.hasSensor ?? false
  readonly property bool autoEnabled: hasSensor && (display?.auto ?? false)
  // Points over the plain curve at the room's light, as the chip shows them.
  readonly property int offset: display?.points ?? 0
  readonly property int lux: Math.round(display?.lux ?? 0)
  readonly property string error: display ? (display.error || display.sensorError) : ""
  readonly property bool canRestore: autoEnabled && ((display?.preference ?? 0) !== 0 || offset !== 0)
  readonly property string icon: !displayShown ? "󰌌" : autoEnabled ? "󰃟" : "󰃠"

  // The slider follows the display, except while the pointer drags it.
  property int brightnessPercent: 0
  property int keyboardPercent: 0
  property real wheelAccumulator: 0

  // Keyboard cursor: -1 the slider, 0 the Auto chip, 1 the restore button;
  // 2, 3 and 4 the keyboard backlight's, in that order.
  property bool cursorActive: false
  property int selectedIndex: -1

  function cursorStops() {
    var stops = []
    if (displayShown) {
      stops.push(-1)
      if (hasSensor) stops.push(0)
      if (canRestore) stops.push(1)
    }
    if (keyboardShown) {
      stops.push(2)
      if (keyboard.hasSensor) stops.push(3)
      if (keyboardCanRestore) stops.push(4)
    }
    return stops
  }

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

  function setKeyboard(value) {
    root.keyboardPercent = Util.clamp(Math.round(Number(value)), 0, 100)
    // Refused, as under a closed lid: the slider goes back to the keys.
    if (service && keyboard && !service.setKeyboardBrightness(root.keyboardPercent)) root.keyboardPercent = keyboard.brightness
  }

  function previewKeyboard(value) {
    root.keyboardPercent = Util.clamp(Math.round(Number(value)), 0, 100)
    keyboardDebounce.restart()
  }

  function previewBrightness(value) {
    root.brightnessPercent = Util.clamp(Math.round(Number(value)), 1, 100)
    brightnessDebounce.restart()
  }

  function showOsd(icon, percent) {
    if (!bar || !bar.shell) return
    bar.shell.summon("omarchy.osd", JSON.stringify({ icon: icon, value: percent }))
  }

  function focusCursor(index) {
    cursorActive = true
    selectedIndex = index
  }

  // To the next stop `delta` away, or the nearest when the one selected
  // has gone.
  function moveCursor(delta) {
    var stops = cursorStops()
    if (!stops.length) return
    var at = stops.indexOf(selectedIndex)
    if (at === -1) {
      at = 0
      while (at < stops.length - 1 && stops[at] < selectedIndex) at++
    } else {
      at = Util.clamp(at + delta, 0, stops.length - 1)
    }
    selectedIndex = stops[at]
  }

  function activateCursor() {
    if (!service) return
    if (selectedIndex === 0 && display && hasSensor) service.setEnabledFor(display, !autoEnabled)
    else if (selectedIndex === 1 && display && canRestore) service.clearOffsetFor(display)
    else if (selectedIndex === 3 && keyboard?.hasSensor) service.setKeyboardAuto(!keyboard.auto)
    else if (selectedIndex === 4 && keyboardCanRestore) service.forgetKeyboard()
  }

  onOpenedChanged: {
    if (opened) {
      bindService()
      // Summoned on a monitor whose display this widget does not drive.
      if (!available) { close(); return }
      selectedIndex = displayShown ? -1 : 2
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
  onKeyboardChanged: {
    keyboardDebounce.stop()
    if (root.keyboard) root.keyboardPercent = root.keyboard.brightness
  }
  // A control that disappears takes the cursor with it.
  onCanRestoreChanged: moveCursor(0)
  onHasSensorChanged: moveCursor(0)
  onDisplayShownChanged: moveCursor(0)
  onKeyboardShownChanged: moveCursor(0)
  onKeyboardCanRestoreChanged: moveCursor(0)
  onKeyboardHasSensorChanged: moveCursor(0)

  Connections {
    target: root.display
    function onBrightnessChanged() {
      if (!brightnessSlider.dragging && root.display.brightness > 0)
        root.brightnessPercent = root.display.brightness
    }
  }

  // Zero included: the keys can be off.
  Connections {
    target: root.keyboard
    function onBrightnessChanged() {
      if (!keyboardSlider.dragging) root.keyboardPercent = root.keyboard.brightness
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
  Timer {
    id: keyboardDebounce
    interval: 180
    repeat: false
    onTriggered: root.setKeyboard(root.keyboardPercent)
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
      if (!root.displayShown) {
        root.setKeyboard(root.keyboardPercent + wheel.steps * 5)
        root.showOsd("keyboard", root.keyboardPercent)
        return
      }
      root.setBrightness(root.brightnessPercent + wheel.steps * 5)
      root.showOsd("brightness", root.brightnessPercent)
    }
  }

  // The display's restore button and Auto chip, in the hero or its section.
  Component {
    id: displayControls
    Row {
      spacing: Style.space(6)

      // Only while a preference is set.
      Button {
        visible: root.canRestore
        iconText: "\u{F099B}"
        tooltipText: "Reset brightness preference"
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
        tooltipText: root.autoEnabled ? "Switch to manual brightness" : "Turn on auto brightness"
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

  // The keyboard's restore button and Auto chip, in the hero or its section.
  Component {
    id: keyboardControls
    Row {
      spacing: Style.space(6)

      // Only while a level is held.
      Button {
        visible: root.keyboardCanRestore
        iconText: "\u{F099B}"
        tooltipText: "Resume auto brightness"
        bordered: true
        foreground: root.bar.foreground
        fontFamily: root.bar.fontFamily
        hasCursor: root.cursorActive && root.selectedIndex === 4
        anchors.verticalCenter: parent.verticalCenter
        onHovered: function(on) { if (on) root.focusCursor(4) }
        onClicked: root.service.forgetKeyboard()
      }

      Button {
        visible: root.keyboard?.hasSensor ?? false
        text: root.keyboardAuto ? "Auto" : "Manual"
        tooltipText: root.keyboardAuto ? "Switch to manual brightness" : "Turn on auto brightness"
        selected: root.keyboardAuto
        bordered: true
        foreground: root.bar.foreground
        fontFamily: root.bar.fontFamily
        hasCursor: root.cursorActive && root.selectedIndex === 3
        anchors.verticalCenter: parent.verticalCenter
        onHovered: function(on) { if (on) root.focusCursor(3) }
        onClicked: root.service.setKeyboardAuto(!root.keyboard.auto)
      }
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
        else if (dx !== 0 && root.selectedIndex === 2) root.setKeyboard(root.keyboardPercent + dx * 5)
      }
      onActivateRequested: if (root.cursorActive) root.activateCursor()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: panelColumn
        width: parent.width
        spacing: Style.space(14)

        PanelHero {
          visible: root.displayShown
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
          // With the keyboard below, each section carries its own.
          trailingControl: root.keyboardShown ? null : displayControls
        }

        PanelSeparator { visible: root.displayShown; foreground: root.bar.foreground }

        // Beside the keyboard, the display's slider is its own section.
        Item {
          visible: root.displayShown && root.keyboardShown
          width: parent.width
          implicitHeight: Math.max(screenHeader.implicitHeight, screenControls.implicitHeight)

          PanelSectionHeader {
            id: screenHeader
            text: "SCREEN"
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
          }

          Loader {
            id: screenControls
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            sourceComponent: root.keyboardShown ? displayControls : null
          }
        }

        Item {
          visible: root.displayShown
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
            font.pixelSize: Style.font.caption
            font.bold: true
            anchors.right: parent.right
            anchors.verticalCenter: brightnessRow.verticalCenter
          }
        }

        PanelSeparator { visible: root.displayShown && root.keyboardShown; foreground: root.bar.foreground }

        // Alone, the keyboard opens like any panel.
        PanelHero {
          visible: root.keyboardShown && !root.displayShown
          width: parent.width
          title: "Keyboard"
          meta: root.keyboardNote || (root.keyboard?.hasSensor ? Math.round(root.keyboard.lux) + " lux" : "")
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
          trailingControl: keyboardControls
        }

        // Under the display's: its light is the same, so only a note.
        Item {
          visible: root.keyboardShown && root.displayShown
          width: parent.width
          implicitHeight: Math.max(keyboardTitle.implicitHeight, keyboardHeader.implicitHeight)

          Column {
            id: keyboardTitle
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter

            PanelSectionHeader {
              text: "KEYBOARD"
              foreground: root.bar.foreground
              fontFamily: root.bar.fontFamily
            }
          }

          Loader {
            id: keyboardHeader
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            sourceComponent: keyboardControls
          }
        }

        // Its own line: it can be as long as the row.
        Text {
          visible: root.keyboardShown && root.displayShown && text !== ""
          width: parent.width
          text: root.keyboardNote
          wrapMode: Text.WordWrap
          color: Qt.darker(root.bar.foreground, 1.4)
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.caption
        }

        Item {
          visible: root.keyboardShown
          width: parent.width
          implicitHeight: keyboardRow.height

          CursorSurface {
            id: keyboardRow
            anchors.left: parent.left
            anchors.right: keyboardPercentText.left
            anchors.rightMargin: Style.space(12)
            height: keyboardSlider.implicitHeight + Style.spacing.controlGap
            hasCursor: root.cursorActive && root.selectedIndex === 2
            foreground: root.bar.foreground
            outline: true

            PanelSlider {
              id: keyboardSlider
              bar: root.bar
              anchors.fill: parent
              anchors.leftMargin: Style.space(6)
              anchors.rightMargin: Style.space(6)
              minimum: 0
              maximum: 100
              step: 1
              value: root.keyboardPercent
              integer: true
              onMoved: function(v) { root.previewKeyboard(v) }
              onReleased: function(v) {
                keyboardDebounce.stop()
                root.setKeyboard(v)
              }
            }

            HoverHandler {
              onHoveredChanged: if (hovered) root.focusCursor(2)
            }
          }

          Text {
            id: keyboardPercentText
            text: Math.round(keyboardSlider.dragging ? keyboardSlider.liveValue : root.keyboardPercent) + "%"
            width: implicitWidth < Style.space(36) ? Style.space(36) : implicitWidth
            horizontalAlignment: Text.AlignRight
            color: Qt.darker(root.bar.foreground, 1.4)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
            anchors.right: parent.right
            anchors.verticalCenter: keyboardRow.verticalCenter
          }
        }
      }
    }
  }
}
