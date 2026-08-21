//! End-to-end probe for process_api PTY shell sessions.
//!
//! Connects to the WebSocket API and drives one bash session through the
//! interactions a real terminal user would produce, asserting observable
//! outcomes:
//!
//!   1. interactive prompt appears on connect
//!   2. plain command execution
//!   3. arrow-key history recall (readline)
//!   4. tab completion (readline)
//!   5. Ctrl-C delivers SIGINT to the foreground job, shell survives
//!   6. resize control frame reaches the pty (verified via `stty size`)
//!   7. ping control frame answered
//!   8. exit event with correct code, connection closes cleanly
//!
//! Usage: ws_probe [ws://host:port]   (default ws://127.0.0.1:12024)

use futures_util::{SinkExt, StreamExt};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// Stripper state for terminal control sequences, persisted across frames
/// because escapes can split mid-sequence between reads.
#[derive(Clone, Copy, PartialEq)]
enum Ansi {
    Ground,
    Esc,
    Csi,
    OscStr,
    OscEsc,
}

struct Probe {
    tx: futures_util::stream::SplitSink<Ws, Message>,
    rx: futures_util::stream::SplitStream<Ws>,
    acc: String,
    ansi: Ansi,
    exit_code: Option<i64>,
    closed: bool,
}

impl Probe {
    async fn send_text(&mut self, s: &str) {
        if self.tx.send(Message::Text(s.to_owned().into())).await.is_err() {
            self.closed = true;
        }
    }

    async fn send_line(&mut self, s: &str) {
        self.send_text(&format!("{s}\n")).await;
    }

    /// Pump incoming frames until `needle` shows up in the accumulated output
    /// or `secs` elapse. Returns whether the needle was seen.
    async fn expect(&mut self, name: &str, needle: &str, secs: u64) -> bool {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while !self.acc.contains(needle) {
            if Instant::now() >= deadline || self.closed {
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, self.rx.next()).await {
                Err(_) => break, // deadline hit
                Ok(None) => {
                    self.closed = true;
                    break;
                }
                Ok(Some(Err(_))) => {
                    self.closed = true;
                    break;
                }
                Ok(Some(Ok(frame))) => self.absorb(frame),
            }
        }
        let ok = self.acc.contains(needle);
        report(name, ok);
        if !ok {
            eprintln!("    accumulated tail: {:?}", tail(&self.acc));
        }
        ok
    }

    /// Pump frames until `needle` has appeared `n` times or `secs` elapse.
    async fn expect_count(&mut self, name: &str, needle: &str, n: usize, secs: u64) -> bool {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while self.acc.matches(needle).count() < n {
            if Instant::now() >= deadline || self.closed {
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, self.rx.next()).await {
                Err(_) => break,
                Ok(None) => {
                    self.closed = true;
                    break;
                }
                Ok(Some(Err(_))) => {
                    self.closed = true;
                    break;
                }
                Ok(Some(Ok(frame))) => self.absorb(frame),
            }
        }
        let ok = self.acc.matches(needle).count() >= n;
        report(name, ok);
        if !ok {
            eprintln!("    accumulated tail: {:?}", tail(&self.acc));
        }
        ok
    }

    /// Pump frames until some output **line** equals `line` exactly
    /// (\r-stripped) or `secs` elapse — immune to CR/LF style differences.
    async fn expect_line(&mut self, name: &str, line: &str, secs: u64) -> bool {
        let has = |acc: &str| {
            acc.split('\n').any(|l| l.trim_matches('\r') == line)
        };
        let deadline = Instant::now() + Duration::from_secs(secs);
        while !has(&self.acc) {
            if Instant::now() >= deadline || self.closed {
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, self.rx.next()).await {
                Err(_) => break,
                Ok(None) => {
                    self.closed = true;
                    break;
                }
                Ok(Some(Err(_))) => {
                    self.closed = true;
                    break;
                }
                Ok(Some(Ok(frame))) => self.absorb(frame),
            }
        }
        let ok = has(&self.acc);
        report(name, ok);
        if !ok {
            eprintln!("    accumulated tail: {:?}", tail(&self.acc));
        }
        ok
    }

    fn absorb(&mut self, frame: Message) {
        match frame {
            Message::Text(t) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                    if let Some(text) = v.get("text").and_then(|x| x.as_str()) {
                        self.absorb_text(text);
                    }
                    if let Some(ev) = v.get("event").and_then(|x| x.as_str()) {
                        match ev {
                            "exit" => {
                                self.exit_code = v.get("code").and_then(|c| c.as_i64());
                                self.acc.push_str("\u{4}EXIT-FRAME\u{4}");
                            }
                            other => self.acc.push_str(&format!("\u{4}EVENT:{other}\u{4}")),
                        }
                    }
                } else {
                    self.absorb_text(&t);
                }
            }
            Message::Binary(b) => self.absorb_text(&String::from_utf8_lossy(&b)),
            Message::Close(_) => self.closed = true,
            _ => {}
        }
    }

    /// Append output to the accumulator with ANSI CSI/OSC sequences removed:
    /// bash emits title strings (`ESC]0;…BEL`) and bracketed-paste markers
    /// (`ESC[?2004h`) that would otherwise interleave with matched text.
    fn absorb_text(&mut self, text: &str) {
        let mut out = String::new();
        for ch in text.chars() {
            self.ansi = match self.ansi {
                Ansi::Ground => {
                    if ch == '\x1b' { Ansi::Esc } else { out.push(ch); Ansi::Ground }
                }
                Ansi::Esc => match ch {
                    '[' => Ansi::Csi,
                    ']' => Ansi::OscStr,
                    '\x1b' => Ansi::Esc,
                    _ => Ansi::Ground,
                },
                Ansi::Csi => {
                    if ('@'..='~').contains(&ch) { Ansi::Ground } else { Ansi::Csi }
                }
                Ansi::OscStr => {
                    if ch == '\x07' { Ansi::Ground } else if ch == '\x1b' { Ansi::OscEsc } else { Ansi::OscStr }
                }
                Ansi::OscEsc => Ansi::Ground,
            };
        }
        self.acc.push_str(&out);
    }

    /// Pump frames for a fixed short duration without asserting anything.
    async fn settle(&mut self, ms: u64) {
        let deadline = Instant::now() + Duration::from_millis(ms);
        while !self.closed {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match tokio::time::timeout(remaining, self.rx.next()).await {
                Err(_) | Ok(None) => break,
                Ok(Some(Ok(frame))) => self.absorb(frame),
                Ok(Some(Err(_))) => {
                    self.closed = true;
                    break;
                }
            }
        }
    }

    fn clear(&mut self) {
        self.acc.clear();
    }
}

