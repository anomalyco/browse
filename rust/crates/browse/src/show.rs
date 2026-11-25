//! `browse show [tab] [--json]`: brings a tab waiting on you (a handoff) to the front, as clicking browse's handoff
//! notification does, for a tool outside the browser (a notification of its own) to take you there.

use anyhow::bail;
use serde_json::{Value, json};

use crate::relay;

pub fn command(args: &[String]) -> anyhow::Result<i32> {
    let (tab, json) = parse(args)?;
    let answer = relay::show_tab(tab.as_deref())?;
    let (status, answer) = answer.unwrap_or_else(|| (404, json!({ "error": "No tab is waiting on you" })));
    if json {
        println!("{answer}");
        return Ok(if status == 200 { 0 } else { 1 });
    }
    if status != 200 {
        eprintln!("{}", answer["error"].as_str().unwrap_or("The relay couldn't bring the tab to the front"));
        return Ok(1);
    }
    let message = answer["handoff"]["message"].as_str().unwrap_or_default();
    println!("✓ Tab {} is in front: {}", answer["tab"], answer["url"].as_str().unwrap_or_default());
    if !message.is_empty() {
        println!("  waiting on you: {}", Value::from(message));
    }
    Ok(0)
}

/// The tab (a positional value or `--tab`) and `--json`.
fn parse(args: &[String]) -> anyhow::Result<(Option<String>, bool)> {
    let (mut tab, mut json) = (None, false);
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let value = match arg.as_str() {
            "--json" => {
                json = true;
                continue;
            }
            "--tab" => match rest.next() {
                Some(value) => value.clone(),
                None => bail!("--tab needs a tab id"),
            },
            other if other.starts_with("--tab=") => other["--tab=".len()..].to_string(),
            other if other.starts_with('-') => bail!("Unknown option {other} for show. Run `browse --help`."),
            other => other.to_string(),
        };
        if tab.replace(value).is_some() {
            bail!("show takes one tab");
        }
    }
    Ok((tab, json))
}

#[cfg(test)]
mod tests {
    use super::parse;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn the_tab_is_positional_or_a_flag() {
        assert_eq!(parse(&args(&[])).unwrap(), (None, false));
        assert_eq!(parse(&args(&["12", "--json"])).unwrap(), (Some("12".into()), true));
        assert_eq!(parse(&args(&["--json", "--tab", "work-mail"])).unwrap(), (Some("work-mail".into()), true));
        assert_eq!(parse(&args(&["--tab=12"])).unwrap(), (Some("12".into()), false));
        assert!(parse(&args(&["12", "13"])).is_err());
        assert!(parse(&args(&["--tab"])).is_err());
        assert!(parse(&args(&["--front"])).is_err());
    }
}
