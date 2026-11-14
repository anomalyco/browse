//! Paths tools may read and write: inside `ToolContext::file_roots`, never through a symlink, never a root itself.
//! Relative paths resolve against the first root.

use std::io::Write;
use std::path::{Component, Path, PathBuf};

use crate::bail_user;

fn describe(roots: &[PathBuf]) -> String {
    roots.iter().map(|root| root.display().to_string()).collect::<Vec<_>>().join(", ")
}

fn canonical_roots(roots: &[PathBuf]) -> Vec<PathBuf> {
    roots.iter().map(|root| std::fs::canonicalize(root).unwrap_or_else(|_| root.clone())).collect()
}

/// `raw` made absolute and lexically normalized, refusing `..` that climbs above the filesystem root.
fn absolute(roots: &[PathBuf], raw: &str) -> anyhow::Result<PathBuf> {
    if raw.is_empty() {
        bail_user!("file paths must be non-empty");
    }
    let Some(first) = roots.first() else { bail_user!("no file roots are configured, so this tool can't use files") };
    let raw = Path::new(raw);
    let joined = if raw.is_absolute() { raw.to_path_buf() } else { first.join(raw) };
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::ParentDir => {
                if !normalized.pop() {
                    bail_user!("{} climbs above the filesystem root", joined.display());
                }
            }
            Component::CurDir => {}
            other => normalized.push(other),
        }
    }
    Ok(normalized)
}

/// The real location `path` refers to: its nearest existing ancestor resolved, plus the parts that don't exist yet.
fn real_target(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    let mut rest = Vec::new();
    loop {
        if let Ok(real) = std::fs::canonicalize(&current) {
            let mut result = real;
            for part in rest.iter().rev() {
                result.push(part);
            }
            return result;
        }
        match (current.parent(), current.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                current = parent.to_path_buf();
            }
            _ => return path.to_path_buf(),
        }
    }
}

fn root_of(real: &Path, roots: &[PathBuf]) -> Option<PathBuf> {
    roots.iter().filter(|root| real.starts_with(root)).max_by_key(|root| root.as_os_str().len()).cloned()
}

fn checked(roots: &[PathBuf], raw: &str) -> anyhow::Result<PathBuf> {
    let path = absolute(roots, raw)?;
    let canonical = canonical_roots(roots);
    let real = real_target(&path);
    let Some(root) = root_of(&real, &canonical) else {
        bail_user!("{} is outside the file roots ({})", path.display(), describe(roots));
    };
    if real == root {
        bail_user!("{} is a file root; use a path inside it", path.display());
    }
    // Refuse symlinks in the path as written, so a link can't redirect a write after this check. Links that only alias
    // a root or a folder above one (macOS's /tmp → /private/tmp) are fine.
    let mut current = path.clone();
    loop {
        if let Ok(meta) = std::fs::symlink_metadata(&current)
            && meta.file_type().is_symlink() {
                let target = std::fs::canonicalize(&current).unwrap_or_default();
                if !canonical.iter().any(|root| root.starts_with(&target)) {
                    bail_user!("{} goes through a symlink, which file paths may not", path.display());
                }
            }
        if !current.pop() {
            break;
        }
    }
    Ok(real)
}

/// A file path to write: parent folders are created, an existing file is replaced, a directory is refused.
pub(crate) fn output_path(roots: &[PathBuf], raw: &str) -> anyhow::Result<PathBuf> {
    let path = checked(roots, raw)?;
    if path.is_dir() {
        bail_user!("{} is a directory; give a file path", path.display());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Creating folders can't have introduced a symlink, but check again in case one raced in.
    checked(roots, &path.to_string_lossy())
}

/// An existing regular file to read.
pub(crate) fn input_path(roots: &[PathBuf], raw: &str) -> anyhow::Result<PathBuf> {
    let path = checked(roots, raw)?;
    match std::fs::metadata(&path) {
        Ok(meta) if meta.is_file() => Ok(path),
        Ok(_) => bail_user!("{} is not a regular file", path.display()),
        Err(_) => bail_user!("{} does not exist", path.display()),
    }
}

/// A directory to write into, created when missing.
pub(crate) fn directory_path(roots: &[PathBuf], raw: &str) -> anyhow::Result<PathBuf> {
    let path = checked(roots, raw)?;
    std::fs::create_dir_all(&path)?;
    let path = checked(roots, &path.to_string_lossy())?;
    if !path.is_dir() {
        bail_user!("{} is not a directory", path.display());
    }
    Ok(path)
}

/// Writes `bytes` to `path` (already checked), private to the user on Unix.
pub(crate) fn write(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

/// A sibling path for an in-progress artifact, renamed into place when it's done.
pub(crate) fn partial_path(path: &Path, extension: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().subsec_nanos();
    let name = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
    path.with_file_name(format!(".{name}.partial-{}-{nanos:x}.{extension}", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("browse-capture-files-{}-{:?}", std::process::id(), std::thread::current().id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::canonicalize(root).unwrap()
    }

    #[test]
    fn paths_stay_inside_roots() {
        let root = temp_root();
        let roots = vec![root.clone()];
        assert_eq!(output_path(&roots, "a/b.png").unwrap(), root.join("a/b.png"));
        assert!(output_path(&roots, "../escape.png").is_err());
        assert!(output_path(&roots, "/etc/passwd").is_err());
        assert!(output_path(&roots, &root.to_string_lossy()).is_err());
        #[cfg(unix)]
        {
            let link = root.join("link");
            let _ = std::fs::remove_file(&link);
            std::os::unix::fs::symlink("/tmp", &link).unwrap();
            assert!(output_path(&roots, "link/x.png").is_err());
        }
        assert!(output_path(&[], "x.png").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