fn tail(s: &str) -> String {
    let n = s.chars().count();
    s.chars().skip(n.saturating_sub(400)).collect()
}

fn report(name: &str, ok: bool) {
    println!("  [{}] {}", if ok { "PASS" } else { "FAIL" }, name);
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let url = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "ws://127.0.0.1:12024".to_string());

    println!("==> Connecting to {url} ...");
    let (ws, _) = match connect_async(&url).await {
        Ok(x) => x,
        Err(e) => {
            eprintln!("FATAL: cannot connect: {e}");
            std::process::exit(2);
        }
    };
    let (tx, rx) = ws.split();
    let mut p = Probe {
        tx,
        rx,
        acc: String::new(),
        ansi: Ansi::Ground,
        exit_code: None,
        closed: false,
    };
    let mut failures = 0usize;

    // 1. Prompt -----------------------------------------------------------
    if !p.expect("interactive prompt appears", "@fusebox:", 10).await {
        failures += 1;
    }

    // 2. Plain execution --------------------------------------------------
    p.clear();
    p.send_line("echo fusebox_pty_ok").await;
    if !p.expect("command executes", "fusebox_pty_ok", 5).await {
        failures += 1;
    }

    // 3. Arrow-key history recall ----------------------------------------
    // Run a distinctive command, then press Up + Enter: the recalled line
    // must execute again, producing a SECOND occurrence of the marker.
    p.clear();
    p.send_line("echo HISTORY_MARK_42").await;
    if !p.expect("history target ran once", "HISTORY_MARK_42", 5).await {
        failures += 1;
    }
    p.send_text("\x1b[A\r").await;
    if !p.expect_count("arrow-key recall re-runs command", "HISTORY_MARK_42", 2, 5).await {
        failures += 1;
    }

    // 4. Tab completion ---------------------------------------------------
    // TAB on a unique prefix makes readline insert the full word (plus a
    // trailing space); Enter then runs it and a fresh prompt is printed.
    // Assert on the inserted word itself and on a prompt occurring AFTER it,
    // never on the username (it also appears inside the prompt string).
    p.clear();
    p.send_text("whoam\t").await; // unique completion -> "whoami" + space
    p.send_line("").await;       // accept the completed line
    let inserted = p.expect("tab completion inserts word", "whoami", 5).await;
    p.settle(400).await;
    let after_word = p.acc.split("whoami").nth(1).unwrap_or("");
    let executed = after_word.contains("@fusebox:");
    report("completed command executed", inserted && executed);
    if !inserted || !executed {
        failures += 1;
        eprintln!("    tab-region dump: {:?}", &p.acc);
    }

    // 5. Ctrl-C kills foreground job, shell survives -----------------------
    p.clear();
    p.send_line("sleep 60").await;
    // Generous settle: \x03 must arrive only AFTER bash has forked sleep and
    // tcsetpgrp-ed it to the foreground, else the SIGINT lands on bash's own
    // group (pending-flag path) and the shell appears wedged for job-length.
    p.settle(1500).await;
    p.send_text("\x03").await; // ETX -> SIGINT to foreground group
    if !p.expect("Ctrl-C echoes ^C", "^C", 5).await {
        failures += 1;
    }
    if !p.expect("Ctrl-C returns prompt", "@fusebox:", 5).await {
        failures += 1;
    }
    p.send_line("ps | grep -c '[s]leep'").await;
    if !p.expect_line("foreground sleep reaped after SIGINT", "0", 5).await {
        failures += 1;
    }

    // 6. Window resize -----------------------------------------------------
    p.clear();
    p.send_text(r#"{"type":"resize","cols":101,"rows":31}"#).await;
    p.send_line("stty size").await;
    if !p.expect("resize applied (stty size)", "31 101", 5).await {
        failures += 1;
    }

    // 7. Ping control frame -------------------------------------------------
    p.clear();
    p.send_text(r#"{"type":"ping"}"#).await;
    if !p.expect("ping answered", "\u{4}EVENT:pong\u{4}", 5).await {
        failures += 1;
    }

    // 8. Exit event ----------------------------------------------------------
    p.clear();
    p.send_line("exit").await;
    if !p.expect("exit event emitted", "EXIT-FRAME", 5).await {
        failures += 1;
    }
    match p.exit_code {
        Some(0) => println!("  [PASS] exit code reported as 0"),
        other => {
            println!("  [FAIL] exit code {:?}, expected 0", other);
            failures += 1;
        }
    }

    println!("");
    if failures == 0 {
        println!("==> ALL PROBES PASSED");
    } else {
        println!("==> {failures} PROBE(S) FAILED");
        std::process::exit(1);
    }
}
