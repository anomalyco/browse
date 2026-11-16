//! dsh (DeepSeek Harness) keeps MCP servers as rows of a Cordis patch layer: a top-level YAML sequence where each item
//! is an `insert` patch. The machine-wide layer is `$DSH_HOME/cordis.patch.yml`. Only one item shape is browse's: an
//! `insert` holding a row for `@deepseek-ai/dsh-mcp-client` whose `config.serverName` is `browse`.
//!
//! The file belongs to the user and may hold comments, anchors and `!!js` tags, so edits append or replace our item's
//! lines and then reparse to prove nothing else changed. Our item is only touched when it is the last top-level item and
//! holds nothing but our row; a row inside the user's own insert patch is left alone.

use serde_json::Value;

use crate::agents::{Edit, owned};

/// The dsh plugin package that carries MCP client rows.
const CLIENT: &str = "@deepseek-ai/dsh-mcp-client";
/// Our row's stable id inside the patch tree.
const ROW_ID: &str = "browse";

/// A row found in the patch layer, and whether its top-level item exists only for it.
struct Owner<'a> {
    item: usize,
    whole: bool,
    config: &'a serde_yaml::Value,
}

fn patches(value: &serde_yaml::Value) -> Option<&Vec<serde_yaml::Value>> {
    match value {
        serde_yaml::Value::Sequence(items) => Some(items),
        _ => None,
    }
}

/// Every row that names our client and the browse server, at the top level of the patch list.
fn owners(items: &[serde_yaml::Value]) -> Vec<Owner<'_>> {
    let mut found = Vec::new();
    for (item, patch) in items.iter().enumerate() {
        let serde_yaml::Value::Mapping(map) = patch else { continue };
        let Some(serde_yaml::Value::Sequence(rows)) = map.get("insert") else { continue };
        for row in rows {
            let serde_yaml::Value::Mapping(row) = row else { continue };
            if row.get("name").and_then(serde_yaml::Value::as_str) != Some(CLIENT) {
                continue;
            }
            let Some(config @ serde_yaml::Value::Mapping(config_map)) = row.get("config") else { continue };
            if config_map.get("serverName").and_then(serde_yaml::Value::as_str) != Some("browse") {
                continue;
            }
            found.push(Owner { item, whole: map.len() == 1 && rows.len() == 1, config });
        }
    }
    found
}

/// The one patch item browse writes, for a server config.
fn patch(expected: &Value) -> anyhow::Result<serde_yaml::Value> {
    let mut row = serde_yaml::Mapping::new();
    row.insert("id".into(), ROW_ID.into());
    row.insert("name".into(), CLIENT.into());
    row.insert("config".into(), serde_yaml::to_value(expected)?);
    let mut item = serde_yaml::Mapping::new();
    item.insert("insert".into(), serde_yaml::Value::Sequence(vec![serde_yaml::Value::Mapping(row)]));
    Ok(serde_yaml::Value::Mapping(item))
}

/// The item as block text at column 0, so it can be appended to a file without touching a byte before it.
fn render(expected: &Value) -> anyhow::Result<String> {
    let text = serde_yaml::to_string(&patch(expected)?)?;
    let mut out = String::new();
    for (index, line) in text.lines().enumerate() {
        if index == 0 {
            out.push_str("- ");
        } else {
            out.push('\n');
            out.push_str("  ");
        }
        out.push_str(line);
    }
    out.push('\n');
    Ok(out)
}

/// Whether a line carries content (not blank, not only a comment).
fn content(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty() && !trimmed.starts_with('#')
}

fn first_content(text: &str) -> Option<&str> {
    text.lines().find(|line| content(line))
}

/// Byte spans of each line (with its newline) and the line without its ending.
fn line_spans(text: &str) -> Vec<(usize, usize, &str)> {
    let mut spans = Vec::new();
    let mut start = 0;
    for (index, byte) in text.bytes().enumerate() {
        if byte == b'\n' {
            let line = text[start..index].strip_suffix('\r').unwrap_or(&text[start..index]);
            spans.push((start, index + 1, line));
            start = index + 1;
        }
    }
    if start < text.len() {
        spans.push((start, text.len(), &text[start..]));
    }
    spans
}

/// The lines that begin a top-level block sequence entry. A block sequence is the only shape browse edits, so every item
/// must be one of these in order; `---` and `...` do not match.
fn entry_lines(spans: &[(usize, usize, &str)]) -> Vec<usize> {
    spans.iter().enumerate().filter(|(_, (_, _, line))| *line == "-" || line.starts_with("- ")).map(|(index, _)| index).collect()
}

