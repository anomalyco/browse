//! A CLI whose stdout rejects writes (a full disk, a quota) reports it and exits 1 instead of panicking.

#[cfg(target_os = "linux")]
#[test]
fn a_full_stdout_is_an_error_not_a_panic() {
    for args in [&["version"][..], &["--help"][..]] {
        let full = std::fs::OpenOptions::new().write(true).open("/dev/full").unwrap();
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_browse")).args(args).stdout(full).output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(1), "browse {}: {stderr}", args.join(" "));
        assert!(stderr.starts_with("browse: can't write output: "), "browse {}: {stderr}", args.join(" "));
        assert!(!stderr.contains("panicked"), "browse {}: {stderr}", args.join(" "));
    }
}
