// Pure, Qt-free display and sensor inventory, so it runs under node too
// (test/inventory.test.js). The service gathers the facts (Hyprland's
// outputs, the IIO sensors, the lid, each output's EDID) and asks here which
// displays exist, which are active, how each is driven and which sensor
// serves it.
//
// A display is driven by one of three kinds:
//   apple  the Studio Display over USB, through Omarchy's Apple helper
//   panel  the laptop's internal output, through its backlight
//   ddc    any other external, over DDC/CI; whether it answers is the
//          adapter's to find out
// Omarchy's Apple helper addresses one device, so two Apple displays cannot
// be told apart: both are refused rather than guessed.

function isInternal(name) { return /^(eDP|LVDS|DSI)-/.test(name) }
function isApple(monitor) { return monitor.make === "Apple Computer Inc" }

// A stable key for a display's settings: what it is, not where it is
// plugged. The internal panel is the machine's own, whatever its EDID says.
// A display without a serial cannot be told from its twin, so it is keyed
// by its port too.
function identity(monitor) {
  if (isInternal(monitor.name)) return "internal"
  var key = JSON.stringify([monitor.make || "", monitor.model || "", monitor.serial || ""])
  return monitor.serial ? key : key + "@" + monitor.name
}

// HDR Static Metadata from the CTA data blocks in bytes [start, end), or
// null. A block whose payload runs past `end` ends the walk; a maximum of
// code 0 is unspecified.
function hdrLuminance(bytes, start, end) {
  for (var i = start; i < end;) {
    var tag = bytes[i] >> 5, len = bytes[i] & 0x1f
    if (i + len >= end) return null
    if (tag === 7 && len >= 4 && bytes[i + 1] === 0x06 && bytes[i + 4] > 0) {
      var peak = 50 * Math.pow(2, bytes[i + 4] / 32)
      var floor = len >= 6 ? peak * Math.pow(bytes[i + 6] / 255, 2) / 100 : 0
      return { peak: peak, floor: floor }
    }
    i += len + 1
  }
  return null
}

// Peak and floor luminance in nits from an EDID, as `od -An -v -tx1` prints
// it: the first HDR Static Metadata block, in a CTA-861 extension or in a
// DisplayID extension's CTA data block. Null when there is none.
function edidLuminance(hex) {
  var bytes = String(hex || "").trim().split(/\s+/).filter(function (b) { return b !== "" }).map(function (b) { return parseInt(b, 16) })
  for (var base = 128; base + 128 <= bytes.length; base += 128) {
    var last = base + 127  // the checksum
    var found = null
    if (bytes[base] === 0x02 && bytes[base + 2] >= 4) {
      found = hdrLuminance(bytes, base + 4, Math.min(base + bytes[base + 2], last))
    } else if (bytes[base] === 0x70 && bytes[base + 2] <= 121) {
      // At most 121 bytes: 126 is the section's checksum, 127 the block's.
      var end = base + 5 + bytes[base + 2]
      for (var p = base + 5; p + 3 <= end;) {
        var size = bytes[p + 2]
        if (p + 3 + size > end) break
        if (bytes[p] === 0x81) found = hdrLuminance(bytes, p + 3, p + 3 + size)
        if (found) break
        p += 3 + size
      }
    }
    if (found) return found
  }
  return null
}

// Which kind drives a monitor, given every monitor connected.
function kindOf(monitor, monitors) {
  if (isInternal(monitor.name)) {
    var internals = monitors.filter(function (m) { return isInternal(m.name) })
    return internals.length === 1 ? "panel" : null  // one backlight, no way to pair more
  }
  if (isApple(monitor)) {
    var apples = monitors.filter(isApple)
    return apples.length === 1 ? "apple" : null
  }
  return "ddc"
}

// Sensors, from IIO devices { path, name } where `path` is the resolved
// sysfs path. The Studio Display's sits under Apple's USB vendor id; the
// laptop's under no USB device at all.
function sensorOrigin(sensor) {
  if (/\/0003:05AC:|05ac:/i.test(sensor.path)) return "apple"
  if (/\/usb\d+\//.test(sensor.path)) return "usb"
  return "chassis"
}

// The sensor that serves a display, and why, in priority order:
//   own      the display's own sensor
//   chassis  the laptop's, with its lid known to be open, whatever the panel
//            shows; a closed lid covers it, an unknown one may
//   other    any other, the one kept last time if still there, else the first
//   null     none: manual control only
function assignSensor(kind, sensors, lid, previous) {
  var own = kind === "apple" ? sensors.filter(function (s) { return sensorOrigin(s) === "apple" }) : []
  if (kind === "apple" && own.length === 1) return { sensor: own[0].path, reason: "own" }
  var chassis = sensors.filter(function (s) { return sensorOrigin(s) === "chassis" })
  if (lid === "open" && chassis.length) return { sensor: chassis[0].path, reason: "chassis" }
  var others = sensors.filter(function (s) {
    var origin = sensorOrigin(s)
    // An Apple display's sensor only stands in for another display when
    // there is exactly one, so it is known which room it reads.
    return origin === "usb" || (origin === "apple" && sensors.filter(function (t) { return sensorOrigin(t) === "apple" }).length === 1)
  }).map(function (s) { return s.path }).sort()
  if (!others.length) return { sensor: null, reason: null }
  return { sensor: others.indexOf(previous) !== -1 ? previous : others[0], reason: "other" }
}

// The displays to drive. `monitors` as `hyprctl monitors all -j` lists them,
// `edid` maps an output name to its luminance, `previous` maps a display id
// to the sensor it had. Each display:
//   { id, name, kind, active, luminance, sensor, sensorReason }
// `kind` is null for a display that cannot be driven, with `error` saying
// why. Ids are unique: displays sharing a serial are all told apart by their
// output name while both are connected. Once one is unplugged the other gets
// the plain id back, whichever owned it: a shared serial is a manufacturer's
// error, and keying every display by port would lose its settings to a
// change of port instead.
function displays(monitors, sensors, lid, edid, previous) {
  var connected = monitors.filter(function (m) { return m && m.name })
  var count = {}
  connected.forEach(function (m) { var k = identity(m); count[k] = (count[k] || 0) + 1 })
  return connected.map(function (m) {
    var id = identity(m)
    if (count[id] > 1) id = id + "@" + m.name
    var kind = kindOf(m, connected)
    var display = {
      id: id,
      name: m.name,
      kind: kind,
      // A closed lid covers the panel whether or not Hyprland disables it.
      active: m.disabled !== true && m.dpmsStatus !== false && !(kind === "panel" && lid === "closed"),
      luminance: (edid && edid[m.name]) || null,
      sensor: null,
      sensorReason: null,
      error: ""
    }
    if (!kind) {
      display.error = isInternal(m.name) ? "More than one internal output" : "More than one Apple display"
      return display
    }
    var assigned = assignSensor(kind, sensors, lid, previous && previous[id])
    display.sensor = assigned.sensor
    display.sensorReason = assigned.reason
    return display
  })
}

// The sensors some active display reads, to sample and nothing else.
function sensorsInUse(list) {
  var paths = []
  list.forEach(function (d) {
    if (d.active && d.kind && d.sensor && paths.indexOf(d.sensor) === -1) paths.push(d.sensor)
  })
  return paths
}

// The lid, from /proc/acpi/button/lid/*/state contents: open, closed, or
// unknown when there is no lid or it cannot be read.
function lidState(text) {
  var m = /state:\s*(open|closed)/.exec(String(text || ""))
  return m ? m[1] : "unknown"
}
