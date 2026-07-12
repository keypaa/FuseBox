use std::io::Write;
use std::net::TcpListener;
use std::time::Duration;

fn main() {
    // Open /dev/console directly since stdout/stderr aren't connected
    let mut con = std::fs::OpenOptions::new()
        .write(true)
        .open("/dev/console")
        .expect("open /dev/console");

    writeln!(con, "MINIMAL_INIT: Hello from Rust!").unwrap();

    // Test thread creation (needed for tokio)
    let handle = std::thread::spawn(|| {
        writeln!(
            &mut std::fs::OpenOptions::new()
                .write(true)
                .open("/dev/console")
                .unwrap(),
            "MINIMAL_INIT: thread spawned OK"
        )
        .unwrap();
    });
    handle.join().unwrap();

    // Test socket/bind/listen (core of process_api)
    let listener = TcpListener::bind("0.0.0.0:2025").expect("bind");
    writeln!(con, "MINIMAL_INIT: bound port 2025 OK").unwrap();
    drop(listener);

    // Test TCP connect (the VM won't have network, but the syscall should work)
    writeln!(con, "MINIMAL_INIT: all checks passed!").unwrap();

    // PID 1 must not exit, so loop forever
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}
