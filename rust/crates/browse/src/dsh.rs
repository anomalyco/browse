//! dsh (DeepSeek Harness) keeps MCP servers as rows of a Cordis patch layer: a top-level YAML sequence where each item
//! is an `insert` patch. The machine-wide layer is `$DSH_HOME/cordis.patch.yml`. Only one item shape is browse's: an
//! `insert` holding a row for `@deepseek-ai/dsh-mcp-client` whose `config.serverName` is `browse`.
//!
//! The file belongs to the user and may hold comments, anchors and `!!js` tags, so edits append, replace or cut only our
//! item's lines and then reparse to prove nothing else changed. Bytes outside those lines are never rewritten, including
//! CRLF line endings.

use serde_json::Value;

use crate::agents::{Edit, owned};

/// The dsh plugin package that carries MCP client rows.
const CLIENT: &str = "@deepseek-ai/dsh-mcp-client";
/// Our row's stable id inside the patch tree, named like dsh's own `mcp-github` examples.
pub(crate) const ROW_ID: &str = "mcp-browse";
/// The fields browse owns inside the row's `config`; everything else there is the user's.
const FIELDS: [&str; 4] = ["serverName", "transport", "command", "args"];

/// A row found in the patch layer, its place, and whether its top-level item exists only for it.
struct Owner<'a> {
    item: usize,
    row: usize,
    whole: bool,
    node: &'a serde_yaml::Mapping,
    config: &'a serde_yaml::Mapping,
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
        for (row, node) in rows.iter().enumerate() {
            let serde_yaml::Value::Mapping(node) = node else { continue };
            if node.get("name").and_then(serde_yaml::Value::as_str) != Some(CLIENT) {
                continue;
            }
            let Some(serde_yaml::Value::Mapping(config_map)) = node.get("config") else { continue };
            if config_map.get("serverName").and_then(serde_yaml::Value::as_str) != Some("browse") {
                continue;
            }
            found.push(Owner { item, row, whole: map.len() == 1 && rows.len() == 1, node, config: config_map });
        }
    }
    found
}

/// Whether any other row already holds the id browse writes. Inserting a second one would break dsh's patch tree.
fn id_taken(items: &[serde_yaml::Value]) -> bool {
    let ours = |row: &serde_yaml::Mapping| {
        row.get("name").and_then(serde_yaml::Value::as_str) == Some(CLIENT)
            && matches!(row.get("config"), Some(serde_yaml::Value::Mapping(config)) if config.get("serverName").and_then(serde_yaml::Value::as_str) == Some("browse"))
    };
    items.iter().any(|patch| {
        let serde_yaml::Value::Mapping(map) = patch else { return false };
        let Some(serde_yaml::Value::Sequence(rows)) = map.get("insert") else { return false };
        rows.iter().any(|row| {
            let serde_yaml::Value::Mapping(row) = row else { return false };
            row.get("id").and_then(serde_yaml::Value::as_str) == Some(ROW_ID) && !ours(row)
        })
    })
}

/// The one patch item browse writes, for a row.
fn patch(row: serde_yaml::Value) -> anyhow::Result<serde_yaml::Value> {
    let mut item = serde_yaml::Mapping::new();
    item.insert("insert".into(), serde_yaml::Value::Sequence(vec![row]));
    Ok(serde_yaml::Value::Mapping(item))
}

/// A fresh row for a server config.
fn row(config: &Value) -> anyhow::Result<serde_yaml::Value> {
    let mut row = serde_yaml::Mapping::new();
    row.insert("id".into(), ROW_ID.into());
    row.insert("name".into(), CLIENT.into());
    row.insert("config".into(), serde_yaml::to_value(config)?);
    Ok(serde_yaml::Value::Mapping(row))
}

/// Whether browse's own config fields already match; everything else in the user's config is left alone.
fn same_fields(current: &serde_yaml::Mapping, expected: &serde_yaml::Mapping) -> bool {
    FIELDS.iter().all(|key| current.get(*key) == expected.get(*key))
}

