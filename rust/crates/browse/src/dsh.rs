//! The dsh agent's user patch layer: a top-level YAML list of Cordis patch operations. browse is one
//! `@deepseek-ai/dsh-mcp-client` row, so this module splices that row's lines instead of rewriting the file.

use std::path::{Path, PathBuf};

use anyhow::bail;
use serde_json::Value;

use crate::agents::{block_end, content, decide, indent_of, owned, Edit, Location};

/// The dsh MCP plugin whose rows run browse.
const CLIENT: &str = "@deepseek-ai/dsh-mcp-client";
/// The config keys a browse row always has.
const KEYS: [&str; 4] = ["serverName", "transport", "command", "args"];

/// dsh's home: `$DSH_HOME` unless it is blank, else `~/.dsh` (dsh-home-paths).
pub(crate) fn home(value: Option<std::ffi::OsString>, home: &Path) -> PathBuf {
    value.filter(|value| !value.to_string_lossy().trim().is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".dsh"))
}

/// dsh's user patch layer. Debian's unrelated `dsh` (distributed shell) also has a `dsh` binary and `~/.dsh`, so only
/// dsh's own files count as installed.
pub(crate) fn location(home: PathBuf) -> Location {
    let file = home.join("cordis.patch.yml");
    let installed = home.join("profiles").exists() || file.exists();
    Location { name: "dsh", file, installed }
}

/// A patch file's rows, or None when YAML has no list at all (a comment-only or `--- # c` file).
fn sequence(text: &str) -> anyhow::Result<Option<Vec<serde_yaml::Value>>> {
    let value: serde_yaml::Value = serde_yaml::from_str(text.strip_prefix('\u{feff}').unwrap_or(text))?;
    match value {
        serde_yaml::Value::Null => Ok(None),
        serde_yaml::Value::Sequence(rows) if rows.iter().all(serde_yaml::Value::is_mapping) => Ok(Some(rows)),
        _ => bail!("not a top-level YAML list of patch entries"),
    }
}

/// A dsh patch file's rows: a top-level YAML list of patch entries, where an empty, BOM-only or comment-only file is
/// an empty list.
fn patch_list(text: &str) -> anyhow::Result<Vec<serde_yaml::Value>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    Ok(sequence(text)?.unwrap_or_default())
}

/// Whether an inserted dsh row is named browse: our id, or the `serverName` its tools are named after.
fn named(row: &serde_yaml::Value) -> bool {
    row.get("id").and_then(serde_yaml::Value::as_str) == Some("browse")
        || row.get("config").and_then(|config| config.get("serverName")).and_then(serde_yaml::Value::as_str) == Some("browse")
}

/// Whether a row is one browse wrote: our plugin name, and browse's id or serverName.
fn ours(row: &serde_yaml::Value) -> bool {
    row.get("name").and_then(serde_yaml::Value::as_str) == Some(CLIENT) && named(row)
}

/// Whether a `serverName` is set to browse anywhere, including rows nested too deeply for the finder.
fn mentions_browse(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.strip_prefix('\u{feff}').unwrap_or(line);
        if line.trim_start().starts_with('#') {
            return false;
        }
        line.split_once("serverName").is_some_and(|(_, rest)| {
            let rest = rest.trim_start();
            let rest = rest.strip_prefix(':').unwrap_or(rest).trim_start();
            let value = rest.split(['}', ']', ',', '#', ' ']).next().unwrap_or_default();
            value.trim_matches(['\'', '"']) == "browse"
        })
    })
}

/// The patch and inserted row that configure browse, if the file has one.
fn find(patches: &[serde_yaml::Value]) -> anyhow::Result<Option<(usize, usize)>> {
    let mut found = None;
    for (patch, entry) in patches.iter().enumerate() {
        for (row, inserted) in entry.get("insert").and_then(serde_yaml::Value::as_sequence).into_iter().flatten().enumerate() {
            if named(inserted) {
                if found.is_some() {
                    bail!("has more than one browse server");
                }
                found = Some((patch, row));
            }
        }
    }
    Ok(found)
}

