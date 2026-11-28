//! Firefox discovery against temporary folders: no real Firefox or profile is read.

use std::path::{Path, PathBuf};

use super::*;

pub(crate) struct Scratch(pub(crate) PathBuf);

impl Scratch {
    pub(crate) fn new(name: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!("browse-firefox-{name}-{}", crate::util::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(std::fs::canonicalize(&dir).unwrap())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn mkdir(path: &Path) -> PathBuf {
    std::fs::create_dir_all(path).unwrap();
    path.to_path_buf()
}

fn touch(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, b"").unwrap();
}

/// A fresh Firefox 160 root: profiles.ini's Default=1 is the empty legacy profile; the install opens default-release.
fn fresh_root(root: &Path, outside: &Path) {
    mkdir(&root.join("Profiles/abcd.default"));
    mkdir(&root.join("Profiles/wxyz.default-release"));
    mkdir(outside);
    std::fs::write(
        root.join("profiles.ini"),
        format!(
            "\u{feff}[Profile1]\r\nName=default\r\nIsRelative=1\r\nPath=Profiles/abcd.default\r\nDefault=1\r\n\r\n[Profile0]\r\nName=default-release\r\nIsRelative=1\r\nPath=Profiles/wxyz.default-release\r\n\r\n[Profile2]\r\nName=work\r\nIsRelative=0\r\nPath={}\r\n\r\n[General]\r\nStartWithLastProfile=1\r\nVersion=2\r\n",
            outside.display()
        ),
    )
    .unwrap();
    std::fs::write(root.join("installs.ini"), "[2656FF1E876E9973]\nDefault=Profiles/wxyz.default-release\nLocked=1\n").unwrap();
}

#[test]
fn profiles_ini_lists_relative_and_absolute_profiles_and_install_defaults() {
    let s = Scratch::new("ini");
    let root = s.0.join("Firefox");
    let outside = s.0.join("elsewhere/work");
    fresh_root(&root, &outside);
    mkdir(&root.join("Profiles/zzzz.unlisted"));
    let found = profiles(&root).unwrap();
    let dirs: Vec<&Path> = found.list.iter().map(|p| p.dir.as_path()).collect();
    assert_eq!(dirs, [root.join("Profiles/abcd.default").as_path(), &root.join("Profiles/wxyz.default-release"), &outside, &root.join("Profiles/zzzz.unlisted")]);
    assert_eq!(found.names(), ["default", "default-release", "work", "zzzz.unlisted"]);
    assert_eq!(found.install_defaults, [root.join("Profiles/wxyz.default-release")]);
}

#[test]
fn the_install_default_beats_the_legacy_default_flag() {
    let s = Scratch::new("select");
    let root = s.0.join("Firefox");
    fresh_root(&root, &s.0.join("work"));
    let chosen = select_profile(AppKind::Firefox, None, &[], profiles(&root), &s.0, |_| ProfileState::NotRunning).unwrap();
    assert_eq!(chosen.dir, root.join("Profiles/wxyz.default-release"));
    assert_eq!(chosen.how, Chosen::InstallDefault);
    assert_eq!(chosen.name, "default-release");
}

#[test]
fn several_install_defaults_pick_the_one_of_this_app() {
    let s = Scratch::new("installs");
    let root = s.0.join("Firefox");
    mkdir(&root.join("Profiles/a.default-release"));
    mkdir(&root.join("Profiles/b.default-nightly"));
    std::fs::write(root.join("installs.ini"), "[One]\nDefault=Profiles/a.default-release\n[Two]\nDefault=Profiles/b.default-nightly\n").unwrap();
    let nightly = select_profile(AppKind::Nightly, None, &[], profiles(&root), &s.0, |_| ProfileState::NotRunning).unwrap();
    assert_eq!(nightly.dir, root.join("Profiles/b.default-nightly"));
    let release = select_profile(AppKind::Firefox, None, &[], profiles(&root), &s.0, |_| ProfileState::NotRunning).unwrap();
    assert_eq!(release.dir, root.join("Profiles/a.default-release"));
}

#[test]
fn selection_follows_its_order() {
    let s = Scratch::new("order");
    let root = s.0.join("Firefox");
    let work = s.0.join("work");
    fresh_root(&root, &work);
    let release = root.join("Profiles/wxyz.default-release");
    let legacy = root.join("Profiles/abcd.default");
    let all = || profiles(&root);

    let explicit = select_profile(AppKind::Firefox, Some("work"), &[], all(), &s.0, |_| ProfileState::NotRunning).unwrap();
    assert_eq!((explicit.dir.clone(), explicit.how), (work.clone(), Chosen::Explicit));
    let by_suffix = select_profile(AppKind::Firefox, Some("DEFAULT"), &[], all(), &s.0, |_| ProfileState::NotRunning).unwrap();
    assert_eq!(by_suffix.dir, legacy);
    let by_path = select_profile(AppKind::Firefox, Some("~/custom/p"), &[], all(), &s.0, |_| ProfileState::NotRunning).unwrap();
    assert_eq!(by_path.dir, s.0.join("custom/p"));
    match select_profile(AppKind::Firefox, Some("nope"), &[], all(), &s.0, |_| ProfileState::NotRunning) {
        Err(SelectError::NotFound { wanted, names }) => {
            assert_eq!(wanted, "nope");
            assert!(names.contains(&"work".to_string()));
        }
        other => panic!("{other:?}"),
    }

    let record = RecordedFirefox { app: "firefox".into(), exe: "/x".into(), profile: work.clone(), endpoint: None, dedicated: false, headless: false, name: None, prefs_added: true };
    let zen = RecordedFirefox { app: "zen".into(), profile: legacy.clone(), ..record.clone() };
    let recorded = select_profile(AppKind::Firefox, None, &[zen.clone(), record.clone()], all(), &s.0, |_| ProfileState::NotRunning).unwrap();
    assert_eq!((recorded.dir.clone(), recorded.how), (work.clone(), Chosen::Recorded));
    assert_eq!(recorded.recorded, Some(record.clone()));

    let listening = |dir: &Path| if dir == legacy { ProfileState::Listening { url: "ws://127.0.0.1:1/session".into(), pid: None } } else { ProfileState::NotRunning };
    let chosen = select_profile(AppKind::Firefox, None, std::slice::from_ref(&zen), all(), &s.0, listening).unwrap();
    assert_eq!((chosen.dir, chosen.how), (legacy.clone(), Chosen::Listening));

    let running = |dir: &Path| if dir == work { ProfileState::RunningNoBidi { pid: Some(7) } } else { ProfileState::NotRunning };
    let chosen = select_profile(AppKind::Firefox, None, &[], all(), &s.0, running).unwrap();
    assert_eq!((chosen.dir, chosen.how), (work.clone(), Chosen::Running));

    let two = |dir: &Path| if dir == work || dir == legacy { ProfileState::RunningNoBidi { pid: None } } else { ProfileState::NotRunning };
    let chosen = select_profile(AppKind::Firefox, None, &[], all(), &s.0, two).unwrap();
    assert_eq!((chosen.dir, chosen.how), (release.clone(), Chosen::InstallDefault), "two running: neither is picked");

    std::fs::remove_file(root.join("installs.ini")).unwrap();
    match select_profile(AppKind::Firefox, None, &[], all(), &s.0, |_| ProfileState::NotRunning) {
        Err(SelectError::Ambiguous(names)) => assert_eq!(names.len(), 3),
        other => panic!("{other:?}"),
    }

    let lone = s.0.join("Lone");
    mkdir(&lone.join("Profiles/only.default-release"));
    let chosen = select_profile(AppKind::Firefox, None, &[], profiles(&lone), &s.0, |_| ProfileState::NotRunning).unwrap();
    assert_eq!(chosen.how, Chosen::Only);
    assert_eq!(select_profile(AppKind::Firefox, None, &[], profiles(&s.0.join("missing")), &s.0, |_| ProfileState::NotRunning), Err(SelectError::None));
    let denied = Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Operation not permitted"));
    assert!(matches!(select_profile(AppKind::Firefox, None, &[], denied, &s.0, |_| ProfileState::NotRunning), Err(SelectError::PermissionDenied(_))));
}

#[cfg(unix)]
#[test]
fn an_unreadable_root_is_permission_denied() {
    use std::os::unix::fs::PermissionsExt;
    let s = Scratch::new("denied");
    let root = mkdir(&s.0.join("Firefox"));
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o000)).unwrap();
    let result = profiles(&root);
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    if let Err(error) = result {
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    }
    assert_eq!(profiles(&s.0.join("nope")).unwrap_err().kind(), std::io::ErrorKind::NotFound);
}

