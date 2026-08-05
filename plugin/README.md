# agentphone-bar

A one-row zellij status bar showing how many agents are waiting on you.

It holds no logic of its own: it runs `ap attention --count` and renders the number. "Needs
attention" stays defined once, in the CLI, where it is tested - rather than duplicated in WASM.

```
2 agents waiting on you  -  Alt+a
```

## Build

Needs Rust and the WASI target:

```sh
rustup target add wasm32-wasip1
cargo build --release --target wasm32-wasip1
# -> target/wasm32-wasip1/release/agentphone-bar.wasm
```

### Two build requirements that are easy to get wrong

Both of these fail with the same unhelpful message, `could not find exported function`, which is
wasmi failing to instantiate the module rather than anything about your plugin code:

- **It must be a `[[bin]]` crate, not a `cdylib`.** zellij loads the plugin as a WASI *command* and
  looks up the `_start` entry point, which only a bin target emits. `register_plugin!` supplies its
  own `fn main` (it installs a panic handler), so do not write one yourself or you get `E0428`.
- **Do not set `strip` in the release profile.** It removes the `#[no_mangle]` exports that
  `register_plugin!` generates.

A correct build exports `_start`, `__main_void`, `load`, `update`, `render`, `pipe`,
`plugin_version` and `memory`. Check with:

```sh
node -e 'const fs=require("fs");const m=new WebAssembly.Module(fs.readFileSync(process.argv[1]));
console.log(WebAssembly.Module.exports(m).map(e=>e.name).sort().join(", "))' \
  target/wasm32-wasip1/release/agentphone-bar.wasm
```

## Install

zellij loads plugins from a layout, so the bar appears in tabs created **after** the layout is in
place. An existing session keeps its current layout until you restart it or open a new tab.

Verify it first in an isolated tab, without touching your default layout:

```sh
# ~/.config/zellij/layouts/agentphone-test.kdl
layout {
    pane
    pane size=1 borderless=true {
        plugin location="file:/ABSOLUTE/PATH/TO/agentphone-bar.wasm" {
            ap_path "/ABSOLUTE/PATH/TO/ap"
        }
    }
}
```

```sh
zellij action new-tab --layout agentphone-test
```

On first load zellij asks you to grant the plugin **RunCommands** permission - the bar cannot read
the count until you allow it. Grant it in the pane, and the count should appear.

Once you are happy, promote it by creating `~/.config/zellij/layouts/default.kdl`. This overrides
zellij's built-in default for new tabs and sessions, so keep the tab-bar and status-bar panes:

```sh
layout {
    pane size=1 borderless=true { plugin location="zellij:tab-bar" }
    pane
    pane size=1 borderless=true {
        plugin location="file:/ABSOLUTE/PATH/TO/agentphone-bar.wasm" {
            ap_path "/ABSOLUTE/PATH/TO/ap"
        }
    }
    pane size=2 borderless=true { plugin location="zellij:status-bar" }
}
```

Deleting `default.kdl` restores zellij's built-in default.

### Why `ap_path` is configurable

The zellij server's `PATH` frequently does not include `~/.local/bin`, so a bare `ap` may not
resolve when the *server* runs the command. Passing an absolute path avoids a bar that silently
reads `ap failed`.

## Updating

Updates are event-driven. Anything that changes the count pipes to the plugin, which re-reads
immediately:

```sh
zellij pipe --name agentphone_refresh
```

A 30-second timer is only a safety net for changes that arrive without a pipe, so an idle machine
does almost no work.

## Limits

- **Only new tabs and sessions get the bar.** Layout changes do not apply retroactively.
- **WASM is sandboxed.** The plugin cannot read `~/.claude/agentphone` directly, which is why it
  shells out to `ap` rather than reading the store. That is also why it needs RunCommands.
- **`dump-screen` does not work on plugin panes**, so the bar cannot be verified by scripting - it
  has to be looked at.

## Troubleshooting

`Error in plugin, check logs for more info` in the pane means the module failed to load. The log
lives at `$TMPDIR/zellij-501/zellij-log/zellij.log` on macOS (not `/tmp`), and the useful line is
the `Caused by:` under `failed to load plugin from instance`.

`Failed to read permission cache file: No such file or directory` is **not** an error you need to
fix. It just means no grant is cached yet, so zellij is about to ask you for `RunCommands`.

## The ticker

The bar scrolls agent status across itself. Data comes from `ap attention --ticker`, a compact feed
of `KIND|handle|detail` records:

```
P|api|4m12s;I|worker|38s;Q|docs|2
```

which renders as `API ▲ PERM 4m12s   │   WORKER ◆ ASKS 38s   │   DOCS ▪ MAIL 2`, colour-coded per
item (red for a blocked agent, softer slots for the rest).

It sits still when everything fits, and only scrolls when there is more to read than the width
allows - motion should mean something, not be decoration. With nothing waiting it shows a dimmed
`AGENTPHONE ▪ ALL CLEAR`.

Animation ticks at 0.25s but `ap` is only re-run every ~6s. Animating by re-reading would spawn a
process several times a second for no benefit.