/// The lines of the inserted browse row: a nested `- ` item under an `insert:` patch.
fn span(lines: &[&str]) -> anyhow::Result<(usize, usize)> {
    let mut found = Vec::new();
    for (start, line) in lines.iter().enumerate() {
        let indent = indent_of(line);
        if indent == 0 || !line.trim_start().starts_with("- ") {
            continue;
        }
        let end = block_end(lines, start, indent);
        let block: Vec<&str> = lines[start..end].iter().map(|line| line.get(indent..).unwrap_or_default()).collect();
        if let Ok(serde_yaml::Value::Sequence(rows)) = serde_yaml::from_str::<serde_yaml::Value>(&block.join("\n"))
            && rows.len() == 1
            && named(&rows[0])
        {
            found.push((start, end));
        }
    }
    match found.as_slice() {
        [span] => Ok(*span),
        [] => bail!("has no browse row browse can find"),
        _ => bail!("has more than one browse row"),
    }
}

/// The top-level patch item that holds the browse row, if its block has an `insert:` key.
fn parent(lines: &[&str], start: usize) -> anyhow::Result<(usize, usize)> {
    let mut at = start;
    while at > 0 {
        at -= 1;
        if !content(lines[at]) || indent_of(lines[at]) != 0 {
            continue;
        }
        if !lines[at].trim_start().starts_with("- ") {
            continue;
        }
        let end = block_end(lines, at, 0);
        if key_of(lines[at]) == Some("insert") || (at + 1..end).any(|line| content(lines[line]) && key_of(lines[line]) == Some("insert")) {
            return Ok((at, end));
        }
        bail!("can't find the insert patch around the browse row");
    }
    bail!("can't find the insert patch around the browse row")
}

/// The file's lines without terminators, its newline style, whether it ended with one, and whether it had a BOM.
fn file_lines(text: &str) -> (Vec<String>, &'static str, bool, bool) {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let trailing = text.ends_with('\n');
    let (text, bom) = text.strip_prefix('\u{feff}').map_or((text, false), |text| (text, true));
    let mut lines: Vec<String> = text.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line).to_owned()).collect();
    if text.is_empty() {
        lines.clear();
    } else if trailing {
        lines.pop();
    }
    (lines, newline, trailing, bom)
}

fn join_lines(lines: &[String], newline: &str, trailing: bool, bom: bool) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    if bom {
        out.push('\u{feff}');
    }
    out.push_str(&lines.join(newline));
    if trailing {
        out.push_str(newline);
    }
    out
}

/// One YAML value on one line.
fn yaml_scalar(value: &serde_yaml::Value) -> String {
    serde_yaml::to_string(value).unwrap_or_default().trim_end_matches('\n').to_owned()
}

fn yaml_flow(value: &serde_yaml::Value) -> String {
    match value {
        serde_yaml::Value::Sequence(items) => format!("[{}]", items.iter().map(yaml_scalar).collect::<Vec<_>>().join(", ")),
        value => yaml_scalar(value),
    }
}

/// A new browse row, with only the config keys browse sets.
fn new_row(expected: &Value) -> anyhow::Result<serde_yaml::Value> {
    let mut config = serde_yaml::Mapping::new();
    for key in KEYS {
        config.insert(key.into(), serde_yaml::to_value(expected.get(key).unwrap_or(&Value::Null))?);
    }
    let mut row = serde_yaml::Mapping::new();
    row.insert("id".into(), "browse".into());
    row.insert("name".into(), CLIENT.into());
    row.insert("config".into(), serde_yaml::Value::Mapping(config));
    Ok(serde_yaml::Value::Mapping(row))
}

/// The new row's lines at `indent`, in dsh's MCP example shape.
fn row_lines(expected: &Value, indent: usize) -> Vec<String> {
    let pad = " ".repeat(indent);
    let name = yaml_scalar(&serde_yaml::Value::String(CLIENT.to_owned()));
    let mut lines = vec![format!("{pad}- id: browse"), format!("{pad}  name: {name}"), format!("{pad}  config:")];
    for key in KEYS {
        let value = serde_yaml::to_value(expected.get(key).unwrap_or(&Value::Null)).unwrap_or(serde_yaml::Value::Null);
        lines.push(format!("{pad}    {key}: {}", yaml_flow(&value)));
    }
    lines
}

/// Appends a patch as text. A blank separator marks a file that ended with a newline, so removal can restore the exact
/// bytes; an explicit `[]` (which can't be followed by block rows) is dropped first.
fn append(before: &str, block: &[String], empty: bool) -> String {
    let (mut lines, newline, trailing, bom) = file_lines(before);
    if empty && let Some(at) = lines.iter().position(|line| line.trim() == "[]") {
        lines.remove(at);
    }
    let trailing = trailing && !lines.is_empty();
    let mut out = lines;
    if trailing {
        out.push(String::new());
    }
    out.extend(block.iter().cloned());
    join_lines(&out, newline, true, bom)
}

