//! Checking one transcript on its own (invariants) and diffing it against the reference's.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde_json::Value;

use crate::divergences::{ABSENT, KnownDivergence};
use crate::sites::SECRETS;
use crate::transcript::{Expect, StepRecord};

#[derive(Debug, Clone, PartialEq)]
pub struct Difference {
    pub key: String,
    pub pointer: String,
    pub reference: Value,
    pub other: Value,
}

fn escape(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

/// Every leaf where `a` and `b` differ; arrays of different lengths differ as a whole.
pub fn diff(a: &Value, b: &Value, pointer: &str, out: &mut Vec<(String, Value, Value)>) {
    if a == b {
        return;
    }
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let keys: BTreeSet<&String> = x.keys().chain(y.keys()).collect();
            let absent = Value::String(ABSENT.into());
            for key in keys {
                let child = format!("{pointer}/{}", escape(key));
                diff(x.get(key).unwrap_or(&absent), y.get(key).unwrap_or(&absent), &child, out);
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            for (i, (p, q)) in x.iter().zip(y).enumerate() {
                diff(p, q, &format!("{pointer}/{i}"), out);
            }
        }
        _ => out.push((pointer.to_string(), a.clone(), b.clone())),
    }
}

/// Words a backend's output must never contain: another browser's (or protocol's) name.
pub fn foreign_words(backend: &str) -> &'static [&'static str] {
    match backend {
        crate::launch::FIREFOX => &["Chrome", "Chromium", "CDP", "DevTools"],
        _ => &["Firefox", "Gecko", "BiDi"],
    }
}

/// Problems one backend's transcript has on its own. `tolerated` lists the step keys whose outcome (success or
/// error) may differ from the expectation, because a pinned divergence says so.
pub fn invariants(backend: &str, records: &[StepRecord], tolerated: &HashSet<String>) -> Vec<String> {
    let mut failures = Vec::new();
    let mut seen = HashSet::new();
    for record in records {
        let key = record.key();
        if !seen.insert(key.clone()) {
            failures.push(format!("{backend}: step {key} is recorded twice"));
        }
        let expected_error = record.expect == Expect::Error;
        if record.is_error != expected_error && !tolerated.contains(&key) {
            failures.push(format!(
                "{backend}: {key} ({}) {} but should have {}:\n{}",
                record.tool,
                if record.is_error { "failed" } else { "succeeded" },
                if expected_error { "failed" } else { "succeeded" },
                record.raw
            ));
        }
        for problem in &record.problems {
            failures.push(format!("{backend}: {key}: {problem}"));
        }
        for secret in SECRETS {
            if record.raw.contains(secret) {
                failures.push(format!("{backend}: {key} leaked the fixture secret {secret}"));
            }
        }
        // The normalized record, which leaves out the request headers (a Chromium user agent says "like Gecko").
        let shown = record.normalized.to_string();
        for word in foreign_words(backend) {
            if shown.contains(word) {
                failures.push(format!("{backend}: {key} mentions {word:?}:\n{}", record.raw));
            }
        }
    }
    failures
}

#[derive(Debug, Default)]
pub struct Comparison {
    pub compared: usize,
    pub failures: Vec<String>,
    /// The pinned divergences that occurred as pinned.
    pub matched: Vec<KnownDivergence>,
}

/// Diffs `other` against `reference` step by step. Each difference must be a pinned divergence with exactly these
/// values; each pinned divergence of a scenario that ran must occur.
pub fn compare(
    reference: &[StepRecord],
    other: &[StepRecord],
    other_name: &str,
    known: &[KnownDivergence],
    scenarios: &HashSet<String>,
) -> Comparison {
    let mut out = Comparison::default();
    let keys_a: Vec<String> = reference.iter().map(StepRecord::key).collect();
    let keys_b: Vec<String> = other.iter().map(StepRecord::key).collect();
    if keys_a != keys_b {
        let a: HashSet<&String> = keys_a.iter().collect();
        let b: HashSet<&String> = keys_b.iter().collect();
        for key in keys_a.iter().filter(|k| !b.contains(k)) {
            out.failures.push(format!("{other_name} has no step {key}"));
        }
        for key in keys_b.iter().filter(|k| !a.contains(k)) {
            out.failures.push(format!("{other_name} has a step {key} the reference doesn't"));
        }
        if out.failures.is_empty() {
            out.failures.push(format!("{other_name} ran the steps in another order"));
        }
    }
    let by_key: HashMap<String, &StepRecord> = other.iter().map(|r| (r.key(), r)).collect();
    let mut used = vec![false; known.len()];
    for a in reference {
        let key = a.key();
        let Some(b) = by_key.get(&key) else { continue };
        out.compared += 1;
        let mut differences = Vec::new();
        diff(&a.normalized, &b.normalized, "", &mut differences);
        for (pointer, ref_value, other_value) in differences {
            let pinned = known
                .iter()
                .enumerate()
                .find(|(_, k)| k.scenario == a.scenario && k.step == a.step && k.pointer == pointer);
            match pinned {
                Some((index, k)) if k.chromium == ref_value && k.firefox == other_value => {
                    used[index] = true;
                    out.matched.push(k.clone());
                }
                Some((index, k)) => {
                    used[index] = true;
                    out.failures.push(format!(
                        "{key} {pointer}: the pinned divergence no longer matches.\n  pinned:   {} / {}\n  observed: {} / {}",
                        k.chromium, k.firefox, ref_value, other_value
                    ));
                }
                None => out.failures.push(format!(
                    "{key} ({}) {pointer} differs:\n  reference:      {}\n  {other_name}: {}",
                    a.tool,
                    truncate(&ref_value.to_string()),
                    truncate(&other_value.to_string())
                )),
            }
        }
    }
    for (index, k) in known.iter().enumerate() {
        if !used[index] && scenarios.contains(k.scenario) {
            out.failures.push(format!(
                "pinned divergence {}/{} {} ({:?}) did not occur: remove it from divergences.rs",
                k.scenario, k.step, k.pointer, k.kind
            ));
        }
    }
    if out.compared != reference.len() || out.compared != other.len() {
        out.failures.push(format!(
            "compared {} steps, but the reference has {} and {other_name} {}",
            out.compared,
            reference.len(),
            other.len()
        ));
    }
    out
}

