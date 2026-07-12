use std::io::Write;

fn main() {
    let mut stdout = std::fs::File::create("/dev/console").unwrap();
    writeln!(stdout, "RUST_INIT: Hello from Rust!").unwrap();
    writeln!(stdout, "RUST_INIT: stdout works").unwrap();

    // Test socket/bind/listen (the core of process_api)
    let listener = std::net::TcpListener::bind("0.0.0.0:2025").unwrap();
    writeln!(stdout, "RUST_INIT: bound port 2025").unwrap();

    drop(listener);
    writeln!(stdout, "RUST_INIT: sleeping 5s...").unwrap();
    std::thread::sleep(std::time::Duration::from_secs(5));
    writeln!(stdout, "RUST_INIT: done, exiting cleanly").unwrap();

    // PID 1 must NOT exit, but for this test we just see if we get here
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}