/// dsh only boots when its patch layer is a list: a file that only has comments or a `--- # c` header gets an empty
/// `[]` list.
fn valid_empty(text: String, newline: &str) -> String {
    let mut out = text;
    if !out.ends_with('\n') {
        out.push_str(newline);
    }
    out.push_str("[]");
    out.push_str(newline);
    out
}

/// A line's mapping key, allowing the `- ` of the row's first item.
fn key_of(line: &str) -> Option<&str> {
    let line = line.trim_start();
    let line = line.strip_prefix("- ").unwrap_or(line);
    line.split_once(':').map(|(key, _)| key.trim())
}

/// The row's `config:` line, which must be a block mapping.
fn config_line(lines: &[&str], start: usize, end: usize) -> Option<usize> {
    let indent = indent_of(lines[start]) + 2;
    let mut found = None;
    for (at, line) in lines.iter().enumerate().take(end).skip(start) {
        let key_indent = if at == start { indent_of(line) + 2 } else { indent_of(line) };
        if key_indent != indent || key_of(line) != Some("config") {
            continue;
        }
        if found.is_some() {
            return None;
        }
        let line = line.trim_start();
        let line = line.strip_prefix("- ").unwrap_or(line);
        let rest = line.strip_prefix("config:")?.trim();
        if !rest.is_empty() && !rest.starts_with('#') {
            return None;
        }
        found = Some(at);
    }
    found
}

/// Whether a value has a `#` that YAML would read as the start of a comment.
fn has_comment(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else { return false };
    if first == '\'' || first == '"' {
        let mut chars = chars.peekable();
        while let Some(character) = chars.next() {
            if first == '\'' {
                if character == '\'' {
                    if chars.peek() == Some(&'\'') {
                        chars.next();
                        continue;
                    }
                    return chars.any(|character| !character.is_whitespace());
                }
            } else if character == '\\' {
                chars.next();
            } else if character == '"' {
                return chars.any(|character| !character.is_whitespace());
            }
        }
        return true;
    }
    let mut previous = ' ';
    for character in value.chars() {
        if character == '#' && previous.is_whitespace() {
            return true;
        }
        previous = character;
    }
    false
}

/// A config key's simple single-line `key: value` line, if it has exactly one and no comment or multi-line value.
fn value_line(lines: &[&str], config: usize, end: usize, key: &str) -> Option<usize> {
    let indent = (config + 1..end).find(|&at| content(lines[at])).map_or(indent_of(lines[config]) + 2, |at| indent_of(lines[at]));
    let mut found = None;
    for (at, line) in lines.iter().enumerate().take(end).skip(config + 1) {
        if indent_of(line) != indent || key_of(line) != Some(key) {
            continue;
        }
        if found.is_some() {
            return None;
        }
        let line = line.trim_start();
        let line = line.strip_prefix("- ").unwrap_or(line);
        let value = line.split_once(':')?.1.trim();
        if value.is_empty() || value.starts_with(['&', '*', '|', '>']) || has_comment(value) {
            return None;
        }
        if at + 1 < end && content(lines[at + 1]) && indent_of(lines[at + 1]) > indent {
            return None;
        }
        found = Some(at);
    }
    found
}

/// The config keys whose value differs from what browse runs.
fn changed(have: Option<&serde_yaml::Mapping>, expected: &Value) -> Vec<&'static str> {
    let want = serde_yaml::to_value(expected).ok();
    let want = want.as_ref().and_then(serde_yaml::Value::as_mapping);
    KEYS.iter().copied().filter(|key| have.and_then(|have| have.get(*key)) != want.and_then(|want| want.get(*key))).collect()
}