/// The user's config with only browse's fields set. YAML values stay as they are, so `!!js` tags survive.
fn merged_config(current: &serde_yaml::Mapping, expected: &serde_yaml::Mapping) -> serde_yaml::Mapping {
    let mut config = current.clone();
    for key in FIELDS {
        if let Some(value) = expected.get(key) {
            config.insert(key.into(), value.clone());
        }
    }
    config
}

/// A line's content and its original ending.
type Line = (String, String);
/// A line range and the lines that replace it.
type LineEdit = (usize, usize, Vec<Line>);

/// One line split into its content and its original ending.
fn split_line(line: &str) -> (&str, &str) {
    if let Some(content) = line.strip_suffix("\r\n") {
        (content, "\r\n")
    } else if let Some(content) = line.strip_suffix('\n') {
        (content, "\n")
    } else {
        (line, "")
    }
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

fn render_scalar(value: &serde_yaml::Value) -> Option<String> {
    serde_yaml::to_string(value).ok().map(|text| text.trim_end_matches(['\r', '\n']).to_owned())
}

/// The line of `field:` at `indent`, if it appears exactly once.
fn field_line(lines: &[Line], field: &str, indent: usize) -> Option<usize> {
    let mut found = None;
    for (index, (content, _)) in lines.iter().enumerate() {
        let trimmed = content.trim_start();
        if indent_of(content) == indent && trimmed.strip_prefix(field).is_some_and(|rest| rest.starts_with(':')) {
            if found.is_some() {
                return None;
            }
            found = Some(index);
        }
    }
    found
}

/// The lines after an `args:` key that belong to it.
fn args_end(lines: &[Line], at: usize, indent: usize) -> usize {
    let mut end = at + 1;
    while end < lines.len() {
        let (content, _) = &lines[end];
        let trimmed = content.trim_start();
        let depth = indent_of(content);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            break;
        }
        if depth > indent || (depth == indent && trimmed.starts_with("- ")) {
            end += 1;
        } else {
            break;
        }
    }
    end
}

/// Sets browse's config fields by editing only their lines, so tags (`!!js`), merge keys and comments elsewhere keep
/// their bytes. Returns None when the text is not the block shape browse writes.
fn rewrite_config(block: &str, current: &serde_yaml::Mapping, expected: &serde_yaml::Mapping, newline: &str) -> Option<String> {
    let mut lines: Vec<Line> = block
        .split_inclusive('\n')
        .map(|line| {
            let (content, ending) = split_line(line);
            (content.to_owned(), ending.to_owned())
        })
        .collect();
    let configs: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, (content, _))| {
            let trimmed = content.trim_start();
            indent_of(content) > 0 && (trimmed == "config:" || trimmed.starts_with("config: #"))
        })
        .map(|(index, _)| index)
        .collect();
    let config_at = *configs.first().filter(|_| configs.len() == 1)?;
    let config_indent = indent_of(&lines[config_at].0);
    let field_indent = lines
        .iter()
        .skip(config_at + 1)
        .filter(|(content, _)| !content.trim().is_empty() && !content.trim_start().starts_with('#'))
        .map(|(content, _)| indent_of(content))
        .filter(|indent| *indent > config_indent)
        .min()
        .unwrap_or(config_indent + 2);
    let pad = " ".repeat(field_indent);
    let args_value = |want: &serde_yaml::Value, ending: &str| -> Option<Vec<Line>> {
        match want {
            serde_yaml::Value::Sequence(items) if !items.is_empty() => {
                let text = serde_yaml::to_string(want).ok()?;
                let mut rendered = vec![(format!("{pad}args:"), ending.to_owned())];
                rendered.extend(text.lines().map(|line| (format!("{pad}{line}"), newline.to_owned())));
                Some(rendered)
            }
            _ => Some(vec![(format!("{pad}args: {}", render_scalar(want)?), ending.to_owned())]),
        }
    };
    let mut edits: Vec<LineEdit> = Vec::new();
    let mut missing: Vec<Line> = Vec::new();
    for field in FIELDS {
        let Some(want) = expected.get(field) else { continue };
        if current.get(field) == Some(want) {
            continue;
        }
        let Some(at) = field_line(&lines, field, field_indent) else {
            if field == "args" {
                missing.extend(args_value(want, newline)?);
            } else {
                missing.push((format!("{pad}{field}: {}", render_scalar(want)?), newline.to_owned()));
            }
            continue;
        };
        let ending = if lines[at].1.is_empty() { newline.to_owned() } else { lines[at].1.clone() };
        if field == "args" {
            edits.push((at, args_end(&lines, at, field_indent), args_value(want, &ending)?));
        } else {
            let value = lines[at].0.trim_start().strip_prefix(field)?.strip_prefix(':')?.trim();
            if value.is_empty() || value.starts_with('#') {
                return None;
            }
            edits.push((at, at + 1, vec![(format!("{pad}{field}: {}", render_scalar(want)?), ending)]));
        }
    }
    if !missing.is_empty() {
        edits.push((config_at + 1, config_at + 1, missing));
    }
    edits.sort_by_key(|(start, end, _)| (*start, *end));
    for (start, end, replacement) in edits.into_iter().rev() {
        lines.splice(start..end, replacement);
    }
    Some(lines.into_iter().map(|(content, ending)| content + &ending).collect())
}