/// Where our last item's own lines end: its last content line, leaving any trailing blanks or comments for the user.
fn item_end(spans: &[(usize, usize, &str)], start: usize) -> usize {
    spans
        .iter()
        .rposition(|(_, _, line)| content(line))
        .filter(|&index| index >= start)
        .map_or(spans.last().map_or(0, |span| span.1), |index| spans[index].1)
}

fn verify(after: &str, wanted: &serde_yaml::Value) -> bool {
    serde_yaml::from_str::<serde_yaml::Value>(after).is_ok_and(|value| &value == wanted)
}

/// Adds browse's row, updates one an earlier install wrote, or with `remove` takes it out again. Returns the new text
/// when it changes, and the edit's outcome.
pub fn edit(before: &str, expected: &Value, remove: bool) -> anyhow::Result<(Option<String>, Edit)> {
    let invalid = || anyhow::anyhow!("isn't a dsh patch layer browse can edit safely; add the browse entry by hand");
    let blank = before.trim().is_empty();
    // `[]` is the empty layer dsh recommends; it is flow style, but there is nothing to preserve.
    let empty_flow = before.trim() == "[]";
    if !blank && !empty_flow && first_content(before).is_some_and(|line| line.starts_with('[')) {
        return Err(invalid());
    }
    let parsed = if blank || empty_flow { serde_yaml::Value::Sequence(Vec::new()) } else { serde_yaml::from_str(before).map_err(|_| invalid())? };
    let items = patches(&parsed).ok_or_else(invalid)?;
    let found = owners(items);
    if found.len() > 1 {
        return Ok((None, Edit::Conflict));
    }
    let Some(owner) = found.first() else {
        if remove {
            return Ok((None, Edit::Unchanged));
        }
        let after = if blank || empty_flow {
            render(expected)?
        } else if before.ends_with('\n') {
            format!("{before}{}", render(expected)?)
        } else {
            format!("{before}\n{}", render(expected)?)
        };
        let mut wanted = items.clone();
        wanted.push(patch(expected)?);
        if !verify(&after, &serde_yaml::Value::Sequence(wanted)) {
            return Err(invalid());
        }
        return Ok((Some(after), Edit::Added));
    };
    let Ok(current) = serde_json::to_value(owner.config) else { return Ok((None, Edit::Conflict)) };
    if !current.is_object() {
        return Ok((None, Edit::Conflict));
    }
    if !owned(&current) {
        return Ok((None, Edit::Conflict));
    }
    if !remove && &current == expected {
        return Ok((None, Edit::Unchanged));
    }
    // Only our own trailing item is safe to rewrite or cut: a row inside the user's insert patch stays theirs.
    if !owner.whole || owner.item + 1 != items.len() {
        return Ok((None, Edit::Conflict));
    }
    let spans = line_spans(before);
    let entries = entry_lines(&spans);
    if entries.len() != items.len() {
        return Err(invalid());
    }
    let start = spans[entries[owner.item]].0;
    let end = item_end(&spans, entries[owner.item]);
    let mut wanted = items.clone();
    if remove {
        wanted.truncate(owner.item);
        let mut after = String::from(&before[..start]);
        after.push_str(&before[end..]);
        if wanted.is_empty() {
            after = "[]\n".to_owned();
        }
        if !verify(&after, &serde_yaml::Value::Sequence(wanted)) {
            return Err(invalid());
        }
        return Ok((Some(after), Edit::Removed));
    }
    let after = format!("{}{}{}", &before[..start], render(expected)?, &before[end..]);
    wanted[owner.item] = patch(expected)?;
    if !verify(&after, &serde_yaml::Value::Sequence(wanted)) {
        return Err(invalid());
    }
    Ok((Some(after), Edit::Updated))
}

