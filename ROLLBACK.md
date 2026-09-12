# Rollback

Everything this plugin touches on the machine, and how to undo it.

| Change | Where | Undo |
|--------|-------|------|
| Plugin symlink | `~/.config/omarchy/plugins/io.github.joaodrp.studio-display` -> this repo | `rm ~/.config/omarchy/plugins/io.github.joaodrp.studio-display` |
| Bar entry with `auto` / `offset` keys | `~/.config/omarchy/shell.json` | `omarchy plugin disable io.github.joaodrp.studio-display` removes it |
| Display brightness value | Studio Display hardware | Set it with the slider or the hotkeys; nothing persists |

Full reset, in order:

```sh
omarchy plugin disable io.github.joaodrp.studio-display
rm ~/.config/omarchy/plugins/io.github.joaodrp.studio-display
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

`miharekar/omarchy-studio-display-auto-brightness`, forked to
`joaodrp/omarchy-studio-display-auto-brightness` with a `single-sensor`
branch, is installed beside this plugin for comparison.

| Change | Where | Undo |
|--------|-------|------|
| Plugin symlink | `~/.config/omarchy/plugins/miharekar.studio-display-auto-brightness` -> `~/Developer/github.com/joaodrp/omarchy-studio-display-auto-brightness` | `omarchy plugin disable miharekar.studio-display-auto-brightness && rm` the symlink |
| Bar entry with `sensor` / `profile` / `paused` keys | `~/.config/omarchy/shell.json` | Removed by the disable above |
| GitHub fork | github.com/joaodrp/omarchy-studio-display-auto-brightness | `gh repo delete joaodrp/omarchy-studio-display-auto-brightness` |

Only one of the two controllers should be active at a time. Each treats the
other's writes as a manual change and pauses itself, so they do not fight,
but whichever wrote last wins.