/// Our row with the merged config, keeping every other row key (`disabled`, an id the user renamed, ...).
fn updated_row(node: &serde_yaml::Mapping, config: serde_yaml::Mapping) -> serde_yaml::Value {
    let mut row = node.clone();
    row.insert("name".into(), CLIENT.into());
    row.insert("config".into(), serde_yaml::Value::Mapping(config));
    serde_yaml::Value::Mapping(row)
}

/// A value as block text at `indent` columns, so it can replace or follow a file's lines without touching earlier ones.
fn render_at(value: &serde_yaml::Value, indent: usize, crlf: bool) -> anyhow::Result<String> {
    let text = serde_yaml::to_string(value)?;
    let newline = if crlf { "\r\n" } else { "\n" };
    let mut out = String::new();
    for (index, line) in text.lines().enumerate() {
        if index == 0 {
            out.push_str(&" ".repeat(indent));
            out.push_str("- ");
        } else {
            out.push_str(newline);
            out.push_str(&" ".repeat(indent + 2));
        }
        out.push_str(line);
    }
    out.push_str(newline);
    Ok(out)
}

/// The item as block text at column 0.
fn render(row: serde_yaml::Value, crlf: bool) -> anyhow::Result<String> {
    render_at(&patch(row)?, 0, crlf)
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

/// Where an item's own lines end: its last content line before `limit`, leaving trailing blanks and comments in place.
fn item_end(spans: &[(usize, usize, &str)], start: usize, limit: usize) -> usize {
    spans[start..limit].iter().rposition(|(_, _, line)| content(line)).map_or(spans[start].1, |index| spans[start + index].1)
}

/// The nested block-sequence entries of an `insert` list: dashes at the shallowest indentation below the item.
fn row_lines(spans: &[(usize, usize, &str)], start: usize, limit: usize) -> Vec<usize> {
    let mut indent = usize::MAX;
    let mut rows = Vec::new();
    for (index, (_, _, line)) in spans.iter().enumerate().take(limit).skip(start + 1) {
        if !content(line) {
            continue;
        }
        let depth = line.len() - line.trim_start_matches(' ').len();
        let trimmed = line.trim_start();
        if depth == 0 || (trimmed != "-" && !trimmed.starts_with("- ")) {
            continue;
        }
        if depth < indent {
            indent = depth;
            rows.clear();
        }
        if depth == indent {
            rows.push(index);
        }
    }
    rows
}

/// Whether a line holds only an empty layer value: `[]`, or a YAML null (`~`, `null`), with an optional inline comment.
fn empty_value(line: &str) -> bool {
    let value = line.split('#').next().unwrap_or_default().trim();
    value == "[]" || value == "~" || value == "null"
}

/// The single line of dsh's empty patch template, which may be surrounded by comments and a leading `---`.
fn empty_layer(text: &str) -> Option<(usize, usize)> {
    let mut lines = line_spans(text).into_iter().filter(|(_, _, line)| content(line) && line.trim() != "---");
    let only = lines.next()?;
    if !empty_value(only.2) || lines.next().is_some() {
        return None;
    }
    Some((only.0, only.1))
}

fn verify(after: &str, wanted: &serde_yaml::Value) -> bool {
    serde_yaml::from_str::<serde_yaml::Value>(after).is_ok_and(|value| &value == wanted)
}

/// Adds browse's row, updates one an earlier install wrote, or with `remove` takes it out again. Returns the new text
/// when it changes, and the edit's outcome.
pub fn edit(before: &str, expected: &Value, remove: bool) -> anyhow::Result<(Option<String>, Edit)> {
    let invalid = || anyhow::anyhow!("isn't a dsh patch layer browse can edit safely; add the browse entry by hand");
    let blank = before.trim().is_empty();
    let empty_at = if blank { None } else { empty_layer(before) };
    if !blank && empty_at.is_none() && first_content(before).is_some_and(|line| line.starts_with('[')) {
        return Err(invalid());
    }
    let parsed = if blank || empty_at.is_some() { serde_yaml::Value::Sequence(Vec::new()) } else { serde_yaml::from_str(before).map_err(|_| invalid())? };
    // A comments-only or `---`-only file has no document value; the first item is appended after those lines.
    let null = matches!(parsed, serde_yaml::Value::Null);
    let items: Vec<serde_yaml::Value> = if null { Vec::new() } else { patches(&parsed).ok_or_else(invalid)?.clone() };
    if id_taken(&items) {
        return Ok((None, Edit::IdTaken));
    }
    let found = owners(&items);
    if found.len() > 1 {
        return Ok((None, Edit::Conflict));
    }
    let expected_yaml = serde_yaml::to_value(expected)?;
    let expected_map = expected_yaml.as_mapping().ok_or_else(invalid)?;
    let crlf = before.contains("\r\n");
    let newline = if crlf { "\r\n" } else { "\n" };
    let Some(owner) = found.first() else {
        if remove {
            return Ok((None, Edit::Unchanged));
        }
        let fresh = row(expected)?;
        let after = if blank {
            render(fresh.clone(), crlf)?
        } else if let Some((start, end)) = empty_at {
            // Keep an inline comment on the replaced line, on a line of its own.
            let line = before[start..end].trim_end_matches(['\r', '\n']);
            let comment = line.find('#').map(|at| format!("{}{}{}", &line[..line.len() - line.trim_start().len()], &line[at..], newline));
            format!("{}{}{}{}", &before[..start], comment.unwrap_or_default(), render(fresh.clone(), crlf)?, &before[end..])
        } else if before.ends_with('\n') {
            format!("{before}{}", render(fresh.clone(), crlf)?)
        } else {
            format!("{before}{newline}{}", render(fresh.clone(), crlf)?)
        };
        let mut wanted = items.clone();
        wanted.push(patch(fresh)?);
        if !verify(&after, &serde_yaml::Value::Sequence(wanted)) {
            return Err(invalid());
        }
        return Ok((Some(after), Edit::Added));
    };
    let Ok(current) = serde_json::to_value(owner.config) else { return Ok((None, Edit::Conflict)) };
    if !current.is_object() || !owned(&current) {
        return Ok((None, Edit::Conflict));
    }
    // Browse's own fields decide whether there is anything to do; the user's other config keys are never compared.
    if !remove && same_fields(owner.config, expected_map) {
        return Ok((None, Edit::Unchanged));
    }
    let spans = line_spans(before);
    let entries = entry_lines(&spans);
    if entries.len() != items.len() {
        return Err(invalid());
    }
    let item_line = entries[owner.item];
    let next_line = entries.get(owner.item + 1).copied().unwrap_or(spans.len());
    let item_stop = item_end(&spans, item_line, next_line);
    if remove {
        let mut wanted = items.clone();
        let after = if owner.whole {
            wanted.remove(owner.item);
            if wanted.is_empty() {
                format!("{}[]{newline}{}", &before[..spans[item_line].0], &before[item_stop..])
            } else {
                format!("{}{}", &before[..spans[item_line].0], &before[item_stop..])
            }
        } else {
            // A row inside the user's insert patch: cut just its lines, keeping the rest of their patch.
            let Some(serde_yaml::Value::Mapping(map)) = items.get(owner.item) else { return Ok((None, Edit::Conflict)) };
            let Some(serde_yaml::Value::Sequence(rows)) = map.get("insert") else { return Ok((None, Edit::Conflict)) };
            if map.len() != 1 || rows.len() <= 1 {
                return Ok((None, Edit::Conflict));
            }
            let cuts = row_lines(&spans, item_line, next_line);
            if cuts.len() != rows.len() {
                return Ok((None, Edit::Conflict));
            }
            let start = spans[cuts[owner.row]].0;
            let end = item_end(&spans, cuts[owner.row], cuts.get(owner.row + 1).copied().unwrap_or(next_line));
            if let Some(serde_yaml::Value::Sequence(rows)) = wanted[owner.item].get_mut("insert") {
                rows.remove(owner.row);
            }
            format!("{}{}", &before[..start], &before[end..])
        };
        if !verify(&after, &serde_yaml::Value::Sequence(wanted)) {
            return Err(invalid());
        }
        return Ok((Some(after), Edit::Removed));
    }
    let updated = updated_row(owner.node, merged_config(owner.config, expected_map));
    let mut wanted = items.clone();
    let after = if owner.whole {
        wanted[owner.item] = patch(updated)?;
        let start = spans[item_line].0;
        let Some(rewritten) = rewrite_config(&before[start..item_stop], owner.config, expected_map, newline) else {
            return Ok((None, Edit::Conflict));
        };
        format!("{}{}{}", &before[..start], rewritten, &before[item_stop..])
    } else {
        // The user's patch stays; replace just our row's field lines inside their insert list.
        let Some(serde_yaml::Value::Mapping(map)) = items.get(owner.item) else { return Ok((None, Edit::Conflict)) };
        let Some(serde_yaml::Value::Sequence(rows)) = map.get("insert") else { return Ok((None, Edit::Conflict)) };
        if map.len() != 1 || rows.len() <= 1 {
            return Ok((None, Edit::Conflict));
        }
        let cuts = row_lines(&spans, item_line, next_line);
        if cuts.len() != rows.len() {
            return Ok((None, Edit::Conflict));
        }
        let start = spans[cuts[owner.row]].0;
        let end = item_end(&spans, cuts[owner.row], cuts.get(owner.row + 1).copied().unwrap_or(next_line));
        let Some(rewritten) = rewrite_config(&before[start..end], owner.config, expected_map, newline) else {
            return Ok((None, Edit::Conflict));
        };
        if let Some(serde_yaml::Value::Sequence(rows)) = wanted[owner.item].get_mut("insert") {
            rows[owner.row] = updated;
        }
        format!("{}{}{}", &before[..start], rewritten, &before[end..])
    };
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

    fn installed(command: &str, crlf: bool) -> String {
        render(row(&config(command)).unwrap(), crlf).unwrap()
    }

    fn rows(text: &str) -> Vec<serde_yaml::Value> {
        let parsed: serde_yaml::Value = serde_yaml::from_str(text).unwrap();
        patches(&parsed).unwrap().clone()
    }

    #[test]
    fn renders_a_block_item_at_column_zero() {
        let text = installed("/bin/browse", false);
        assert!(text.starts_with("- insert:\n"), "{text}");
        assert!(text.ends_with('\n'));
        assert_eq!(rows(&text)[0]["insert"][0]["id"].as_str(), Some(ROW_ID));
        assert_eq!(rows(&text)[0]["insert"][0]["config"]["command"].as_str(), Some("/bin/browse"));
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
    fn reinstall_keeps_extra_config_and_row_keys() {
        let before = "- insert:\n  - id: mcp-browse\n    name: '@deepseek-ai/dsh-mcp-client'\n    disabled: true\n    config:\n      serverName: browse\n      transport: stdio\n      command: /bin/browse\n      args:\n      - mcp\n      env:\n        A: '1'\n      toolCallTimeoutMs: 60000\n";
        // Same command: nothing to do, not even a rewrite (the user's extras are already there).
        assert_eq!(edit(before, &config("/bin/browse"), false).unwrap(), (None, Edit::Unchanged));
        assert_eq!(edit(before, &config("/bin/browse"), false).unwrap().0, None);
        // A moved binary updates the command and keeps everything else on the row and in its config.
        let (after, outcome) = edit(before, &config("/usr/bin/browse"), false).unwrap();
        assert_eq!(outcome, Edit::Updated);
        let after = after.unwrap();
        let item = &rows(&after)[0]["insert"][0];
        assert_eq!(item["id"].as_str(), Some("mcp-browse"));
        assert_eq!(item["disabled"].as_bool(), Some(true));
        assert_eq!(item["config"]["env"]["A"].as_str(), Some("1"));
        assert_eq!(item["config"]["toolCallTimeoutMs"].as_u64(), Some(60000));
        assert_eq!(item["config"]["command"].as_str(), Some("/usr/bin/browse"));
    }

    #[test]
    fn a_row_in_a_user_patch_is_updated_and_removed() {
        let before = "- insert:\n  - id: other\n    name: other\n  - id: mcp-browse\n    name: '@deepseek-ai/dsh-mcp-client'\n    config:\n      serverName: browse\n      transport: stdio\n      command: /bin/browse\n      args:\n      - mcp\n      env:\n        A: '1'\n";
        // A changed command updates just our row inside the user's insert, keeping their row and our extras.
        let (updated, outcome) = edit(before, &config("/usr/bin/browse"), false).unwrap();
        assert_eq!(outcome, Edit::Updated);
        let updated = updated.unwrap();
        let items = rows(&updated);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["insert"].as_sequence().unwrap().len(), 2);
        assert_eq!(items[0]["insert"][0]["id"].as_str(), Some("other"));
        assert_eq!(items[0]["insert"][1]["config"]["command"].as_str(), Some("/usr/bin/browse"));
        assert_eq!(items[0]["insert"][1]["config"]["env"]["A"].as_str(), Some("1"));
        let (after, outcome) = edit(before, &config("/bin/browse"), true).unwrap();
        assert_eq!(outcome, Edit::Removed);
        assert_eq!(rows(&after.unwrap()), rows("- insert:\n  - id: other\n    name: other\n"));
        // Our row first in the shared insert goes too, the row after it stays, and a later patch is untouched.
        let first = "- insert:\n  - id: mcp-browse\n    name: '@deepseek-ai/dsh-mcp-client'\n    config:\n      serverName: browse\n      transport: stdio\n      command: /bin/browse\n      args:\n      - mcp\n  - id: other\n    name: other\n# keep the last\n- insert:\n  - id: last\n    name: last\n";
        let (after, outcome) = edit(first, &config("/bin/browse"), true).unwrap();
        assert_eq!(outcome, Edit::Removed);
        let after = after.unwrap();
        assert!(after.contains("# keep the last"), "{after}");
        let items = rows(&after);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0], rows("- insert:\n  - id: other\n    name: other\n")[0]);
        assert_eq!(items[1]["insert"][0]["id"].as_str(), Some("last"));
    }

    #[test]
    fn a_patch_with_other_keys_is_left_alone() {
        // The insert holds only our row but the patch has another key: removing the row would leave a shape browse
        // cannot verify, so it stays.
        let before = "- insert:\n  - id: mcp-browse\n    name: '@deepseek-ai/dsh-mcp-client'\n    config:\n      serverName: browse\n      transport: stdio\n      command: /bin/browse\n      args:\n      - mcp\n  when: x\n";
        assert_eq!(edit(before, &config("/bin/browse"), true).unwrap(), (None, Edit::Conflict));
        assert_eq!(edit(before, &config("/usr/bin/browse"), false).unwrap(), (None, Edit::Conflict));
    }

    #[test]
    fn an_update_keeps_js_tags_in_the_config() {
        let before = "- insert:\n  - id: mcp-browse\n    name: '@deepseek-ai/dsh-mcp-client'\n    config:\n      serverName: browse\n      transport: stdio\n      command: /bin/browse\n      args:\n      - mcp\n      env:\n        TOKEN: !!js process.env.TOKEN\n";
        let (after, outcome) = edit(before, &config("/usr/bin/browse"), false).unwrap();
        assert_eq!(outcome, Edit::Updated);
        let after = after.unwrap();
        // serde_yaml flattens standard tags, so the tag can only be checked in the text; the value it wraps is unchanged.
        assert!(after.contains("TOKEN: !!js process.env.TOKEN"), "{after}");
        let item = &rows(&after)[0]["insert"][0];
        assert_eq!(item["config"]["env"]["TOKEN"].as_str(), Some("process.env.TOKEN"));
        assert_eq!(item["config"]["command"].as_str(), Some("/usr/bin/browse"));
    }

    #[test]
    fn an_update_keeps_a_merge_key() {
        let before = "- insert:\n  - id: other\n    name: other\n    config:\n      base: &b\n        TOKEN: x\n- insert:\n  - id: mcp-browse\n    name: '@deepseek-ai/dsh-mcp-client'\n    config:\n      serverName: browse\n      transport: stdio\n      command: /bin/browse\n      args:\n      - mcp\n      env:\n        <<: *b\n";
        assert_eq!(edit(before, &config("/bin/browse"), false).unwrap(), (None, Edit::Unchanged));
        let (after, outcome) = edit(before, &config("/usr/bin/browse"), false).unwrap();
        assert_eq!(outcome, Edit::Updated);
        let after = after.unwrap();
        assert!(after.contains("<<: *b"), "{after}");
        let items = rows(&after);
        assert_eq!(items.len(), 2);
        assert_eq!(items[1]["insert"][0]["config"]["env"]["<<"]
            .as_mapping()
            .and_then(|map| map.get("TOKEN"))
            .and_then(serde_yaml::Value::as_str), Some("x"));
        assert_eq!(items[1]["insert"][0]["config"]["command"].as_str(), Some("/usr/bin/browse"));
    }

    #[test]
    fn an_item_in_the_middle_is_updated_and_removed() {
        let before = format!("- insert:\n  - id: other\n    name: other\n{}# about the last\n- insert:\n  - id: last\n    name: last\n", installed("/bin/browse", false));
        assert_eq!(edit(&before, &config("/bin/browse"), false).unwrap(), (None, Edit::Unchanged));
        let (updated, outcome) = edit(&before, &config("/usr/bin/browse"), false).unwrap();
        assert_eq!(outcome, Edit::Updated);
        let updated = updated.unwrap();
        assert!(updated.contains("# about the last"), "{updated}");
        let items = rows(&updated);
        assert_eq!(items.len(), 3);
        assert_eq!(items[1]["insert"][0]["config"]["command"].as_str(), Some("/usr/bin/browse"));
        assert_eq!(items[2]["insert"][0]["id"].as_str(), Some("last"));
        let (removed, outcome) = edit(&before, &config("/bin/browse"), true).unwrap();
        assert_eq!(outcome, Edit::Removed);
        let removed = removed.unwrap();
        assert!(removed.contains("# about the last"), "{removed}");
        assert_eq!(rows(&removed).len(), 2);
        assert_eq!(rows(&removed)[1]["insert"][0]["id"].as_str(), Some("last"));
    }

    #[test]
    fn the_only_item_is_replaced_by_an_empty_list_in_place() {
        let before = format!("# before\n{}# after\n", installed("/bin/browse", false));
        let (after, outcome) = edit(&before, &config("/bin/browse"), true).unwrap();
        assert_eq!(outcome, Edit::Removed);
        let after = after.unwrap();
        assert_eq!(after, "# before\n[]\n# after\n");
        assert!(rows(&after).is_empty());
    }

    #[test]
    fn the_empty_layer_template_is_replaced_and_restored() {
        let before = "# dsh profile patches\n# add rows below\n[]\n# end\n";
        let (added, outcome) = edit(before, &config("/bin/browse"), false).unwrap();
        assert_eq!(outcome, Edit::Added);
        let added = added.unwrap();
        assert!(added.starts_with("# dsh profile patches\n# add rows below\n- insert:"), "{added}");
        assert!(added.ends_with("# end\n"), "{added}");
        assert_eq!(rows(&added).len(), 1);
        let (removed, outcome) = edit(&added, &config("/bin/browse"), true).unwrap();
        assert_eq!(outcome, Edit::Removed);
        assert_eq!(removed.unwrap(), before);
    }

    #[test]
    fn crlf_files_keep_crlf() {
        let before = "- insert:\r\n  - id: other\r\n    name: other\r\n";
        let (added, outcome) = edit(before, &config("/bin/browse"), false).unwrap();
        assert_eq!(outcome, Edit::Added);
        let added = added.unwrap();
        assert!(!added.replace("\r\n", "").contains('\n'), "lone LF in {added:?}");
        assert_eq!(edit(&added, &config("/bin/browse"), false).unwrap(), (None, Edit::Unchanged));
        let (removed, outcome) = edit(&added, &config("/bin/browse"), true).unwrap();
        assert_eq!(outcome, Edit::Removed);
        assert_eq!(removed.unwrap(), before);
    }

    #[test]
    fn the_row_id_is_ours_or_a_conflict() {
        let other = "- insert:\n  - id: mcp-browse\n    name: other\n";
        assert_eq!(edit(other, &config("/bin/browse"), false).unwrap(), (None, Edit::IdTaken));
        let wrong_server = "- insert:\n  - id: mcp-browse\n    name: '@deepseek-ai/dsh-mcp-client'\n    config:\n      serverName: other\n";
        assert_eq!(edit(wrong_server, &config("/bin/browse"), false).unwrap(), (None, Edit::IdTaken));
    }

    #[test]
    fn empty_templates_and_null_documents_are_accepted() {
        let before = "# dsh\n# template\n[] # the empty layer\n# end\n";
        let (added, outcome) = edit(before, &config("/bin/browse"), false).unwrap();
        assert_eq!(outcome, Edit::Added);
        let added = added.unwrap();
        assert!(added.starts_with("# dsh\n# template\n# the empty layer\n- insert:"), "{added}");
        assert!(added.ends_with("# end\n"), "{added}");
        let (removed, outcome) = edit(&added, &config("/bin/browse"), true).unwrap();
        assert_eq!(outcome, Edit::Removed);
        assert_eq!(removed.unwrap(), "# dsh\n# template\n# the empty layer\n[]\n# end\n");

        // A leading `---` and a null value are accepted too.
        let document = "---\n# mine\n~\n";
        let (added, outcome) = edit(document, &config("/bin/browse"), false).unwrap();
        assert_eq!(outcome, Edit::Added);
        assert!(added.unwrap().starts_with("---\n# mine\n- insert:"));

        // Comments-only and `---`-only files get the item appended after their lines.
        for text in ["# only comments\n", "---\n"] {
            let (added, outcome) = edit(text, &config("/bin/browse"), false).unwrap();
            assert_eq!(outcome, Edit::Added);
            let added = added.unwrap();
            assert!(added.starts_with(text), "{added:?} did not start with {text:?}");
            assert_eq!(rows(&added).len(), 1);
        }
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
