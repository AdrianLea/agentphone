//! A one-row zellij bar showing how many agents are waiting on you.
//!
//! The plugin holds no logic of its own: it shells out to `ap attention --count` and renders the
//! number. That keeps a single definition of "needs attention" in the CLI, where it is testable,
//! rather than duplicating it in WASM.
//!
//! Updates are event-driven. Anything that changes the count pipes to this plugin
//! (`zellij pipe --name agentphone_refresh`), which re-reads immediately. A slow timer is only a
//! safety net for changes that arrive without a pipe, so an idle machine does almost no work.

use std::collections::BTreeMap;
use zellij_tile::prelude::*;

/// Only a fallback: pipes carry the real updates.
const FALLBACK_POLL_SECS: f64 = 30.0;

#[derive(Default)]
struct State {
    /// Absolute path to `ap`. The zellij server's PATH often lacks ~/.local/bin, so the layout
    /// can pass `ap_path` explicitly.
    ap_path: String,
    waiting: usize,
    have_data: bool,
    permission_granted: bool,
    error: Option<String>,
}

register_plugin!(State);

impl State {
    fn poll(&self) {
        if !self.permission_granted {
            return;
        }
        run_command(&[&self.ap_path, "attention", "--count"], BTreeMap::new());
    }
}

impl ZellijPlugin for State {
    fn load(&mut self, configuration: BTreeMap<String, String>) {
        self.ap_path = configuration
            .get("ap_path")
            .cloned()
            .unwrap_or_else(|| "ap".to_string());

        // Reading the count means running a command, which the user must grant once.
        request_permission(&[PermissionType::RunCommands]);
        subscribe(&[
            EventType::Timer,
            EventType::RunCommandResult,
            EventType::PermissionRequestResult,
        ]);
        set_timeout(FALLBACK_POLL_SECS);
    }

    fn update(&mut self, event: Event) -> bool {
        match event {
            Event::PermissionRequestResult(status) => {
                self.permission_granted = matches!(status, PermissionStatus::Granted);
                if !self.permission_granted {
                    self.error = Some("permission denied".to_string());
                }
                self.poll();
                true
            }
            Event::Timer(_) => {
                self.poll();
                set_timeout(FALLBACK_POLL_SECS);
                false
            }
            Event::RunCommandResult(exit_code, stdout, stderr, _context) => {
                if exit_code == Some(0) {
                    let text = String::from_utf8_lossy(&stdout);
                    match text.trim().parse::<usize>() {
                        Ok(n) => {
                            let changed = !self.have_data || n != self.waiting;
                            self.waiting = n;
                            self.have_data = true;
                            self.error = None;
                            return changed;
                        }
                        Err(_) => self.error = Some("bad count".to_string()),
                    }
                } else {
                    let msg = String::from_utf8_lossy(&stderr);
                    self.error = Some(
                        msg.lines()
                            .next()
                            .unwrap_or("ap failed")
                            .chars()
                            .take(40)
                            .collect(),
                    );
                }
                true
            }
            _ => false,
        }
    }

    /// A pipe is the fast path: whatever changed the count tells us straight away.
    fn pipe(&mut self, _pipe_message: PipeMessage) -> bool {
        self.poll();
        false
    }

    fn render(&mut self, _rows: usize, cols: usize) {
        let body = match (&self.error, self.have_data, self.waiting) {
            (Some(e), _, _) => format!("agentphone: {e}"),
            (None, false, _) => "agentphone: ...".to_string(),
            (None, true, 0) => "agentphone: clear".to_string(),
            (None, true, 1) => "1 agent waiting on you  -  Alt+a".to_string(),
            (None, true, n) => format!("{n} agents waiting on you  -  Alt+a"),
        };

        // Colour carries the state so it reads at a glance without being parsed.
        let text = if self.error.is_some() {
            Text::new(&body).color_range(1, ..)
        } else if self.waiting > 0 {
            Text::new(&body).color_range(3, ..).selected()
        } else {
            Text::new(&body).color_range(0, ..)
        };

        // Truncation is zellij's job, but keep the bar from wrapping on a narrow pane.
        if body.chars().count() <= cols {
            print_text(text);
        } else {
            print_text(Text::new(&body.chars().take(cols).collect::<String>()));
        }
    }
}
