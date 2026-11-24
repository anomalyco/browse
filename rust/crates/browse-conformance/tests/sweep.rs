//! The conformance sweep (`conformance_sweep`, against every installed browser) and its browser-free checks.
//!
//! Environment:
//! - `BROWSE_CONFORMANCE_REQUIRE`: backends that must be found (`chromium-cdp,firefox-bidi`); missing ones fail.
//! - `BROWSE_CONFORMANCE_BACKENDS`: only these backends.
//! - `BROWSE_CONFORMANCE_ONLY`: only these scenarios (the baseline the leak canary needs is kept).
//! - `BROWSE_CONFORMANCE_OUT`: write `<backend>.json` transcripts and `diff.json` there.
//! - `BROWSE_TEST_CHROME` / `BROWSE_TEST_FIREFOX`: the browser binaries to use.

use std::collections::HashSet;
use std::time::Duration;

use browse_conformance::compare::{self, Comparison};
use browse_conformance::divergences::{self, Kind};
use browse_conformance::launch::{self, BACKENDS, CHROMIUM, Launched, TESTED_WITH};
use browse_conformance::scenario::{self, Env, Scenario};
use browse_conformance::sites::{FixtureSites, Site};
use browse_conformance::transcript::StepRecord;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn list(name: &str) -> Option<Vec<String>> {
    let value = std::env::var(name).ok()?;
    let items: Vec<String> = value.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    (!items.is_empty()).then_some(items)
}

fn selected(all: &[Scenario]) -> Vec<&Scenario> {
    match list("BROWSE_CONFORMANCE_ONLY") {
        None => all.iter().collect(),
        Some(only) => {
            let unknown: Vec<&String> = only.iter().filter(|name| !all.iter().any(|s| s.name == name.as_str())).collect();
            assert!(unknown.is_empty(), "BROWSE_CONFORMANCE_ONLY names unknown scenarios: {unknown:?}");
            all.iter()
                .filter(|s| only.iter().any(|o| o == s.name) || (s.name == "baseline" && only.iter().any(|o| o == "leak_canary")))
                .collect()
        }
    }
}

/// A digest of a transcript's normalized records, to compare runs at a glance.
fn digest(records: &[StepRecord]) -> String {
    let text: String = records.iter().map(|r| format!("{}\n{}\n", r.key(), r.normalized)).collect();
    format!("{:08x}", browse_conformance::sites::crc32(text.as_bytes()))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn conformance_sweep() {
    let required: Vec<String> = list("BROWSE_CONFORMANCE_REQUIRE").unwrap_or_default();
    let backends: Vec<String> = list("BROWSE_CONFORMANCE_BACKENDS").unwrap_or_else(|| BACKENDS.iter().map(|b| b.to_string()).collect());
    for name in required.iter().chain(&backends) {
        assert!(BACKENDS.contains(&name.as_str()), "unknown backend {name}; the backends are {BACKENDS:?}");
    }
    let all = scenario::all();
    let scenarios = selected(&all);
    let mut failures: Vec<String> = Vec::new();

    let launches = futures_launch(&backends).await;
    let mut launched: Vec<Launched> = Vec::new();
    for (name, result) in launches {
        match result {
            Ok(Some(browser)) => launched.push(browser),
            Ok(None) if required.contains(&name) => failures.push(format!("{name} is required but no browser for it is installed")),
            Ok(None) => eprintln!("conformance: {name}: not installed, skipped"),
            Err(error) => failures.push(format!("{name}: the browser is installed but did not start: {error:#}")),
        }
    }
    eprintln!("conformance sweep: {} scenarios", scenarios.len());
    for browser in &launched {
        eprintln!("  {:<30} {} ({})", browser.label, browser.version, browser.binary.display());
    }
    for (backend, version) in TESTED_WITH {
        eprintln!("  pinned divergences last verified with {backend}: {version}");
    }
    if launched.is_empty() {
        for browser in launched {
            browser.quit().await;
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
        eprintln!("conformance: no browser installed; nothing to sweep");
        return;
    }

    let scenario_names: HashSet<String> = scenarios.iter().map(|s| s.name.to_string()).collect();
    let runs = futures_util::future::join_all(launched.iter().map(|browser| {
        let scenarios = scenarios.clone();
        async move {
            let started = std::time::Instant::now();
            let env = match Env::new(browser).await {
                Ok(env) => env,
                Err(error) => return (browser.backend, Err(error)),
            };
            let records = env.run(&scenarios).await;
            eprintln!("  {} finished in {:.1} s", browser.label, started.elapsed().as_secs_f64());
            (browser.backend, Ok(records))
        }
    }))
    .await;
    for browser in launched {
        browser.quit().await;
    }

    let known = divergences::known();
    let tolerated: HashSet<String> =
        known.iter().filter(|k| k.pointer == "/error").map(|k| format!("{}/{}", k.scenario, k.step)).collect();
    let mut transcripts: Vec<(&str, Vec<StepRecord>)> = Vec::new();
    for (backend, result) in runs {
        match result {
            Ok(records) => {
                let allowed = if backend == CHROMIUM { HashSet::new() } else { tolerated.clone() };
                failures.extend(compare::invariants(backend, &records, &allowed));
                eprintln!("  {backend}: {} steps, transcript digest {}", records.len(), digest(&records));
                transcripts.push((backend, records));
            }
            Err(error) => failures.push(format!("{backend}: the sweep could not start: {error:#}")),
        }
    }
    let reference = transcripts.iter().find(|(b, _)| *b == CHROMIUM);
    let mut comparisons: Vec<(&str, Comparison)> = Vec::new();
    if let Some((_, reference)) = reference {
        for (backend, records) in transcripts.iter().filter(|(b, _)| *b != CHROMIUM) {
            let comparison = compare::compare(reference, records, backend, &known, &scenario_names);
            eprintln!("  {backend} vs {CHROMIUM}: {} steps compared, {} pinned divergences matched", comparison.compared, comparison.matched.len());
            failures.extend(comparison.failures.iter().cloned());
            comparisons.push((backend, comparison));
        }
    }
    if let Some(dir) = std::env::var_os("BROWSE_CONFORMANCE_OUT") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).expect("BROWSE_CONFORMANCE_OUT");
        for (backend, records) in &transcripts {
            let value = Value::Array(records.iter().map(StepRecord::to_json).collect());
            std::fs::write(dir.join(format!("{backend}.json")), serde_json::to_string_pretty(&value).unwrap()).unwrap();
        }
        let diff: Vec<Value> = comparisons
            .iter()
            .map(|(backend, c)| json!({ "backend": backend, "compared": c.compared, "failures": c.failures, "matched": c.matched.len() }))
            .collect();
        std::fs::write(dir.join("diff.json"), serde_json::to_string_pretty(&diff).unwrap()).unwrap();
    }
    assert!(failures.is_empty(), "{} conformance failures:\n\n{}", failures.len(), failures.join("\n\n"));
}