/// Adds, updates or removes browse's row in a dsh Cordis patch layer by splicing lines, then checks that the result
/// parses to exactly the old list with that one row changed.
pub(crate) fn write(before: &str, expected: &Value, remove: bool) -> anyhow::Result<(Option<String>, Edit)> {
    let invalid = || anyhow::anyhow!("isn't a dsh patch file browse can edit safely; add the browse entry by hand");
    let patches = patch_list(before).map_err(|_| invalid())?;
    let found = match find(&patches) {
        Ok(found) => found,
        Err(_) => return Ok((None, Edit::Conflict)),
    };
    let current = match found {
        None => {
            if mentions_browse(before) {
                return Ok((None, Edit::Conflict));
            }
            None
        }
        Some((patch, row)) => {
            let row = &patches[patch]["insert"][row];
            let config = row.get("config").and_then(|config| serde_json::to_value(config).ok());
            if !ours(row) || !config.as_ref().is_some_and(owned) {
                return Ok((None, Edit::Conflict));
            }
            config
        }
    };
    let (outcome, change) = decide(current.as_ref(), expected, remove);
    if change.is_none() {
        return Ok((None, outcome));
    }
    let (lines, newline, trailing, bom) = file_lines(before);
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let span = match found {
        Some(_) => match span(&refs) {
            Ok(span) => Some(span),
            Err(_) => return Ok((None, Edit::Conflict)),
        },
        None => None,
    };
    let (start, end) = span.unwrap_or((0, 0));
    let mut wanted = patches.clone();
    let after = if let Some((patch, row)) = found {
        if remove {
            let mut out = lines.clone();
            let only = patches[patch]["insert"].as_sequence().is_some_and(|insert| insert.len() == 1);
            let trailing = if only {
                let Ok((parent, parent_end)) = parent(&refs, start) else { return Ok((None, Edit::Conflict)) };
                let from = if parent > 0 && out[parent - 1].is_empty() { parent - 1 } else { parent };
                let trailing = if from < parent { true } else if parent_end == out.len() { false } else { trailing };
                out.drain(from..parent_end);
                wanted.remove(patch);
                trailing
            } else {
                out.drain(start..end);
                if let Some(insert) = wanted[patch]["insert"].as_sequence_mut() {
                    insert.remove(row);
                }
                trailing
            };
            join_lines(&out, newline, trailing, bom)
        } else {
            if refs[start..end].join("\n").contains('!') {
                return Ok((None, Edit::Conflict));
            }
            let have = patches[patch]["insert"][row].get("config").and_then(serde_yaml::Value::as_mapping);
            let changed = changed(have, expected);
            if changed.is_empty() {
                return Ok((None, Edit::Unchanged));
            }
            let want = serde_yaml::to_value(expected)?;
            let mut out = lines.clone();
            let Some(config_line) = config_line(&refs, start, end) else { return Ok((None, Edit::Conflict)) };
            let config_end = block_end(&refs, config_line, indent_of(refs[config_line])).min(end);
            for key in &changed {
                let Some(at) = value_line(&refs, config_line, config_end, key) else { return Ok((None, Edit::Conflict)) };
                let value = want.get(*key).cloned().unwrap_or(serde_yaml::Value::Null);
                let lead = &out[at][..out[at].len() - out[at].trim_start().len()];
                out[at] = format!("{lead}{key}: {}", yaml_flow(&value));
            }
            if let Some(config) = wanted[patch]["insert"][row].get_mut("config")
                && let Some(map) = config.as_mapping_mut()
            {
                for key in &changed {
                    map.insert((*key).into(), want.get(*key).cloned().unwrap_or(serde_yaml::Value::Null));
                }
            }
            join_lines(&out, newline, trailing, bom)
        }
    } else {
        let mut patch = serde_yaml::Mapping::new();
        patch.insert("insert".into(), serde_yaml::Value::Sequence(vec![new_row(expected)?]));
        wanted.push(serde_yaml::Value::Mapping(patch));
        let mut block = vec!["- insert:".to_owned()];
        block.extend(row_lines(expected, 4));
        append(before, &block, patches.is_empty())
    };
    let after = if wanted.is_empty() {
        let body = after.strip_prefix('\u{feff}').unwrap_or(&after);
        if body.trim().is_empty() {
            String::new()
        } else if sequence(&after).map_err(|_| invalid())?.is_none() {
            valid_empty(after, newline)
        } else {
            after
        }
    } else {
        after
    };
    if after.trim().is_empty() {
        if !wanted.is_empty() {
            return Err(invalid());
        }
    } else if sequence(&after).map_err(|_| invalid())?.as_deref() != Some(wanted.as_slice()) {
        return Err(invalid());
    }
    Ok((Some(after), outcome))
}

