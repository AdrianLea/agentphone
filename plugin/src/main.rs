//! A one-row zellij bar that scrolls agent status across itself like an exchange ticker.
//!
//! The plugin holds no logic of its own: it runs `ap attention --ticker` and renders the feed.
//! That keeps a single definition of "needs attention" in the CLI, where it is testable, rather
//! than duplicating it in WASM.
//!
//! Data cadence and animation cadence are deliberately separate. The scroll offset advances on a
//! fast tick, but `ap` is only re-run every few seconds - animating by re-reading would spawn a
//! process several times a second for no benefit.

use std::collections::BTreeMap;
use zellij_tile::prelude::*;

/// Animation tick, and the only timer - data polling counts ticks rather than keeping a second one.
const TICK_SECS: f64 = 0.25;
/// Re-read `ap attention --ticker` every this many ticks (~6s).
const TICKS_PER_POLL: u64 = 24;
const SEPARATOR: &str = "   \u{2502}   ";

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Permission,
    Input,
    Queued,
}

impl Kind {
    fn parse(c: &str) -> Option<Self> {
        match c {
            "P" => Some(Kind::Permission),
            "I" => Some(Kind::Input),
            "Q" => Some(Kind::Queued),
            _ => None,
        }
    }

    /// Glyph and label. Permission is the state that actually blocks an agent, so it gets the
    /// up-arrow that reads as "needs acting on now".
    fn marks(self) -> (&'static str, &'static str) {
        match self {
            Kind::Permission => ("\u{25b2}", "PERM"),
            Kind::Input => ("\u{25c6}", "ASKS"),
            Kind::Queued => ("\u{25aa}", "MAIL"),
        }
    }
}

struct Segment {
    text: String,
    kind: Kind,
}

#[derive(Default)]
struct State {
    /// The zellij server's PATH often lacks ~/.local/bin, so the layout passes this explicitly.
    ap_path: String,
    segments: Vec<Segment>,
    offset: usize,
    ticks: u64,
    have_data: bool,
    permission_granted: bool,
    error: Option<String>,
}

register_plugin!(State);

impl State {
    fn poll(&self) {
        if self.permission_granted {
            run_command(&[&self.ap_path, "attention", "--ticker"], BTreeMap::new());
        }
    }

    /// Records look like `P|api|4m12s;I|worker|38s;Q|docs|2`.
    fn ingest(&mut self, feed: &str) {
        let mut segments = Vec::new();
        for record in feed.trim().split(';').filter(|r| !r.is_empty()) {
            let mut parts = record.split('|');
            let (Some(k), Some(handle), Some(detail)) = (parts.next(), parts.next(), parts.next())
            else {
                continue;
            };
            let Some(kind) = Kind::parse(k) else { continue };
            let (glyph, label) = kind.marks();
            segments.push(Segment {
                text: format!("{} {} {} {}", handle.to_uppercase(), glyph, label, detail),
                kind,
            });
        }
        self.segments = segments;
        self.have_data = true;
        self.error = None;
    }

    /// The scrolling strip, plus each segment's character span within one loop of it.
    fn strip(&self) -> (String, Vec<(usize, usize, Kind)>) {
        let mut strip = String::new();
        let mut spans = Vec::new();
        for (i, seg) in self.segments.iter().enumerate() {
            if i > 0 {
                strip.push_str(SEPARATOR);
            }
            let start = strip.chars().count();
            strip.push_str(&seg.text);
            spans.push((start, strip.chars().count(), seg.kind));
        }
        (strip, spans)
    }
}

impl ZellijPlugin for State {
    fn load(&mut self, configuration: BTreeMap<String, String>) {
        self.ap_path = configuration
            .get("ap_path")
            .cloned()
            .unwrap_or_else(|| "ap".to_string());

        // Reading the feed means running a command, which the user grants once.
        request_permission(&[PermissionType::RunCommands]);
        subscribe(&[
            EventType::Timer,
            EventType::RunCommandResult,
            EventType::PermissionRequestResult,
        ]);
        set_timeout(TICK_SECS);
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
                self.ticks = self.ticks.wrapping_add(1);
                self.offset = self.offset.wrapping_add(1);
                if self.ticks % TICKS_PER_POLL == 0 {
                    self.poll();
                }
                set_timeout(TICK_SECS);
                // Only repaint when something is actually scrolling.
                !self.segments.is_empty()
            }
            Event::RunCommandResult(exit_code, stdout, stderr, _context) => {
                if exit_code == Some(0) {
                    let feed = String::from_utf8_lossy(&stdout).to_string();
                    self.ingest(&feed);
                } else {
                    let msg = String::from_utf8_lossy(&stderr);
                    self.error = Some(
                        msg.lines()
                            .next()
                            .unwrap_or("ap failed")
                            .chars()
                            .take(48)
                            .collect(),
                    );
                }
                true
            }
            _ => false,
        }
    }

    /// A pipe is the fast path: whatever changed the feed tells us straight away.
    fn pipe(&mut self, _pipe_message: PipeMessage) -> bool {
        self.poll();
        false
    }

    fn render(&mut self, _rows: usize, cols: usize) {
        if cols == 0 {
            return;
        }

        if let Some(err) = &self.error {
            print_text(Text::new(format!("agentphone: {err}")).error_color_range(..));
            return;
        }
        if !self.have_data {
            print_text(Text::new("agentphone \u{2502} reading\u{2026}").dim_all());
            return;
        }
        if self.segments.is_empty() {
            print_text(Text::new("AGENTPHONE \u{25aa} ALL CLEAR").dim_all());
            return;
        }

        let (strip, spans) = self.strip();
        let strip_len = strip.chars().count();

        // Short enough to sit still. Motion should mean there is more to read than fits, not be
        // decoration - a bar that scrolls when it does not need to is just harder to read.
        if strip_len <= cols {
            let mut text = Text::new(&strip);
            for (start, end, kind) in spans {
                text = paint(text, kind, start..end);
            }
            print_text(text);
            return;
        }

        // Scroll by slicing a window out of two concatenated loops, so it wraps seamlessly.
        let loop_text = format!("{strip}{SEPARATOR}");
        let loop_len = loop_text.chars().count();
        let start = self.offset % loop_len;
        let doubled: Vec<char> = loop_text.chars().chain(loop_text.chars()).collect();
        let end = (start + cols).min(doubled.len());
        let window: String = doubled[start..end].iter().collect();

        let mut text = Text::new(&window);
        // A span can be visible in either loop copy, so check both placements against the window.
        for (seg_start, seg_end, kind) in spans {
            for copy in 0..2 {
                let abs_start = copy * loop_len + seg_start;
                let abs_end = copy * loop_len + seg_end;
                let visible_start = abs_start.max(start);
                let visible_end = abs_end.min(end);
                if visible_start < visible_end {
                    text = paint(text, kind, (visible_start - start)..(visible_end - start));
                }
            }
        }
        print_text(text);
    }
}

/// Semantic colour: red for a blocked agent, then two theme slots for the softer states.
fn paint(text: Text, kind: Kind, range: std::ops::Range<usize>) -> Text {
    match kind {
        Kind::Permission => text.error_color_range(range),
        Kind::Input => text.color_range(2, range),
        Kind::Queued => text.color_range(1, range),
    }
}