#[test]
fn the_bidi_server_file_needs_ws_host_and_ws_port_on_loopback() {
    assert_eq!(parse_bidi_server(r#"{"ws_host": "127.0.0.1", "ws_port": 59834}"#).as_deref(), Some("ws://127.0.0.1:59834/session"));
    assert_eq!(parse_bidi_server(r#"{"ws_host":"::1","ws_port":9222}"#).as_deref(), Some("ws://[::1]:9222/session"));
    assert_eq!(parse_bidi_server(r#"{"ws_host":"[::1]","ws_port":9222}"#).as_deref(), Some("ws://[::1]:9222/session"));
    assert_eq!(parse_bidi_server(r#"{"host":"127.0.0.1","port":9222}"#), None, "the keys are ws_host and ws_port");
    assert_eq!(parse_bidi_server(r#"{"ws_host":"192.168.1.5","ws_port":9222}"#), None);
    assert_eq!(parse_bidi_server(r#"{"ws_host":"example.com","ws_port":9222}"#), None);
    assert_eq!(parse_bidi_server(r#"{"ws_host":"127.0.0.1","ws_port":0}"#), None);
    assert_eq!(parse_bidi_server(r#"{"ws_host":"127.0.0.1","ws_port":70000}"#), None);
    assert_eq!(parse_bidi_server("not json"), None);
}

/// Run as a child process by the lock tests: holds .parentlock in BROWSE_TEST_HOLD_LOCK until a "release" file appears.
#[cfg(unix)]
#[test]
fn hold_lock_helper() {
    use std::os::fd::AsRawFd;
    let Some(profile) = std::env::var_os("BROWSE_TEST_HOLD_LOCK").map(PathBuf::from) else { return };
    let file = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(profile.join(".parentlock")).unwrap();
    // SAFETY: plain data, a valid descriptor.
    let mut lock: libc::flock = unsafe { std::mem::zeroed() };
    lock.l_type = libc::F_WRLCK as _;
    lock.l_whence = libc::SEEK_SET as _;
    assert_eq!(unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &lock) }, 0);
    std::fs::write(profile.join("locked"), std::process::id().to_string()).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while !profile.join("release").exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[cfg(unix)]
pub(crate) struct Holder {
    pub(crate) child: std::process::Child,
    profile: PathBuf,
}

#[cfg(unix)]
impl Holder {
    pub(crate) fn start(profile: &Path) -> Holder {
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "firefox::tests::hold_lock_helper", "--nocapture", "--test-threads", "1"])
            .env("BROWSE_TEST_HOLD_LOCK", profile)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !profile.join("locked").exists() {
            assert!(std::time::Instant::now() < deadline, "the lock holder didn't start");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        Holder { child, profile: profile.to_path_buf() }
    }

    pub(crate) fn release(mut self) {
        touch(&self.profile.join("release"));
        let _ = self.child.wait();
    }
}

#[cfg(unix)]
impl Drop for Holder {
    fn drop(&mut self) {
        touch(&self.profile.join("release"));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(unix)]
#[test]
fn state_reads_the_lock_first_then_the_bidi_server_file() {
    let s = Scratch::new("state");
    let profile = mkdir(&s.0.join("p"));
    assert_eq!(state(&profile), ProfileState::NotRunning, "no lock file");
    assert_eq!(state(&s.0.join("missing")), ProfileState::NotRunning);
    touch(&profile.join(".parentlock"));
    std::fs::write(profile.join("WebDriverBiDiServer.json"), r#"{"ws_host":"127.0.0.1","ws_port":4444}"#).unwrap();
    assert_eq!(state(&profile), ProfileState::NotRunning, "a stale server file with a free lock");

    std::fs::remove_file(profile.join("WebDriverBiDiServer.json")).unwrap();
    let holder = Holder::start(&profile);
    let pid = holder.child.id();
    assert_eq!(state(&profile), ProfileState::RunningNoBidi { pid: Some(pid) });
    std::fs::write(profile.join("WebDriverBiDiServer.json"), r#"{"ws_host":"127.0.0.1","ws_port":4444}"#).unwrap();
    assert_eq!(state(&profile), ProfileState::Listening { url: "ws://127.0.0.1:4444/session".into(), pid: Some(pid) });
    assert!(ensure_real_profile_prefs(&profile).is_err(), "prefs.js isn't written while the browser runs");
    holder.release();
    assert_eq!(state(&profile), ProfileState::NotRunning, "the lock went with its holder; the file stayed");
    assert!(profile.join(".parentlock").exists());
}

#[cfg(unix)]
#[test]
fn an_unreadable_profile_is_unreadable() {
    use std::os::unix::fs::PermissionsExt;
    let s = Scratch::new("unreadable");
    let profile = mkdir(&s.0.join("p"));
    touch(&profile.join(".parentlock"));
    std::fs::set_permissions(profile.join(".parentlock"), std::fs::Permissions::from_mode(0o000)).unwrap();
    let readable_anyway = std::fs::File::open(profile.join(".parentlock")).is_ok();
    let result = state(&profile);
    std::fs::set_permissions(profile.join(".parentlock"), std::fs::Permissions::from_mode(0o600)).unwrap();
    if !readable_anyway {
        assert!(matches!(result, ProfileState::Unreadable(_)), "{result:?}");
    }
}

#[test]
fn prefs_are_added_once_and_removed_cleanly() {
    let s = Scratch::new("prefs");
    let profile = mkdir(&s.0.join("p"));
    let original = "// Mozilla User Preferences\nuser_pref(\"browser.startup.page\", 1);\nuser_pref(\"a.b\", \"c\");";
    std::fs::write(profile.join("prefs.js"), original).unwrap();
    assert!(ensure_real_profile_prefs(&profile).unwrap());
    assert!(!ensure_real_profile_prefs(&profile).unwrap(), "idempotent");
    let text = std::fs::read_to_string(profile.join("prefs.js")).unwrap();
    assert!(text.starts_with(original));
    assert_eq!(text.matches("remote.prefs.recommended").count(), 1);
    assert!(text.contains(PREFS_MARKER));
    assert!(ensure_resume_once(&profile).unwrap());
    assert!(!ensure_resume_once(&profile).unwrap(), "idempotent");
    assert_eq!(std::fs::read_to_string(profile.join("prefs.js")).unwrap().matches("resume_session_once").count(), 1);

    assert!(remove_browse_prefs(&profile).unwrap());
    assert!(!remove_browse_prefs(&profile).unwrap());
    let after = std::fs::read_to_string(profile.join("prefs.js")).unwrap();
    assert!(!after.contains("remote.prefs.recommended") && !after.contains(PREFS_MARKER), "{after}");
    assert!(after.contains("user_pref(\"a.b\", \"c\");") && after.contains("resume_session_once"));

    // Firefox rewrites prefs.js without comments: the pref alone still comes out.
    std::fs::write(profile.join("prefs.js"), "user_pref(\"remote.prefs.recommended\", false);\nuser_pref(\"x\", 1);\n").unwrap();
    assert!(remove_browse_prefs(&profile).unwrap());
    assert_eq!(std::fs::read_to_string(profile.join("prefs.js")).unwrap(), "user_pref(\"x\", 1);\n");

    // A profile that sets the pref itself is left as it is.
    std::fs::write(profile.join("prefs.js"), "user_pref(\"remote.prefs.recommended\", true);\n").unwrap();
    assert!(!ensure_real_profile_prefs(&profile).unwrap());

    let restores = mkdir(&s.0.join("restores"));
    std::fs::write(restores.join("prefs.js"), "user_pref(\"browser.startup.page\", 3);\n").unwrap();
    assert!(!ensure_resume_once(&restores).unwrap(), "a profile that restores every time needs nothing");
    let empty = mkdir(&s.0.join("empty"));
    assert!(ensure_real_profile_prefs(&empty).unwrap(), "no prefs.js yet");
    assert!(std::fs::read_to_string(empty.join("prefs.js")).unwrap().ends_with("user_pref(\"remote.prefs.recommended\", false);\n"));
}

#[test]
fn apps_are_found_in_bundles_program_files_and_path() {
    let s = Scratch::new("apps");
    let applications = mkdir(&s.0.join("Applications"));
    touch(&applications.join("Firefox.app/Contents/MacOS/firefox"));
    touch(&applications.join("Zen Browser.app/Contents/MacOS/zen"));
    touch(&s.0.join("pf/Firefox Nightly/firefox.exe"));
    touch(&s.0.join("bin/firefox-developer-edition"));
    let discovery = Discovery {
        os: Os::Mac,
        home: s.0.join("home"),
        app_dirs: vec![s.0.join("nothing"), applications.clone()],
        program_files: vec![s.0.join("pf")],
        path: Some(std::env::join_paths([s.0.join("bin")]).unwrap()),
        xdg_config: None,
        appdata: None,
    };
    let apps = discovery.apps();
    assert_eq!(apps.iter().map(|a| a.kind).collect::<Vec<_>>(), AppKind::ALL);
    assert_eq!(apps[0].bundle.as_deref(), Some(applications.join("Firefox.app").as_path()));
    assert_eq!(apps[0].exe, applications.join("Firefox.app/Contents/MacOS/firefox"));
    assert_eq!(apps[1].exe, s.0.join("bin/firefox-developer-edition"));
    assert_eq!(apps[2].exe, s.0.join("pf/Firefox Nightly/firefox.exe"));
    assert_eq!(apps[3].exe, applications.join("Zen Browser.app/Contents/MacOS/zen"));
    assert!(Discovery::none().apps().is_empty());
    assert!(Discovery::none().profile_roots(AppKind::Firefox).is_empty());

    let at = App::at(&applications.join("Zen Browser.app")).unwrap();
    assert_eq!((at.kind, at.exe), (AppKind::Zen, applications.join("Zen Browser.app/Contents/MacOS/zen")));
    assert_eq!(App::at(&s.0.join("bin/firefox-developer-edition")).unwrap().kind, AppKind::Dev);
    assert!(App::at(&s.0.join("missing")).is_none());
}

#[test]
fn profile_roots_follow_each_platform() {
    let home = PathBuf::from("/h");
    let on = |os| Discovery { os, home: home.clone(), app_dirs: vec![], program_files: vec![], path: None, xdg_config: Some("/cfg".into()), appdata: Some("/appdata".into()) };
    assert_eq!(on(Os::Mac).profile_roots(AppKind::Nightly), [home.join("Library/Application Support/Firefox")]);
    assert_eq!(on(Os::Mac).profile_roots(AppKind::Zen), [home.join("Library/Application Support/zen")]);
    let linux = on(Os::Linux).profile_roots(AppKind::Firefox);
    assert!(linux.contains(&home.join(".mozilla/firefox")) && linux.contains(&PathBuf::from("/cfg/mozilla/firefox")));
    assert!(linux.contains(&home.join("snap/firefox/common/.mozilla/firefox")) && linux.contains(&home.join(".var/app/org.mozilla.firefox/.mozilla/firefox")));
    assert_eq!(on(Os::Linux).profile_roots(AppKind::Zen)[0], home.join(".zen"));
    assert_eq!(on(Os::Windows).profile_roots(AppKind::Firefox), [PathBuf::from("/appdata").join("Mozilla").join("Firefox")]);
    assert_eq!(on(Os::Windows).profile_roots(AppKind::Zen), [PathBuf::from("/appdata").join("zen")]);
}

#[test]
fn recorded_profiles_round_trip() {
    let s = Scratch::new("recorded");
    let paths = Paths::rooted(s.0.clone());
    assert!(read_recorded(&paths).is_empty());
    let one = RecordedFirefox { app: "firefox".into(), exe: "/x/firefox".into(), profile: s.0.join("a"), endpoint: None, dedicated: false, headless: false, name: Some("Firefox".into()), prefs_added: true };
    let two = RecordedFirefox { app: "zen".into(), profile: s.0.join("b"), dedicated: true, headless: true, prefs_added: false, name: None, ..one.clone() };
    record(&paths, one.clone()).unwrap();
    record(&paths, two.clone()).unwrap();
    record(&paths, RecordedFirefox { prefs_added: false, ..one.clone() }).unwrap();
    let read = read_recorded(&paths);
    assert_eq!(read, [two.clone(), one.clone()], "a record keeps its prefs note");
    assert_eq!(two.display_name(), "Zen");
    assert_eq!(forget(&paths, &one.profile).unwrap(), Some(one.clone()));
    assert_eq!(forget(&paths, &one.profile).unwrap(), None);
    forget(&paths, &two.profile).unwrap();
    assert!(!recorded_path(&paths).exists(), "the last one removes the file");
    assert_eq!(dedicated_profile(&paths, AppKind::Zen), s.0.join("profiles/zen"));
    assert_eq!(driver_key(Path::new("/p/x")), "driver:bidi:/p/x");

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let url = format!("ws://127.0.0.1:{port}/session");
    assert!(live_endpoint(&url));
    assert!(!live_endpoint("ws://example.com:4444/session"));
    let app_only = RecordedFirefox {
        app: "firefox".into(),
        exe: "/Applications/Firefox.app".into(),
        profile: PathBuf::new(),
        endpoint: Some(url.clone()),
        dedicated: false,
        headless: false,
        name: Some("Firefox".into()),
        prefs_added: false,
    };
    assert_eq!(app_only.driver_key(), "driver:bidi:app:firefox");
    record(&paths, app_only.clone()).unwrap();
    assert_eq!(read_recorded(&paths), std::slice::from_ref(&app_only));
    assert_eq!(forget_key(&paths, &app_only.driver_key()).unwrap(), Some(app_only));
    drop(listener);
    assert!(!live_endpoint(&url));
}

#[test]
fn the_next_step_hint_names_firefox_only_when_it_is_installed() {
    let s = Scratch::new("hint");
    assert_eq!(next_step_hint(None, &[], &[]), None);
    assert_eq!(next_step_hint(Some(&Discovery::none()), &[], &[]), None);
    let applications = mkdir(&s.0.join("Applications"));
    touch(&applications.join("Zen.app/Contents/MacOS/zen"));
    let mut discovery = Discovery { app_dirs: vec![applications.clone()], ..Discovery::none() };
    assert_eq!(next_step_hint(Some(&discovery), &[], &[]).unwrap(), " Or run `browse firefox` to connect Zen.");
    touch(&applications.join("Firefox.app/Contents/MacOS/firefox"));
    assert_eq!(next_step_hint(Some(&discovery), &[], &[]).unwrap(), " Or run `browse firefox` to connect Firefox.");
    discovery.app_dirs.clear();
    let profile = mkdir(&s.0.join("p"));
    let recorded = [RecordedFirefox { app: "firefox".into(), exe: "/x".into(), profile, endpoint: None, dedicated: false, headless: false, name: None, prefs_added: false }];
    assert_eq!(next_step_hint(Some(&discovery), &recorded, &[]), None, "a recorded profile that isn't running needs nothing");
}

#[cfg(unix)]
#[test]
fn the_next_step_hint_says_what_a_recorded_profile_needs() {
    let s = Scratch::new("hint-running");
    let profile = mkdir(&s.0.join("p"));
    let recorded = [RecordedFirefox { app: "zen".into(), exe: "/x".into(), profile: profile.clone(), endpoint: None, dedicated: false, headless: false, name: None, prefs_added: false }];
    let holder = Holder::start(&profile);
    let hint = next_step_hint(None, &recorded, &[]).unwrap();
    assert!(hint.contains("Zen is open without remote control") && hint.contains("--relaunch") && hint.contains("--dedicated"), "{hint}");
    std::fs::write(profile.join("WebDriverBiDiServer.json"), r#"{"ws_host":"127.0.0.1","ws_port":4444}"#).unwrap();
    assert_eq!(next_step_hint(None, &recorded, &[]), None);
    let hint = next_step_hint(None, &recorded, &[driver_key(&profile)]).unwrap();
    assert!(hint.contains("another WebDriver BiDi client"), "{hint}");
    holder.release();
}