fn truncate(text: &str) -> String {
    if text.chars().count() > 4000 { format!("{}…", text.chars().take(4000).collect::<String>()) } else { text.to_string() }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::divergences::{Kind, KnownDivergence};

    fn record(step: &str, normalized: Value) -> StepRecord {
        StepRecord {
            scenario: "s".into(),
            step: step.into(),
            tool: "eval".into(),
            expect: Expect::Ok,
            is_error: false,
            raw: String::new(),
            normalized,
            images: Vec::new(),
            problems: Vec::new(),
        }
    }

    #[test]
    fn diffs_point_at_leaves() {
        let mut out = Vec::new();
        diff(&json!({ "a": 1, "b": [1, 2], "c": { "d": "x" } }), &json!({ "a": 1, "b": [1, 3], "c": {} }), "", &mut out);
        assert_eq!(out, vec![("/b/1".to_string(), json!(2), json!(3)), ("/c/d".to_string(), json!("x"), json!(ABSENT))]);
    }

    #[test]
    fn identical_transcripts_compare_clean() {
        let a = vec![record("one", json!({ "result": 1 }))];
        let result = compare(&a, &a.clone(), "other", &[], &HashSet::from(["s".to_string()]));
        assert!(result.failures.is_empty(), "{:?}", result.failures);
        assert_eq!(result.compared, 1);
    }

    #[test]
    fn unpinned_differences_fail_and_pinned_ones_pass() {
        let a = vec![record("one", json!({ "result": 1 }))];
        let b = vec![record("one", json!({ "result": 2 }))];
        let scenarios = HashSet::from(["s".to_string()]);
        assert_eq!(compare(&a, &b, "other", &[], &scenarios).failures.len(), 1);
        let pinned = KnownDivergence { scenario: "s", step: "one", pointer: "/result", kind: Kind::Engine("test"), chromium: json!(1), firefox: json!(2) };
        let result = compare(&a, &b, "other", std::slice::from_ref(&pinned), &scenarios);
        assert!(result.failures.is_empty(), "{:?}", result.failures);
        assert_eq!(result.matched.len(), 1);
        let wrong = KnownDivergence { firefox: json!(3), ..pinned };
        assert_eq!(compare(&a, &b, "other", &[wrong], &scenarios).failures.len(), 1, "pinned values are strict");
    }

    #[test]
    fn a_stale_divergence_fails_the_sweep() {
        let a = vec![record("one", json!({ "result": 1 }))];
        let pinned = KnownDivergence { scenario: "s", step: "one", pointer: "/result", kind: Kind::Unsupported, chromium: json!(1), firefox: json!(2) };
        let result = compare(&a, &a.clone(), "other", std::slice::from_ref(&pinned), &HashSet::from(["s".to_string()]));
        assert_eq!(result.failures.len(), 1);
        assert!(result.failures[0].contains("did not occur"));
        let skipped = compare(&a, &a.clone(), "other", &[pinned], &HashSet::new());
        assert!(skipped.failures.is_empty(), "a scenario that didn't run can't show its divergences");
    }

    #[test]
    fn missing_steps_and_vacuous_runs_fail() {
        let a = vec![record("one", json!(1)), record("two", json!(2))];
        let b = vec![record("one", json!(1))];
        let result = compare(&a, &b, "other", &[], &HashSet::new());
        assert!(result.failures.iter().any(|f| f.contains("has no step s/two")), "{:?}", result.failures);
        assert!(result.failures.iter().any(|f| f.contains("compared 1 steps")), "{:?}", result.failures);
    }

    #[test]
    fn invariants_catch_leaks_foreign_words_and_unexpected_outcomes() {
        let mut leaked = record("one", json!(1));
        leaked.raw = format!("token {}", crate::sites::BEARER);
        let chrome = record("two", json!({ "result": ["Chrome could not load it"] }));
        let mut failed = record("three", json!(1));
        failed.is_error = true;
        let failures = invariants(crate::launch::FIREFOX, &[leaked, chrome, failed.clone()], &HashSet::new());
        assert_eq!(failures.len(), 3, "{failures:?}");
        assert!(invariants(crate::launch::FIREFOX, &[failed], &HashSet::from(["s/three".to_string()])).is_empty());
    }
}
