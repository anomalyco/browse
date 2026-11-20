//! File paths agents may hand to the page (uploads): absolute, inside `ToolContext::file_roots`, regular files with
//! no symlinks on the way, owned by this user and not writable by others (cli/src/execute-realm/file-roots.ts).

use std::path::{Component, Path, PathBuf};

use anyhow::{Result, bail};

fn real_roots(roots: &[PathBuf]) -> Vec<PathBuf> {
    roots.iter().map(|root| std::fs::canonicalize(root).unwrap_or_else(|_| root.clone())).collect()
}

fn describe_roots(roots: &[PathBuf]) -> String {
    if roots.is_empty() {
        return "(none configured)".into();
    }
    roots.iter().map(|r| r.display().to_string()).collect::<Vec<_>>().join(", ")
}

/// Checks one upload path and returns its real location.
pub fn check_upload(path: &str, roots: &[PathBuf]) -> Result<PathBuf> {
    let target = Path::new(path);
    if path.is_empty() || !target.is_absolute() {
        bail!("upload: use an absolute path inside the file roots {}", describe_roots(roots));
    }
    if target.components().any(|c| matches!(c, Component::ParentDir)) {
        bail!("upload: {path} contains `..`; use a plain absolute path");
    }
    let roots = real_roots(roots);
    // No component may be a symlink unless it is a root-owned system alias (macOS /tmp, /var).
    let mut current = PathBuf::new();
    for component in target.components() {
        current.push(component);
        if let Ok(meta) = std::fs::symlink_metadata(&current)
            && meta.file_type().is_symlink() {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    let real = std::fs::canonicalize(&current).unwrap_or_default();
                    if meta.uid() == 0 && roots.iter().any(|root| root.starts_with(&real)) {
                        continue;
                    }
                }
                bail!("upload: {path} goes through a symlink; pass the real path");
            }
    }
    let real = std::fs::canonicalize(target).map_err(|error| anyhow::anyhow!("upload: {path}: {error}"))?;
    let Some(root) = roots.iter().filter(|root| real.starts_with(root)).max_by_key(|root| root.as_os_str().len()) else {
        bail!("upload: {path} is outside the file roots {}", describe_roots(&roots));
    };
    if &real == root {
        bail!("upload: {path} is a file root; use a file inside it");
    }
    let meta = std::fs::metadata(&real)?;
    if !meta.is_file() {
        bail!("upload: {path} is not a regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let uid = current_uid();
        if meta.nlink() != 1 {
            bail!("upload: {path} has hard links; copy it to a private folder first");
        }
        // Every folder between the root and the file must be ours and not writable by others.
        let mut folder = real.parent().map(Path::to_path_buf);
        while let Some(dir) = folder {
            if !dir.starts_with(root) || &dir == root {
                break;
            }
            let dir_meta = std::fs::metadata(&dir)?;
            if dir_meta.uid() != uid || dir_meta.mode() & 0o022 != 0 {
                bail!("upload: {} must be owned by you and not group/world-writable", dir.display());
            }
            folder = dir.parent().map(Path::to_path_buf);
        }
        if meta.uid() != uid || meta.mode() & 0o022 != 0 {
            bail!("upload: {path} must be owned by you and not group/world-writable");
        }
    }
    Ok(real)
}

/// Whether the folder holding an upload path is private enough for Chrome to reopen the file later: its parent is a
/// folder only this user can write. True where there are no Unix modes to check (Chrome reads the same handles).
pub fn private_for_paths(path: &str) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let Some(parent) = Path::new(path).parent() else { return false };
        std::fs::symlink_metadata(parent).map(|meta| meta.is_dir() && meta.uid() == current_uid() && meta.mode() & 0o022 == 0).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        true
    }
}

#[cfg(unix)]
fn current_uid() -> u32 {
    use std::os::unix::fs::MetadataExt;
    // The owner of our own process's /proc entry, or of a fresh temp file, is our uid; avoids a libc dependency.
    std::fs::metadata("/proc/self").map(|m| m.uid()).unwrap_or_else(|_| {
        let probe = std::env::temp_dir().join(format!("browse-uid-{}", std::process::id()));
        let uid = std::fs::write(&probe, b"").and_then(|_| std::fs::metadata(&probe)).map(|m| m.uid()).unwrap_or(u32::MAX);
        let _ = std::fs::remove_file(&probe);
        uid
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_paths_must_be_inside_roots() {
        let base = std::env::temp_dir().join(format!("browse-page-files-{}", std::process::id()));
        let root = base.join("root");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root.join("sub"), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let file = root.join("sub/a.txt");
        std::fs::write(&file, b"hi").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let roots = vec![root.clone()];
        assert!(check_upload(file.to_str().unwrap(), &roots).is_ok());
        assert!(check_upload("relative.txt", &roots).is_err());
        assert!(check_upload("/etc/hostname", &roots).is_err());
        assert!(check_upload(root.to_str().unwrap(), &roots).is_err());
        #[cfg(unix)]
        {
            let link = root.join("link.txt");
            let _ = std::fs::remove_file(&link);
            std::os::unix::fs::symlink(&file, &link).unwrap();
            assert!(check_upload(link.to_str().unwrap(), &roots).is_err());
        }
        let _ = std::fs::remove_dir_all(&base);
    }
}
