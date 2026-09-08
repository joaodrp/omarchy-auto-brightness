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
  // flips it. A manual brightness change made here is reported to it, and
  // becomes a learned correction at the current light level.
  property var autoService: null
  readonly property bool autoAvailable: !!autoService && autoService.hardwareAvailable
  readonly property bool autoEnabled: !!autoService && autoService.enabled
  function bindAutoService() {
    autoService = bar && bar.shell ? bar.shell.serviceFor("io.github.joaodrp.studio-display") : null
  }
  function setAuto(on) { if (autoService) autoService.setEnabled(on) }
  function autoDetail() {
    if (!autoEnabled || !autoService) return ""
    var learned = autoService.learned
    if (learned) return "Learned " + (learned > 0 ? "+" : "") + learned + " at " + Math.round(autoService.lux) + " lux"
    return Math.round(autoService.lux) + " lux"
  }
  onBarChanged: bindAutoService()
""")

# 2. Manual brightness from the panel is learned by the controller.
edit(
"""  function setBrightness(value) {
    var percent = Model.clampBrightness(value)
""",
"""  function setBrightness(value) {
    var percent = Model.clampBrightness(value)
    if (root.autoEnabled) root.autoService.noteManual(percent)
""")

# 3. Keyboard model: the brightness section gains a second target, the
#    auto row at index 0, below the slider's -1 sentinel.
edit(
"""    if (section === "brightness") return 0  // only the slider sentinel at -1
""",
"""    if (section === "brightness") return root.autoAvailable ? 1 : 0  // slider at -1, auto row at 0
""")
edit(
"""    return section === "brightness" || section === "textsize" || section === "scale"
""",
"""    if (section === "brightness") return !root.autoAvailable
    return section === "textsize" || section === "scale"
""")
edit(
"""      if (!inSingleRow && selectedIndex > 0) { selectedIndex = selectedIndex - 1; return }
""",
"""      if (!inSingleRow && selectedIndex > sectionFirstIndex(focusSection)) { selectedIndex = selectedIndex - 1; return }
""")
edit(
"""    if (selectedIndex > count - 1) selectedIndex = count - 1
    if (selectedIndex < 0) selectedIndex = 0
""",
"""    if (selectedIndex > count - 1) selectedIndex = count - 1
    if (selectedIndex < sectionFirstIndex(focusSection)) selectedIndex = sectionFirstIndex(focusSection)
""")
edit(
"""  function adjustBrightness(delta) {
    if (focusSection !== "brightness") return
""",
"""  function adjustBrightness(delta) {
    if (focusSection !== "brightness" || selectedIndex !== -1) return
""")
edit(
"""  function activateCursor() {
""",
"""  function activateCursor() {
    if (focusSection === "brightness" && selectedIndex === 0 && root.autoAvailable) {
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

# 5. Follow the controller's ramp live; the panel's 5 s state poll is too
#    slow to show it moving.
edit(
"""  onVisibleSectionsChanged: clampCursor()
""",
"""  onVisibleSectionsChanged: clampCursor()

  Connections {
    target: root.autoService
    function onBrightnessChanged() {
      if (!root.autoEnabled || brightnessSlider.dragging) return
      var value = root.autoService.brightness
      if (value > 0) root.brightnessPercent = value
    }
  }
""")

# 6. A self-labelled chip beside the section header: the same selectable
#    button the scale presets use, so "on" is the selected fill.
edit(
"""              implicitHeight: Math.max(brightnessHeader.implicitHeight, brightnessPercent.implicitHeight)
""",
"""              implicitHeight: Math.max(brightnessHeader.implicitHeight, brightnessPercent.implicitHeight, autoChip.implicitHeight)
""")
edit(
"""                anchors.right: parent.right
                anchors.rightMargin: Style.space(6)
                anchors.verticalCenter: parent.verticalCenter
              }
            }

            CursorSurface {
              id: brightnessRow
""",
"""                anchors.right: parent.right
                anchors.rightMargin: Style.space(6)
                anchors.verticalCenter: parent.verticalCenter
              }

              Button {
                id: autoChip
                visible: root.autoAvailable
                text: {
                  if (!root.autoEnabled) return "Manual"
                  var learned = root.autoService ? root.autoService.learned : 0
                  return "Auto" + (learned ? (learned > 0 ? " +" : " ") + learned : "")
                }
                tooltipText: root.autoDetail() || "Follow the room's light"
                selected: root.autoEnabled
                bordered: true
                fontSize: Style.font.caption
                horizontalPadding: Style.space(8)
                verticalPadding: Style.space(2)
                foreground: root.bar.foreground
                fontFamily: root.bar.fontFamily
                hasCursor: root.cursorActive && root.focusSection === "brightness" && root.selectedIndex === 0
                anchors.left: brightnessHeader.right
                anchors.leftMargin: Style.space(10)
                anchors.verticalCenter: parent.verticalCenter
                anchors.verticalCenterOffset: brightnessHeader.topPadding / 2
                onHovered: function(on) {
                  if (on && !root.reflowingText) {
                    root.cursorActive = true
                    root.focusSection = "brightness"
                    root.selectedIndex = 0
                  }
                }
                onClicked: root.setAuto(!root.autoEnabled)
              }
            }

            CursorSurface {
              id: brightnessRow
""")

path.write_text(src)
print("patched", path.name)