/// The browse server configured in a dsh patch layer, if it has one.
pub(crate) fn read(text: &str) -> Option<Value> {
    let patches = patch_list(text).ok()?;
    let (patch, row) = find(&patches).ok()??;
    let row = &patches[patch]["insert"][row];
    if !ours(row) {
        return None;
    }
    serde_json::to_value(row.get("config")?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{current, edit, Location};

    fn loc(name: &'static str, file: PathBuf) -> Location {
        Location { name, file, installed: true }
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("browse-agents-{name}-{}", crate::session::random_u64()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn command(entry: &str) -> Vec<String> {
        vec![entry.to_owned(), "mcp".to_owned()]
    }

    fn row(command: &str) -> String {
        format!("- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: {command}\n        args: [mcp]\n")
    }

    #[test]
    fn patch_file() {
        let dir = temp("dsh");
        let file = dir.join("dsh/cordis.patch.yml");
        let dsh = loc("dsh", file.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), row("/bin/browse"));
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Unchanged);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
        assert_eq!(current(&dsh).unwrap()["serverName"], "browse");
        assert!(owned(&current(&dsh).unwrap()));
        assert_eq!(edit(&dsh, &command("/usr/bin/browse"), false).unwrap(), Edit::Updated);
        assert_eq!(current(&dsh).unwrap()["command"], "/usr/bin/browse");
        // Settings the user added to our row stay across an update.
        let with_env = std::fs::read_to_string(&file).unwrap().replace("        args: [mcp]\n", "        args: [mcp]\n        env:\n          KEEP: '1'\n");
        std::fs::write(&file, &with_env).unwrap();
        assert_eq!(edit(&dsh, &command("/opt/browse"), false).unwrap(), Edit::Updated);
        let parsed = current(&dsh).unwrap();
        assert_eq!(parsed["command"], "/opt/browse");
        assert_eq!(parsed["env"]["KEEP"], "1");
        // A file that only had our row is removed: dsh treats a missing layer as no layer.
        assert_eq!(edit(&dsh, &command("/opt/browse"), true).unwrap(), Edit::Removed);
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn keeps_comments_and_tags_elsewhere() {
        let dir = temp("dsh-comments");
        let file = dir.join("cordis.patch.yml");
        let original = "# my dsh patches\n# keep every byte of this one\n- insert:\n    - id: memory\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: memory\n        transport: stdio\n        command: engram\n        args: [mcp]\n        cwd: !!js process.cwd()\n";
        std::fs::write(&file, original).unwrap();
        assert_eq!(patch_list(original).unwrap().len(), 1);
        let dsh = loc("dsh", file.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(text.strip_prefix(original).unwrap(), format!("\n{}", row("/bin/browse")));
        assert!(text.contains("        cwd: !!js process.cwd()\n"), "{text}");
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Unchanged);
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), original);
        // Removal doesn't care about tags in our own row: dropping lines is safe.
        let tagged = dir.join("tagged.yml");
        let original = "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse\n        args: [mcp]\n        cwd: !!js process.cwd()\n";
        std::fs::write(&tagged, original).unwrap();
        let dsh = loc("dsh", tagged.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert!(!tagged.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn empty_files() {
        let dir = temp("dsh-empty");
        // A missing file is created, then removed again.
        let missing = dir.join("missing/cordis.patch.yml");
        let dsh = loc("dsh", missing.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert!(current(&dsh).is_some());
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert!(!missing.exists());
        // So is an empty one.
        let empty = dir.join("empty/cordis.patch.yml");
        std::fs::create_dir_all(empty.parent().unwrap()).unwrap();
        std::fs::write(&empty, "").unwrap();
        let dsh = loc("dsh", empty.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert!(!empty.exists());
        // Leftover comments keep an empty list so dsh can still load the file.
        let comments = dir.join("comments/cordis.patch.yml");
        std::fs::create_dir_all(comments.parent().unwrap()).unwrap();
        std::fs::write(&comments, "# only comments\n").unwrap();
        let dsh = loc("dsh", comments.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        let text = std::fs::read_to_string(&comments).unwrap();
        assert_eq!(text, "# only comments\n[]\n");
        assert_eq!(patch_list(&text).unwrap().len(), 0);
        // Comments plus an explicit empty list come back exactly.
        let listed = dir.join("listed/cordis.patch.yml");
        std::fs::create_dir_all(listed.parent().unwrap()).unwrap();
        std::fs::write(&listed, "# mine\n[]\n").unwrap();
        let dsh = loc("dsh", listed.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&listed).unwrap(), "# mine\n[]\n");
        // An empty list with nothing else is replaced, then the file is removed.
        let only = dir.join("only/cordis.patch.yml");
        std::fs::create_dir_all(only.parent().unwrap()).unwrap();
        std::fs::write(&only, "[]\n").unwrap();
        let dsh = loc("dsh", only.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert!(!only.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn document_header() {
        let dir = temp("dsh-header");
        // `--- # c` plus an empty list round-trips exactly.
        let listed = dir.join("listed/cordis.patch.yml");
        std::fs::create_dir_all(listed.parent().unwrap()).unwrap();
        let original = "--- # c\n[]\n";
        std::fs::write(&listed, original).unwrap();
        let dsh = loc("dsh", listed.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&listed).unwrap(), original);
        assert_eq!(patch_list(&std::fs::read_to_string(&listed).unwrap()).unwrap().len(), 0);
        // `--- # c` plus our row uninstalls to a loadable empty list.
        let named = dir.join("row/cordis.patch.yml");
        std::fs::create_dir_all(named.parent().unwrap()).unwrap();
        std::fs::write(&named, format!("--- # c\n{}", row("/bin/browse"))).unwrap();
        let dsh = loc("dsh", named.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        let text = std::fs::read_to_string(&named).unwrap();
        assert_eq!(text, "--- # c\n[]\n");
        assert_eq!(sequence(&text).unwrap().map(|rows| rows.len()), Some(0));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bom_files() {
        let dir = temp("dsh-bom");
        // A BOM survives, and a comment-only file still gets an empty list.
        let comment = dir.join("comment/cordis.patch.yml");
        std::fs::create_dir_all(comment.parent().unwrap()).unwrap();
        std::fs::write(&comment, "\u{feff}# c\n").unwrap();
        let dsh = loc("dsh", comment.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert!(std::fs::read_to_string(&comment).unwrap().starts_with("\u{feff}# c\n"), "{:?}", std::fs::read_to_string(&comment).unwrap());
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        let text = std::fs::read_to_string(&comment).unwrap();
        assert_eq!(text, "\u{feff}# c\n[]\n");
        assert_eq!(patch_list(&text).unwrap().len(), 0);
        // A file that is only a BOM is removed.
        let only = dir.join("only/cordis.patch.yml");
        std::fs::create_dir_all(only.parent().unwrap()).unwrap();
        std::fs::write(&only, "\u{feff}").unwrap();
        let dsh = loc("dsh", only.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert!(std::fs::read_to_string(&only).unwrap().starts_with('\u{feff}'));
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert!(!only.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn update_edits_only_config_values() {
        let dir = temp("dsh-update");
        let file = dir.join("cordis.patch.yml");
        let original = "# top\n- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      # row comment\n      disabled: true\n      note: keep me\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse\n        args: [mcp]\n        env:\n          A: '1'\n";
        std::fs::write(&file, original).unwrap();
        let dsh = loc("dsh", file.clone());
        assert_eq!(edit(&dsh, &command("/usr/bin/browse"), false).unwrap(), Edit::Updated);
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(text, original.replace("command: /bin/browse", "command: /usr/bin/browse"));
        let before: Vec<&str> = original.lines().collect();
        let after: Vec<&str> = text.lines().collect();
        assert_eq!(after.len(), before.len());
        assert_eq!(before.iter().zip(&after).filter(|(before, after)| before != after).count(), 1);
        assert_eq!(current(&dsh).unwrap()["env"]["A"], "1");
        // A row with another id is ours through serverName, and its id stays.
        let custom = dir.join("custom.yml");
        let original = "- insert:\n    - id: my-browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse\n        args: [mcp]\n";
        std::fs::write(&custom, original).unwrap();
        let dsh = loc("dsh", custom.clone());
        assert_eq!(edit(&dsh, &command("/usr/bin/browse"), false).unwrap(), Edit::Updated);
        let text = std::fs::read_to_string(&custom).unwrap();
        assert!(text.contains("    - id: my-browse\n"), "{text}");
        assert!(text.contains("command: /usr/bin/browse\n"), "{text}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn update_allows_hash_in_command() {
        let dir = temp("dsh-hash");
        let file = dir.join("cordis.patch.yml");
        let original = row("\"/tmp/with#hash/browse\"");
        std::fs::write(&file, &original).unwrap();
        let dsh = loc("dsh", file.clone());
        assert_eq!(edit(&dsh, &command("/tmp/with#hash/browse2"), false).unwrap(), Edit::Updated);
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("command: \"/tmp/with#hash/browse2\"\n") || text.contains("command: /tmp/with#hash/browse2\n"), "{text}");
        assert_eq!(current(&dsh).unwrap()["command"], "/tmp/with#hash/browse2");
        // An apostrophe in a plain path is not a quote.
        let plain = dir.join("plain.yml");
        std::fs::write(&plain, row("/home/o'b/browse")).unwrap();
        let dsh = loc("dsh", plain.clone());
        assert_eq!(edit(&dsh, &command("/home/o'b/browse2"), false).unwrap(), Edit::Updated);
        assert_eq!(current(&dsh).unwrap()["command"], "/home/o'b/browse2");
        // A quoted path may contain an escaped quote.
        let quoted = dir.join("quoted.yml");
        std::fs::write(&quoted, row("'/bin/o''b/browse'")).unwrap();
        let dsh = loc("dsh", quoted.clone());
        assert_eq!(edit(&dsh, &command("/usr/bin/browse"), false).unwrap(), Edit::Updated);
        assert_eq!(current(&dsh).unwrap()["command"], "/usr/bin/browse");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn update_refuses_unsafe_rows() {
        let dir = temp("dsh-unsafe");
        let cases = [
            // The apostrophe must not hide the tag; a rewrite would drop it.
            ("tag", "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse\n        args: [mcp]\n        env: {A: it's, B: !!js process.env.X}\n"),
            // Another plugin, even with browse's id and server name.
            ("name", "- insert:\n    - id: browse\n      name: '@deepseek-ai/other-mcp'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse\n        args: [mcp]\n"),
            // A block list would have to be rebuilt.
            ("args", "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse\n        args:\n          - serve\n"),
            // A command on its own line has no simple value to replace.
            ("block", "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command:\n          - x\n        args: [mcp]\n"),
            // A trailing comment on the line we would replace.
            ("comment", "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse # old\n        args: [mcp]\n"),
            // An apostrophe in a plain path must not hide a following comment.
            ("apostrophe", "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /home/o'b/browse # mine\n        args: [mcp]\n"),
            // A quote in the comment must not be mistaken for the value's closing quote.
            ("single-quote-comment", "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: '/bin/browse' # don't touch\n        args: [mcp]\n"),
            ("double-quote-comment", "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: \"/bin/browse\" # see \"docs\"\n        args: [mcp]\n"),
            // Escaped quotes inside a quoted value, with a comment after it.
            ("escaped-single", "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: '/bin/o''b/browse' # c\n        args: [mcp]\n"),
            ("escaped-double", "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: \"/bin/br\\\"owse/browse\" # c\n        args: [mcp]\n"),
            // A value that continues on a deeper line.
            ("continuation", "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/\n          browse\n        args: [mcp]\n"),
        ];
        for (name, original) in cases {
            let file = dir.join(format!("{name}.yml"));
            std::fs::write(&file, original).unwrap();
            let dsh = loc("dsh", file.clone());
            assert_eq!(edit(&dsh, &command("/usr/bin/browse"), false).unwrap(), Edit::Conflict, "{name}");
            assert_eq!(std::fs::read_to_string(&file).unwrap(), original, "{name}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn leaves_foreign_rows() {
        let dir = temp("dsh-foreign");
        let file = dir.join("name.yml");
        let original = "- insert:\n    - id: browse\n      name: '@deepseek-ai/some-other-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: other-tool\n        args: [serve]\n";
        std::fs::write(&file, original).unwrap();
        let dsh = loc("dsh", file.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Conflict);
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Conflict);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), original);
        // Our id and plugin, but someone else's command: not ours to change.
        let second = dir.join("ours-other-command.yml");
        std::fs::write(&second, "- insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: other-tool\n        args: [serve]\n").unwrap();
        let dsh = loc("dsh", second.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Conflict);
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Conflict);
        // A nested serverName: browse the finder can't edit must not gain a second row.
        let nested = dir.join("nested.yml");
        let original = "- insert:\n    - id: group\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        - id: nested\n          name: '@deepseek-ai/dsh-mcp-client'\n          config:\n            serverName: browse\n            transport: stdio\n            command: /bin/browse\n            args: [mcp]\n";
        std::fs::write(&nested, original).unwrap();
        let dsh = loc("dsh", nested.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Conflict);
        assert_eq!(std::fs::read_to_string(&nested).unwrap(), original);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn named_insert_patch() {
        let dir = temp("dsh-named");
        let file = dir.join("cordis.patch.yml");
        let original = "- id: grp\n  insert:\n    - id: browse\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: browse\n        transport: stdio\n        command: /bin/browse\n        args: [mcp]\n";
        std::fs::write(&file, original).unwrap();
        let dsh = loc("dsh", file.clone());
        assert_eq!(edit(&dsh, &command("/usr/bin/browse"), false).unwrap(), Edit::Updated);
        assert!(std::fs::read_to_string(&file).unwrap().contains("command: /usr/bin/browse\n"));
        assert_eq!(edit(&dsh, &command("/usr/bin/browse"), true).unwrap(), Edit::Removed);
        assert!(!file.exists());
        // Installing beside a named patch adds a separate top-level patch, and uninstall removes only that.
        let other = dir.join("other.yml");
        let original = "- id: grp\n  insert:\n    - id: memory\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: memory\n        transport: stdio\n        command: engram\n        args: [mcp]\n";
        std::fs::write(&other, original).unwrap();
        let dsh = loc("dsh", other.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&other).unwrap(), original);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rows_between_others() {
        let dir = temp("dsh-middle");
        let file = dir.join("cordis.patch.yml");
        let other = "- insert:\n    - id: memory\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: memory\n        transport: stdio\n        command: engram\n        args: [mcp]\n";
        let ours = row("/bin/browse");
        std::fs::write(&file, format!("{ours}{other}")).unwrap();
        let dsh = loc("dsh", file.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), other);
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), format!("{other}\n{ours}"));
        // Our row can share an insert list with another plugin's row.
        let shared = dir.join("shared.yml");
        let memory = "    - id: memory\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: memory\n        transport: stdio\n        command: engram\n        args: [mcp]\n";
        let ours = ours.strip_prefix("- insert:\n").unwrap();
        std::fs::write(&shared, format!("- insert:\n{memory}{ours}")).unwrap();
        let dsh = loc("dsh", shared.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Unchanged);
        assert_eq!(edit(&dsh, &command("/usr/bin/browse"), false).unwrap(), Edit::Updated);
        assert_eq!(edit(&dsh, &command("/usr/bin/browse"), true).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&shared).unwrap(), format!("- insert:\n{memory}"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn round_trips_bytes() {
        let dir = temp("dsh-bytes");
        // CRLF stays CRLF.
        let crlf = dir.join("crlf/cordis.patch.yml");
        std::fs::create_dir_all(crlf.parent().unwrap()).unwrap();
        let original = "# c\r\n- insert:\r\n    - id: memory\r\n      name: '@deepseek-ai/dsh-mcp-client'\r\n      config:\r\n        serverName: memory\r\n        transport: stdio\r\n        command: engram\r\n        args: [mcp]\r\n";
        std::fs::write(&crlf, original).unwrap();
        let dsh = loc("dsh", crlf.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        let text = std::fs::read_to_string(&crlf).unwrap();
        assert!(!text.replace("\r\n", "").contains('\n'), "{text:?}");
        assert!(text.contains("\r\n\r\n- insert:\r\n    - id: browse\r\n"), "{text:?}");
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&crlf).unwrap().as_bytes(), original.as_bytes());
        // A file without a trailing newline keeps that too.
        let bare = dir.join("bare/cordis.patch.yml");
        std::fs::create_dir_all(bare.parent().unwrap()).unwrap();
        let original = "# c\n- insert:\n    - id: memory\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: memory\n        transport: stdio\n        command: engram\n        args: [mcp]";
        std::fs::write(&bare, original).unwrap();
        let dsh = loc("dsh", bare.clone());
        assert_eq!(edit(&dsh, &command("/bin/browse"), false).unwrap(), Edit::Added);
        let text = std::fs::read_to_string(&bare).unwrap();
        assert_eq!(text.strip_prefix(original).unwrap(), format!("\n{}", row("/bin/browse")));
        assert_eq!(edit(&dsh, &command("/bin/browse"), true).unwrap(), Edit::Removed);
        assert_eq!(std::fs::read_to_string(&bare).unwrap().as_bytes(), original.as_bytes());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn home_and_location() {
        let home = Path::new("/home/u");
        assert_eq!(super::home(Some("/custom".into()), home), PathBuf::from("/custom"));
        assert_eq!(super::home(Some("   ".into()), home), home.join(".dsh"));
        assert_eq!(super::home(None, home), home.join(".dsh"));
        let dir = temp("dsh-home");
        assert!(!location(dir.clone()).installed);
        std::fs::create_dir_all(dir.join("profiles")).unwrap();
        let located = location(dir.clone());
        assert!(located.installed);
        assert_eq!(located.file, dir.join("cordis.patch.yml"));
        let _ = std::fs::remove_dir_all(dir);
        let patch = temp("dsh-home-patch");
        std::fs::write(patch.join("cordis.patch.yml"), "[]\n").unwrap();
        assert!(location(patch.clone()).installed);
        let _ = std::fs::remove_dir_all(patch);
    }
}
