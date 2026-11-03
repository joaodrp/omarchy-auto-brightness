// Unit tests for Inventory.js, run with `node test/inventory.test.js`.
// Inventory.js is a QML .js file (no exports), so it is evaluated into a
// shared scope the same way the QML engine does it.

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const inv = {}
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "Inventory.js"), "utf8"), inv)
const plain = (x) => JSON.parse(JSON.stringify(x))
const near = (actual, expected, tolerance, what) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual}, want ${expected}`)

const tests = []
function test(name, fn) { tests.push([name, fn]) }

// Outputs as `hyprctl monitors all -j` lists them; serials are made up.
const panel = (o = {}) => ({ name: "eDP-1", make: "Panel Co", model: "P13", serial: "", disabled: false, dpmsStatus: true, ...o })
const studio = (o = {}) => ({ name: "DP-1", make: "Apple Computer Inc", model: "StudioDisplay", serial: "0x0000A001", disabled: false, dpmsStatus: true, ...o })
const dell = (o = {}) => ({ name: "DP-3", make: "Dell Inc.", model: "U2723QE", serial: "AAA111", disabled: false, dpmsStatus: true, ...o })

// IIO sensors by resolved sysfs path: the laptop's on I2C, the Studio's on USB.
const chassisAls = { path: "/sys/devices/pci0000:00/i2c-1/i2c-FRMW0005:00/HID-SENSOR-200041.2.auto/iio:device0", name: "als" }
const studioAls = { path: "/sys/devices/pci0000:00/usb5/5-1/5-1.4:1.8/0003:05AC:1114.000D/HID-SENSOR-200041.11.auto/iio:device1", name: "als" }
const usbAls = { path: "/sys/devices/pci0000:00/usb3/3-2/3-2:1.0/0003:1234:5678.0001/HID-SENSOR-200041.1.auto/iio:device2", name: "als" }

const byName = (list) => Object.fromEntries(list.map((d) => [d.name, d]))
const pick = (d) => ({ kind: d.kind, active: d.active, sensor: d.sensor, sensorReason: d.sensorReason })

test("Studio and open laptop: each reads its own sensor", () => {
  const d = byName(inv.displays([panel(), studio()], [chassisAls, studioAls], "open", {}, {}))
  assert.deepEqual(pick(d["DP-1"]), { kind: "apple", active: true, sensor: studioAls.path, sensorReason: "own" })
  assert.deepEqual(pick(d["eDP-1"]), { kind: "panel", active: true, sensor: chassisAls.path, sensorReason: "chassis" })
})

test("clamshell: the panel is inactive and the covered sensor serves nobody", () => {
  const list = inv.displays([panel({ disabled: true }), dell()], [chassisAls, studioAls], "closed", {}, {})
  const d = byName(list)
  assert.equal(d["eDP-1"].active, false)
  assert.notEqual(d["DP-3"].sensor, chassisAls.path)
  assert.deepEqual(plain(inv.sensorsInUse(list)), [studioAls.path])
})

test("panel turned off with the lid open: its sensor still serves an external", () => {
  const d = byName(inv.displays([panel({ disabled: true }), dell()], [chassisAls], "open", {}, {}))
  assert.equal(d["eDP-1"].active, false)
  assert.deepEqual(pick(d["DP-3"]), { kind: "ddc", active: true, sensor: chassisAls.path, sensorReason: "chassis" })
})

test("DPMS off is inactive, and an unused sensor is not sampled", () => {
  const list = inv.displays([studio({ dpmsStatus: false })], [studioAls], "unknown", {}, {})
  assert.equal(list[0].active, false)
  assert.deepEqual(plain(inv.sensorsInUse(list)), [])
})

test("a closed lid makes the panel inactive even while Hyprland keeps it enabled", () => {
  const d = byName(inv.displays([panel(), studio()], [chassisAls, studioAls], "closed", {}, {}))
  assert.equal(d["eDP-1"].active, false)
  assert.equal(d["DP-1"].active, true)
})

test("an unknown lid never counts as open", () => {
  const d = byName(inv.displays([dell()], [chassisAls], "unknown", {}, {}))
  assert.equal(d["DP-3"].sensor, null)
})

test("a generic external borrows the Studio's sensor when nothing better is there", () => {
  const d = byName(inv.displays([studio(), dell()], [studioAls], "closed", {}, {}))
  assert.deepEqual(pick(d["DP-3"]), { kind: "ddc", active: true, sensor: studioAls.path, sensorReason: "other" })
})

test("a Studio whose USB sensor is gone falls back, then has none", () => {
  let d = byName(inv.displays([panel(), studio()], [chassisAls], "open", {}, {}))
  assert.equal(d["DP-1"].sensorReason, "chassis")
  d = byName(inv.displays([studio()], [], "closed", {}, {}))
  assert.deepEqual(pick(d["DP-1"]), { kind: "apple", active: true, sensor: null, sensorReason: null })
})

test("a fallback sensor stays put while it lasts", () => {
  const sensors = [usbAls, studioAls]
  const first = byName(inv.displays([dell()], sensors, "closed", {}, {}))["DP-3"]
  const other = first.sensor === usbAls.path ? studioAls.path : usbAls.path
  const kept = byName(inv.displays([dell()], sensors, "closed", {}, { [first.id]: other }))["DP-3"]
  assert.equal(kept.sensor, other)
})

test("two Studio Displays are refused rather than guessed", () => {
  const list = inv.displays([studio(), studio({ name: "DP-2", serial: "0x0000A002" })], [studioAls], "closed", {}, {})
  for (const d of list) {
    assert.equal(d.kind, null)
    assert.equal(d.error, "More than one Apple display")
  }
  assert.deepEqual(plain(inv.sensorsInUse(list)), [])
})

test("identity follows the display, not the port", () => {
  const a = inv.displays([dell({ name: "DP-3" })], [], "open", {}, {})[0]
  const b = inv.displays([dell({ name: "HDMI-A-1" })], [], "open", {}, {})[0]
  assert.equal(a.id, b.id)
  assert.equal(inv.displays([panel({ serial: "" })], [], "open", {}, {})[0].id, "internal")
})

test("two identical displays without serials get distinct ids", () => {
  const list = inv.displays([dell({ serial: "" }), dell({ name: "DP-4", serial: "" })], [], "open", {}, {})
  assert.notEqual(list[0].id, list[1].id)
})

test("a display without a serial keeps its id whatever else is connected", () => {
  const a = dell({ serial: "" }), b = dell({ name: "DP-4", serial: "" })
  const ids = (list) => Object.fromEntries(inv.displays(list, [], "open", {}, {}).map((d) => [d.name, d.id]))
  const both = ids([a, b])
  assert.deepEqual(ids([b, a]), both, "enumeration order")
  assert.equal(ids([b])["DP-4"], both["DP-4"], "the other unplugged")
})

test("ids cannot collide by joining fields", () => {
  const a = inv.identity({ name: "DP-1", make: "A B", model: "C", serial: "" })
  const b = inv.identity({ name: "DP-1", make: "A", model: "B C", serial: "" })
  assert.notEqual(a, b)
})

// EDIDs as `od -An -v -tx1` prints them: a base block of zeros, then
// extensions. An HDR Static Metadata data block with the given code values:
const hdrBlock = (maxCv, minCv) =>
  minCv === undefined ? [0xe4, 0x06, 0x05, 0x01, maxCv] : [0xe6, 0x06, 0x05, 0x01, maxCv, maxCv, minCv]
// A CTA-861 extension holding data blocks; `end` overrides where its data
// block collection ends.
function ctaExtension(blocks, end) {
  const ext = new Array(128).fill(0)
  const data = blocks.flat()
  ext[0] = 0x02; ext[1] = 0x03; ext[2] = end === undefined ? 4 + data.length : end
  data.forEach((b, i) => { ext[4 + i] = b })
  return ext
}
// A DisplayID extension whose CTA DisplayID data block (0x81) holds them.
function displayIdExtension(blocks) {
  const ext = new Array(128).fill(0)
  const data = blocks.flat()
  const section = [0x81, 0x00, data.length, ...data]
  ext[0] = 0x70; ext[1] = 0x20; ext[2] = section.length; ext[3] = 0x00; ext[4] = 0x00
  section.forEach((b, i) => { ext[5 + i] = b })
  return ext
}
const edid = (...extensions) =>
  [...new Array(128).fill(0), ...extensions.flat()].map((b) => b.toString(16).padStart(2, "0")).join(" ")
const edidHex = (maxCv, minCv) => edid(ctaExtension([hdrBlock(maxCv, minCv)]))

test("EDID luminance comes from the CTA HDR Static Metadata block", () => {
  const laptop = inv.edidLuminance(edidHex(122, 82))
  near(laptop.peak, 702.5, 0.1, "peak")
  near(laptop.floor, 0.726, 0.001, "floor")
  const noMin = inv.edidLuminance(edidHex(115))
  near(noMin.peak, 603.7, 0.1, "peak without a minimum")
  assert.equal(noMin.floor, 0)
})

test("an EDID without the block, or none at all, gives no luminance", () => {
  assert.equal(inv.edidLuminance(new Array(256).fill("00").join(" ")), null)
  assert.equal(inv.edidLuminance(""), null)
  assert.equal(inv.edidLuminance(undefined), null)
})

test("a maximum of code 0 is unspecified, and a later block can still say", () => {
  assert.equal(inv.edidLuminance(edidHex(0)), null)
  const later = inv.edidLuminance(edid(ctaExtension([hdrBlock(0)]), ctaExtension([hdrBlock(115)])))
  near(later.peak, 603.7, 0.1, "peak from the second CTA extension")
})

test("HDR metadata inside a DisplayID extension is found", () => {
  const lum = inv.edidLuminance(edid(displayIdExtension([hdrBlock(122, 82)])))
  near(lum.peak, 702.5, 0.1, "peak")
  near(lum.floor, 0.726, 0.001, "floor")
})

test("a DisplayID section longer than its extension allows is rejected", () => {
  const ext = displayIdExtension([hdrBlock(122, 82)])
  ext[2] = 122  // at most 121: bytes 126 and 127 are the two checksums
  assert.equal(inv.edidLuminance(edid(ext)), null)
})

test("a data block running past its collection is not read", () => {
  // The collection ends at offset 6, but the block at 4 claims 6 bytes.
  const ext = ctaExtension([hdrBlock(115, 10)], 6)
  assert.equal(inv.edidLuminance(edid(ext)), null)
})

test("the lid reads open, closed, or unknown", () => {
  assert.equal(inv.lidState("state:      open\n"), "open")
  assert.equal(inv.lidState("state:      closed\n"), "closed")
  assert.equal(inv.lidState(""), "unknown")
})

let failed = 0
for (const [name, fn] of tests) {
  try { fn(); console.log("ok   " + name) } catch (e) { failed++; console.log("FAIL " + name + "\n     " + e.message) }
}
if (failed) process.exit(1)
