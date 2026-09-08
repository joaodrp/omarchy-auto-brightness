#!/usr/bin/env python3
"""Apply this plugin's changes to a pristine copy of Omarchy's Display panel.

Re-run after an Omarchy update:
  cp ~/.local/share/omarchy/shell/plugins/panels/monitor/{Panel.qml,Model.js} . && ./patch-panel.py

Every edit is anchored on an exact upstream snippet and fails loudly if the
anchor moved, so an upstream change never gets silently half-applied.
"""
import pathlib, sys

path = pathlib.Path(__file__).with_name("Panel.qml")
src = path.read_text()
MARK = "io.github.joaodrp.studio-display"
if MARK in src:
    sys.exit("Panel.qml is already patched; start from a pristine upstream copy")

def edit(anchor, replacement, count=1):
    global src
    found = src.count(anchor)
    if found != count:
        sys.exit(f"anchor found {found}x, expected {count}:\n{anchor}")
    src = src.replace(anchor, replacement)

# 1. Service hookup.
edit(
"""  property int enabledDisplayCount: 0
""",
"""  property int enabledDisplayCount: 0

  // Auto brightness lives in this plugin's service; the panel reflects and
  // flips it. Any manual brightness change made here switches it off.
  property var autoService: null
  readonly property bool autoAvailable: !!autoService && autoService.hardwareAvailable
  readonly property bool autoEnabled: !!autoService && autoService.enabled
  function bindAutoService() {
    autoService = bar && bar.shell ? bar.shell.serviceFor("io.github.joaodrp.studio-display") : null
  }
  function setAuto(on) { if (autoService) autoService.setEnabled(on) }
  onBarChanged: bindAutoService()
""")

# 2. Manual brightness from the panel turns auto off.
edit(
"""  function setBrightness(value) {
    var percent = Model.clampBrightness(value)
""",
"""  function setBrightness(value) {
    var percent = Model.clampBrightness(value)
    if (root.autoEnabled) root.setAuto(false)
""")

# 3. Enter on the brightness row toggles auto.
edit(
"""  function activateCursor() {
""",
"""  function activateCursor() {
    if (focusSection === "brightness" && root.autoAvailable) {
      root.setAuto(!root.autoEnabled)
      return
    }
""")

# 4. Re-resolve the service on every open; services can register after the bar.
edit(
"""  Component.onCompleted: refresh()
""",
"""  Component.onCompleted: {
    bindAutoService()
    refresh()
  }
""")
edit(
"""    if (opened) {
      refresh()
""",
"""    if (opened) {
      bindAutoService()
      refresh()
""")

# 5. Hero status shows auto mode.
edit(
"""                  if (root.brightnessAvailable) {
                    return root.brightnessName(brightnessSlider.dragging ? brightnessSlider.liveValue : root.brightnessPercent).toUpperCase()
                  }
""",
"""                  if (root.brightnessAvailable) {
                    var name = root.brightnessName(brightnessSlider.dragging ? brightnessSlider.liveValue : root.brightnessPercent).toUpperCase()
                    return root.autoEnabled ? "AUTO \\u00b7 " + name : name
                  }
""")

# 6. Auto switch on the trailing edge of the brightness header.
edit(
"""              implicitHeight: Math.max(brightnessHeader.implicitHeight, brightnessPercent.implicitHeight)
""",
"""              implicitHeight: Math.max(brightnessHeader.implicitHeight, brightnessPercent.implicitHeight, autoSwitch.implicitHeight)
""")
edit(
"""                font.bold: true
                anchors.right: parent.right
                anchors.rightMargin: Style.space(6)
                anchors.verticalCenter: parent.verticalCenter
              }
            }

            CursorSurface {
              id: brightnessRow
""",
"""                font.bold: true
                anchors.right: autoSwitch.visible ? autoSwitch.left : parent.right
                anchors.rightMargin: Style.space(6)
                anchors.verticalCenter: parent.verticalCenter
              }

              ToggleSwitch {
                id: autoSwitch
                visible: root.autoAvailable
                checked: root.autoEnabled
                trackHeight: 16
                cursorPad: Style.space(3)
                foreground: root.bar.foreground
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                onHovered: function(on) {
                  if (on && !root.reflowingText) {
                    root.cursorActive = true
                    root.focusSection = "brightness"
                    root.selectedIndex = -1
                  }
                }
                onToggled: root.setAuto(!root.autoEnabled)

                PanelToolTip {
                  visible: autoSwitch.containsMouse
                  text: (root.autoEnabled ? "Auto brightness on" : "Auto brightness off")
                        + (root.autoService ? " \\u00b7 " + Math.round(root.autoService.lux) + " lux" : "")
                        + " \\u00b7 Enter toggles"
                  fontFamily: root.bar.fontFamily
                }
              }
            }

            CursorSurface {
              id: brightnessRow
""")

path.write_text(src)
print("patched", path.name)