async fn futures_launch(backends: &[String]) -> Vec<(String, anyhow::Result<Option<Launched>>)> {
    futures_util::future::join_all(backends.iter().map(|name| async move { (name.clone(), launch::launch(name).await) })).await
}

#[test]
fn divergences_name_real_steps_once() {
    let all = scenario::all();
    let mut seen = HashSet::new();
    for k in divergences::known() {
        assert!(all.iter().any(|s| s.name == k.scenario), "{} is not a scenario", k.scenario);
        assert!(seen.insert((k.scenario, k.step, k.pointer)), "{}/{} {} is pinned twice", k.scenario, k.step, k.pointer);
        assert!(k.pointer.is_empty() || k.pointer.starts_with('/'), "{} is not a JSON pointer", k.pointer);
        assert_ne!(k.chromium, k.firefox, "{}/{} {} pins no difference", k.scenario, k.step, k.pointer);
        if let Kind::Engine(why) | Kind::Bug(why) = k.kind {
            assert!(!why.trim().is_empty(), "{}/{} needs a reason", k.scenario, k.step);
        }
    }
}

#[test]
fn scenario_names_are_unique_and_bookended() {
    let all = scenario::all();
    let names: HashSet<&str> = all.iter().map(|s| s.name).collect();
    assert_eq!(names.len(), all.len());
    assert_eq!(all.first().map(|s| s.name), Some("baseline"));
    assert_eq!(all.last().map(|s| s.name), Some("leak_canary"));
}

async fn get(port: u16, request: &str) -> String {
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    let mut chunk = [0u8; 4096];
    // Responses are keep-alive: read until the whole body (by Content-Length) arrived.
    loop {
        let n = stream.read(&mut chunk).await.unwrap();
        if n == 0 {
            break;
        }
        out.extend_from_slice(&chunk[..n]);
        let text = String::from_utf8_lossy(&out).to_string();
        if let Some((head, body)) = text.split_once("\r\n\r\n") {
            let length = head
                .lines()
                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                .unwrap_or(0);
            if body.len() >= length {
                break;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

#[tokio::test]
async fn fixture_sites_serve_log_and_gate() {
    let sites = FixtureSites::start().await.unwrap();
    let page = get(sites.primary_port, "GET /app HTTP/1.1\r\nHost: x\r\n\r\n").await;
    assert!(page.starts_with("HTTP/1.1 200 OK"), "{page}");
    assert!(page.contains("Cache-Control: no-store") && page.contains("<link rel=\"icon\" href=\"data:,\">"), "{page}");
    let login = get(sites.primary_port, "POST /api/login HTTP/1.1\r\nContent-Length: 14\r\n\r\n{\"user\":\"ada\"}").await;
    assert_eq!(login.matches("Set-Cookie:").count(), 2, "{login}");
    assert!(login.contains("\"user\":\"ada\""), "{login}");
    let icon = get(sites.primary_port, "GET /favicon.ico HTTP/1.1\r\n\r\n").await;
    assert!(icon.starts_with("HTTP/1.1 204"), "{icon}");
    let frame = get(sites.cross_port, "GET /frames/cross HTTP/1.1\r\n\r\n").await;
    assert!(frame.contains("Cross button"), "{frame}");

    let port = sites.primary_port;
    let gated = tokio::spawn(async move { get(port, "GET /gate/smoke HTTP/1.1\r\n\r\n").await });
    let started = std::time::Instant::now();
    while sites.requests("/gate/smoke").is_empty() {
        assert!(started.elapsed() < Duration::from_secs(5), "the gated request never arrived");
        tokio::task::yield_now().await;
    }
    assert!(!gated.is_finished(), "a gate holds its requests until opened");
    sites.open_gate("smoke");
    let opened = tokio::time::timeout(Duration::from_secs(5), gated).await.unwrap().unwrap();
    assert!(opened.contains("Gate smoke opened"), "{opened}");
    let log = sites.log();
    assert_eq!(log.iter().filter(|r| r.site == Site::Cross).count(), 1);
    assert_eq!(log.iter().find(|r| r.path() == "/api/login").map(|r| r.body.clone()), Some(b"{\"user\":\"ada\"}".to_vec()));
}

#[tokio::test]
async fn a_large_request_body_is_read_whole() {
    let sites = FixtureSites::start().await.unwrap();
    let body = "x".repeat(100_000);
    let reply = get(sites.primary_port, &format!("POST /api/form HTTP/1.1\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n{body}", body.len())).await;
    assert!(reply.contains("\"received\":100000"), "{reply}");
}
