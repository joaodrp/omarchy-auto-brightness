# Rollback

Everything this plugin touches on the machine, and how to undo it.

| Change | Where | Undo |
|--------|-------|------|
| Plugin symlink | `~/.config/omarchy/plugins/io.github.joaodrp.auto-brightness` -> this repo | `rm ~/.config/omarchy/plugins/io.github.joaodrp.auto-brightness` |
| Bar entry with `auto` and per-display `displays` keys | `~/.config/omarchy/shell.json` | `omarchy plugin disable io.github.joaodrp.auto-brightness` removes it |
| Display brightness values | Each driven display: Studio Display, laptop backlight, DDC/CI monitors | Set them with the slider or the hotkeys; the plugin keeps nothing else |

Full reset, in order:

```sh
omarchy plugin disable io.github.joaodrp.auto-brightness
rm ~/.config/omarchy/plugins/io.github.joaodrp.auto-brightness
omarchy-shell shell rescanPlugins
```

Belt and braces, on the machine this was developed on: a copy of
`shell.json` from before the first enable, made by hand, is at
`~/.config/omarchy/shell.json.pre-studio-display`. Restore with:

```sh
cp ~/.config/omarchy/shell.json.pre-studio-display ~/.config/omarchy/shell.json
omarchy-shell shell reloadConfig
```

Nothing under `/etc`, `/usr`, systemd, udev or sudoers is changed. The
Omarchy brightness helpers the plugin calls keep their own caches under
`$XDG_RUNTIME_DIR`, which go at logout.

## Comparison fork

`miharekar/omarchy-studio-display-auto-brightness` was forked to
`joaodrp/omarchy-studio-display-auto-brightness` with a `single-sensor`
branch and installed beside this plugin for comparison. It has since been
disabled and unlinked. What remains:

| Change | Where | Undo |
|--------|-------|------|
| Local clone | `~/Developer/github.com/joaodrp/omarchy-studio-display-auto-brightness` | `rm -rf` it |
| GitHub fork | github.com/joaodrp/omarchy-studio-display-auto-brightness | `gh repo delete joaodrp/omarchy-studio-display-auto-brightness` |

## Rename history

The plugin was `io.github.joaodrp.studio-display` in the repo
`omarchy-studio-display` until 2026-09-12. The pre-install backup keeps
its original name, `shell.json.pre-studio-display`.
