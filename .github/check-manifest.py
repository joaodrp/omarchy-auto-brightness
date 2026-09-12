#!/usr/bin/env python3
"""Check manifest.json against the repository, the README and Panel.qml.

The marketplace reads the manifest, the README documents it, and the panel
reads the settings by key. None of them notices when the others drift, so
this does.
"""

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
REQUIRED = ("schemaVersion", "id", "name", "version", "author", "description",
            "kinds", "entryPoints")

errors = []


def fail(msg):
    errors.append(msg)


manifest = json.loads((ROOT / "manifest.json").read_text())

for key in REQUIRED:
    if key not in manifest:
        fail(f"manifest.json is missing the required field {key!r}")

for kind, entry in manifest.get("entryPoints", {}).items():
    if not (ROOT / entry).is_file():
        fail(f"entryPoints.{kind} names {entry!r}, which does not exist")

widget = manifest.get("barWidget", {})
schema = {item["key"]: item for item in widget.get("schema", [])}
defaults = widget.get("defaults", {})

for key, item in schema.items():
    if key not in defaults:
        fail(f"setting {key!r} is in the schema with no entry in defaults")
    elif "defaultValue" in item and defaults[key] != item["defaultValue"]:
        fail(f"setting {key!r} defaults to {defaults[key]!r} but its schema says "
             f"{item['defaultValue']!r}")

for key in defaults:
    if key not in schema:
        fail(f"setting {key!r} has a default but is not in the schema")

# The README's settings table is the user-facing copy of the same list. A key
# added to one and not the other is the drift this is here to catch.
readme = (ROOT / "README.md").read_text()
section = re.search(r"^## Settings$(.*?)^## ", readme, re.MULTILINE | re.DOTALL)
if section is None:
    fail("the README has no Settings section to compare against")
    section_text = ""
else:
    section_text = section.group(1)
documented = set(re.findall(r"^\| `([a-zA-Z]+)` \|", section_text, re.MULTILINE))
for key in schema:
    if key not in documented:
        fail(f"setting {key!r} is in manifest.json but not in the README table")
for key in documented - set(schema):
    fail(f"the README documents a setting {key!r} that manifest.json does not have")

# The panel reads each setting by string key, and its fallback is the
# manifest default typed again. A key that is read but not declared, or
# declared with one default and read with another, is a silent divergence.
panel = (ROOT / manifest["entryPoints"]["barWidget"]).read_text()
for key, default in re.findall(r'root\.setting\("([a-zA-Z]+)",\s*([^)]+)\)', panel):
    if key not in schema:
        fail(f"Panel.qml reads setting {key!r}, which manifest.json does not declare")
        continue
    if json.loads(default) != defaults[key]:
        fail(f"Panel.qml falls back to {default} for {key!r}; manifest.json says "
             f"{defaults[key]!r}")

if errors:
    for line in errors:
        print(f"manifest: {line}", file=sys.stderr)
    sys.exit(1)

print(f"manifest ok: {manifest['id']} {manifest['version']}, "
      f"{len(schema)} settings, all documented")