/// The browse server's `config` in a dsh patch layer, for status and read-back.
pub fn current(text: &str) -> Option<Value> {
    let parsed: serde_yaml::Value = serde_yaml::from_str(text).ok()?;
    let found = owners(patches(&parsed)?);
    if found.len() != 1 {
        return None;
    }
    serde_json::to_value(found[0].config).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(command: &str) -> Value {
        serde_json::json!({ "serverName": "browse", "transport": "stdio", "command": command, "args": ["mcp"] })
    }

    #[test]
    fn renders_a_block_item_at_column_zero() {
        let text = render(&config("/bin/browse")).unwrap();
        assert!(text.starts_with("- insert:\n"), "{text}");
        assert!(text.ends_with('\n'));
        let parsed: serde_yaml::Value = serde_yaml::from_str(&text).unwrap();
        let rows = owners(patches(&parsed).unwrap());
        assert_eq!(rows.len(), 1);
        assert!(rows[0].whole);
    }

    #[test]
    fn refuses_a_flow_sequence_root() {
        let error = edit("[{ insert: [{ id: other, name: other }] }]\n", &config("/bin/browse"), false).unwrap_err();
        assert!(error.to_string().contains("isn't a dsh patch layer"), "{error}");
        // A block item whose nested insert is flow style is still a patch list browse can append to.
        assert_eq!(edit("- insert: [{ id: other, name: other }]\n", &config("/bin/browse"), false).unwrap().1, Edit::Added);
        // An empty flow sequence is the empty layer, and is replaced.
        assert_eq!(edit("[]\n", &config("/bin/browse"), false).unwrap().1, Edit::Added);
    }

    #[test]
    fn a_row_in_a_user_patch_is_left_alone() {
        let before = "- insert:\n  - id: browse\n    name: '@deepseek-ai/dsh-mcp-client'\n    config:\n      serverName: browse\n      transport: stdio\n      command: /bin/browse\n      args:\n      - mcp\n  - id: other\n    name: other\n";
        assert_eq!(edit(before, &config("/bin/browse"), false).unwrap().1, Edit::Unchanged);
        assert_eq!(edit(before, &config("/usr/bin/browse"), false).unwrap().1, Edit::Conflict);
        assert_eq!(edit(before, &config("/bin/browse"), true).unwrap().1, Edit::Conflict);
    }

    #[test]
    fn removing_the_last_item_restores_the_original() {
        let original = "# mine\n- insert:\n  - id: other\n    name: other\n    config:\n      expr: !!js process.env.X # keep\n";
        let added = edit(original, &config("/bin/browse"), false).unwrap().0.unwrap();
        assert!(added.starts_with(original));
        let removed = edit(&added, &config("/bin/browse"), true).unwrap().0.unwrap();
        assert_eq!(removed, original);
    }

    #[test]
    fn current_reads_the_server_config() {
        let text = edit("", &config("/bin/browse"), false).unwrap().0.unwrap();
        assert_eq!(current(&text), Some(config("/bin/browse")));
        assert_eq!(current("# nothing\n"), None);
    }

    #[test]
    fn an_ambiguous_row_is_a_conflict() {
        let page = |id: &str| format!("- insert:\n  - id: {id}\n    name: '@deepseek-ai/dsh-mcp-client'\n    config:\n      serverName: browse\n      transport: stdio\n      command: /bin/browse\n      args:\n      - mcp\n");
        let before = format!("{}{}", page("one"), page("two"));
        assert_eq!(edit(&before, &config("/bin/browse"), false).unwrap().1, Edit::Conflict);
        assert_eq!(current(&before), None);
    }

    #[test]
    fn a_changed_command_is_updated() {
        let original = "# mine\n- insert:\n  - id: other\n    name: other\n";
        let added = edit(original, &config("/bin/browse"), false).unwrap().0.unwrap();
        let (after, outcome) = edit(&added, &config("/usr/bin/browse"), false).unwrap();
        assert_eq!(outcome, Edit::Updated);
        let after = after.unwrap();
        assert!(after.starts_with(original), "{after}");
        assert_eq!(current(&after), Some(config("/usr/bin/browse")));
    }

    #[test]
    fn tags_and_anchors_survive() {
        let original = "# mine\n- insert:\n  - id: other\n    name: other\n    config:\n      shared: &shared\n        keep: true\n      copy: *shared\n      expr: !!js process.env.OTHER\n";
        let added = edit(original, &config("/bin/browse"), false).unwrap().0.unwrap();
        assert!(added.starts_with(original), "{added}");
        let removed = edit(&added, &config("/bin/browse"), true).unwrap().0.unwrap();
        assert_eq!(removed, original);
        let parsed: serde_yaml::Value = serde_yaml::from_str(&added).unwrap();
        let rows = owners(patches(&parsed).unwrap());
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn a_missing_file_starts_a_block_list() {
        let added = edit("", &config("/bin/browse"), false).unwrap().0.unwrap();
        assert!(added.starts_with("- insert:\n"), "{added}");
        let removed = edit(&added, &config("/bin/browse"), true).unwrap().0.unwrap();
        assert_eq!(removed, "[]\n");
        assert_eq!(edit("", &config("/bin/browse"), true).unwrap().1, Edit::Unchanged);
    }

    #[test]
    fn a_trailing_comment_is_not_ours() {
        let original = "- insert:\n  - id: other\n    name: other\n";
        let added = edit(original, &config("/bin/browse"), false).unwrap().0.unwrap();
        let with_comment = format!("{added}\n# after\n");
        assert_eq!(edit(&with_comment, &config("/bin/browse"), true).unwrap().0.unwrap(), format!("{original}\n# after\n"));
    }

    #[test]
    fn a_file_that_is_not_a_patch_list_is_invalid() {
        assert!(edit("name: not-a-list\n", &config("/bin/browse"), false).is_err());
        assert!(edit("- insert: [\n", &config("/bin/browse"), false).is_err());
    }
}
