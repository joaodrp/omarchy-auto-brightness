# Rollback

Everything this plugin touches on the machine, and how to undo it.

| Change | Where | Undo |
|--------|-------|------|
| Plugin symlink | `~/.config/omarchy/plugins/io.github.joaodrp.auto-brightness` -> this repo | `rm ~/.config/omarchy/plugins/io.github.joaodrp.auto-brightness` |
| Bar entry with `auto` / `offset` keys | `~/.config/omarchy/shell.json` | `omarchy plugin disable io.github.joaodrp.auto-brightness` removes it |
| Display brightness value | Studio Display hardware | Set it with the slider or the hotkeys; nothing persists |

Full reset, in order:

```sh
omarchy plugin disable io.github.joaodrp.auto-brightness
rm ~/.config/omarchy/plugins/io.github.joaodrp.auto-brightness
omarchy-shell shell rescanPlugins
```

Belt and braces: a copy of `shell.json` from before the first enable is at
`~/.config/omarchy/shell.json.pre-studio-display`. Restore with:

```sh
cp ~/.config/omarchy/shell.json.pre-studio-display ~/.config/omarchy/shell.json
omarchy-shell shell reloadConfig
```

Nothing under `/etc`, `/usr`, systemd, udev or sudoers is changed.

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
