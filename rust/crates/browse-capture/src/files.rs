//! Files tools read and write, with the rules of cli/src/execute-realm/file-roots.ts: paths stay inside
//! `ToolContext::file_roots` and outside browse's own folders, no symlinks on the way, every folder and file below the
//! root owned by this user and not group/world writable, no hard-linked files, nothing written straight into a shared
//! temporary folder. Files are opened with O_NOFOLLOW and checked against their path again once open; written files
//! go through a 0600 temporary file renamed into place, and folders browse creates are 0700.
//!
//! Relative paths resolve against the first root when only this user can write it, else against a private
//! `opencode-browser-files-<pid>-XXXXXX` folder made inside it (like `files.dir` in the TypeScript CLI).

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

use crate::bail_user;

pub(crate) const FILE_ROOTS_VARIABLE: &str = "OPENCODE_BROWSER_FILE_ROOTS";
const FILES_DIRECTORY_PREFIX: &str = "opencode-browser-files-";

fn describe(roots: &[PathBuf]) -> String {
    let list = roots.iter().map(|root| root.display().to_string()).collect::<Vec<_>>().join(", ");
    format!("{list} (add more with {FILE_ROOTS_VARIABLE})")
}

fn canonical_roots(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for root in roots {
        let real = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        if !out.contains(&real) {
            out.push(real);
        }
    }
    out
}

/// `path` lexically normalized, refusing `..` that climbs above the filesystem root.
fn normalize(path: &Path) -> anyhow::Result<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                if !normalized.pop() {
                    bail_user!("{} climbs above the filesystem root", path.display());
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

fn root_of<'a>(real: &Path, roots: &'a [PathBuf]) -> Option<&'a PathBuf> {
    roots.iter().filter(|root| real.starts_with(root)).max_by_key(|root| root.as_os_str().len())
}

/// browse's own folders (cli/src/paths.ts layout), whose contents tools never read or write.
fn browse_owned() -> Vec<PathBuf> {
    let mut folders = Vec::new();
    if let Some(home) = std::env::var_os("OPENCODE_BROWSER_HOME").filter(|value| !value.is_empty()) {
        folders.push(PathBuf::from(home));
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for (variable, fallback) in
            [("XDG_CONFIG_HOME", ".config"), ("XDG_DATA_HOME", ".local/share"), ("XDG_STATE_HOME", ".local/state"), ("XDG_CACHE_HOME", ".cache")]
        {
            let base = std::env::var_os(variable).map(PathBuf::from).filter(|path| path.is_absolute());
            folders.push(base.unwrap_or_else(|| home.join(fallback)).join("browse"));
        }
    }
    folders.iter().map(|folder| real_target(folder)).collect()
}

#[cfg(unix)]
fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

#[cfg(unix)]
fn shared(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    meta.uid() != uid() || meta.mode() & 0o022 != 0
}

#[cfg(not(unix))]
fn shared(_: &std::fs::Metadata) -> bool {
    false
}

fn lstat(path: &Path) -> anyhow::Result<Option<std::fs::Metadata>> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => Ok(Some(meta)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Port of assertExecuteFilePath: refuses `target` unless it is inside a root, outside browse's folders, reached
/// without symlinks through owned private folders, and (when it exists) a regular file with one link or a folder.
/// Returns its real location.
fn check(roots: &[PathBuf], target: &Path, operation: &str) -> anyhow::Result<PathBuf> {
    let roots = canonical_roots(roots);
    let resolved = real_target(target);
    if browse_owned().iter().any(|folder| resolved.starts_with(folder)) {
        bail_user!("{operation}: {} is inside browse's own files, which tools cannot access", target.display());
    }
    let Some(root) = root_of(&resolved, &roots).cloned() else {
        bail_user!("{operation}: {} is outside the file roots {}", target.display(), describe(&roots));
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::metadata(&root)?;
        if meta.mode() & 0o022 != 0 && meta.mode() & 0o1000 == 0 {
            bail_user!("{operation}: shared writable roots must have the sticky bit set");
        }
    }
    // Symlinks in the path as written; only root-owned aliases of a root or a folder above one (macOS's /tmp →
    // /private/tmp) are allowed.
    let mut spelling = target.to_path_buf();
    loop {
        if let Some(meta) = lstat(&spelling)?
            && meta.file_type().is_symlink()
        {
            let real = std::fs::canonicalize(&spelling).unwrap_or_default();
            #[cfg(unix)]
            let root_owned = std::os::unix::fs::MetadataExt::uid(&meta) == 0;
            #[cfg(not(unix))]
            let root_owned = false;
            if !root_owned || !roots.iter().any(|root| root.starts_with(&real)) {
                bail_user!("{operation}: symlink paths are not allowed");
            }
        }
        if !spelling.pop() {
            break;
        }
    }
    let mut current = resolved.clone();
    while current.starts_with(&root) {
        if let Some(meta) = lstat(&current)? {
            if meta.file_type().is_symlink() {
                bail_user!("{operation}: symlink paths are not allowed");
            }
            if current != root && shared(&meta) {
                bail_user!(
                    "{operation}: file paths must use owned directories and files without group/world write access ({} is not); use a relative path for a file in the private files folder",
                    current.display()
                );
            }
            #[cfg(unix)]
            let links = std::os::unix::fs::MetadataExt::nlink(&meta);
            #[cfg(not(unix))]
            let links = 1;
            if !meta.is_dir() && (!meta.is_file() || links != 1) {
                bail_user!("{operation}: expected a regular file with no hard links");
            }
        }
        if current == root || !current.pop() {
            break;
        }
    }
    if resolved.parent() == Some(root.as_path()) && shared(&std::fs::metadata(&root)?) {
        bail_user!("{operation}: use a private subdirectory (or a relative path), not a shared temporary directory");
    }
    Ok(resolved)
}

static FILES_DIRECTORIES: LazyLock<Mutex<HashMap<PathBuf, PathBuf>>> = LazyLock::new(Mutex::default);

fn random_suffix() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos() as u64;
    let mut seed = (nanos ^ (std::process::id() as u64).rotate_left(32) ^ COUNTER.fetch_add(1, Ordering::Relaxed).wrapping_mul(0x9E37_79B9_7F4A_7C15)) | 1;
    (0..6)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            ALPHABET[(seed % ALPHABET.len() as u64) as usize] as char
        })
        .collect()
}

#[cfg(unix)]
fn process_alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Removes files folders of processes that are gone (owned by this user, named with a pid that no longer runs).
#[cfg(unix)]
fn prune_stale(base: &Path) {
    use std::os::unix::fs::MetadataExt;
    let Ok(entries) = std::fs::read_dir(base) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix(FILES_DIRECTORY_PREFIX) else { continue };
        let Some((pid, suffix)) = rest.split_once('-') else { continue };
        let Ok(pid) = pid.parse::<i32>() else { continue };
        if suffix.len() != 6 || pid <= 0 || pid as u32 == std::process::id() || process_alive(pid) {
            continue;
        }
        let path = entry.path();
        if let Ok(meta) = std::fs::symlink_metadata(&path)
            && meta.is_dir()
            && meta.uid() == uid()
        {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// This process's private folder for relative paths inside `base`, made 0700 on first use.
fn files_directory(base: &Path) -> anyhow::Result<PathBuf> {
    let mut directories = FILES_DIRECTORIES.lock().unwrap();
    if let Some(directory) = directories.get(base) {
        let meta = std::fs::symlink_metadata(directory)?;
        #[cfg(unix)]
        let private = std::os::unix::fs::MetadataExt::mode(&meta) & 0o777 == 0o700 && !shared(&meta);
        #[cfg(not(unix))]
        let private = true;
        if meta.is_dir() && !meta.file_type().is_symlink() && private {
            return Ok(directory.clone());
        }
        bail_user!("the private files folder {} must be an owned 0700 directory, not a symlink", directory.display());
    }
    #[cfg(unix)]
    prune_stale(base);
    for _ in 0..16 {
        let directory = base.join(format!("{FILES_DIRECTORY_PREFIX}{}-{}", std::process::id(), random_suffix()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        match builder.create(&directory) {
            Ok(()) => {
                pin_private_directory(&directory)?;
                directories.insert(base.to_path_buf(), directory.clone());
                return Ok(directory);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    bail_user!("could not create a private files folder in {}", base.display())
}

/// `raw` as an absolute, lexically normalized path; relative paths go to the first root or its private files folder.
fn absolute(roots: &[PathBuf], raw: &str, operation: &str) -> anyhow::Result<PathBuf> {
    if raw.is_empty() {
        bail_user!("{operation}: file paths must be non-empty strings");
    }
    let raw = Path::new(raw);
    if raw.is_absolute() {
        return normalize(raw);
    }
    let Some(first) = canonical_roots(roots).into_iter().next() else {
        bail_user!("{operation}: no file roots are configured (add some with {FILE_ROOTS_VARIABLE})")
    };
    let base = if shared(&std::fs::metadata(&first)?) { files_directory(&first)? } else { first };
    normalize(&base.join(raw))
}

/// A file path to write, checked; nothing is created yet. Directories and roots are refused.
pub(crate) fn output_path(roots: &[PathBuf], raw: &str, operation: &str) -> anyhow::Result<PathBuf> {
    let path = absolute(roots, raw, operation)?;
    let resolved = check(roots, &path, operation)?;
    if canonical_roots(roots).contains(&resolved) {
        bail_user!("{operation}: {} is a file root; use a path inside it", path.display());
    }
    if resolved.is_dir() {
        bail_user!("{operation}: {} is a directory; give a file path", path.display());
    }
    Ok(resolved)
}

/// Pins a folder this call created to 0700 through its descriptor, never through its path.
fn pin_private_directory(directory: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
        let refuse = || anyhow::Error::new(crate::UserError(output_directory_error(directory)));
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(directory)
            .map_err(|_| refuse())?;
        let opened = file.metadata()?;
        let current = std::fs::symlink_metadata(directory)?;
        if !opened.is_dir() || opened.uid() != uid() || current.file_type().is_symlink() || current.dev() != opened.dev() || current.ino() != opened.ino() {
            return Err(refuse());
        }
        if opened.mode() & 0o777 != 0o700 {
            file.set_permissions(std::fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

fn output_directory_error(directory: &Path) -> String {
    format!("file outputs must use real, owned directories without group/world write access, not {}", directory.display())
}

/// Creates the folders `path` needs as 0700 (port of ensureExecuteOutputDirectory), after refusing any existing
/// component that is a symlink or, below the root, shared. Returns the folders it created, outermost first.
pub(crate) fn prepare(roots: &[PathBuf], path: &Path, operation: &str) -> anyhow::Result<Vec<PathBuf>> {
    check(roots, path, operation)?;
    let roots_real = canonical_roots(roots);
    let Some(directory) = path.parent() else { bail_user!("{}", output_directory_error(path)) };
    let Some(root) = root_of(directory, &roots_real).cloned() else { bail_user!("{}", output_directory_error(directory)) };
    let mut missing = Vec::new();
    let mut current = directory.to_path_buf();
    loop {
        match lstat(&current)? {
            Some(meta) => {
                if !meta.is_dir() || meta.file_type().is_symlink() || (current != root && shared(&meta)) {
                    bail_user!("{}", output_directory_error(&current));
                }
            }
            None if current == root => bail_user!("{}", output_directory_error(&current)),
            None => missing.push(current.clone()),
        }
        if current == root || !current.pop() {
            break;
        }
    }
    let mut created = Vec::new();
    for step in missing.into_iter().rev() {
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        match builder.create(&step) {
            Ok(()) => {
                created.push(step.clone());
                pin_private_directory(&step)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                remove_created(&created);
                return Err(error.into());
            }
        }
        let meta = std::fs::symlink_metadata(&step)?;
        if !meta.is_dir() || meta.file_type().is_symlink() || shared(&meta) {
            remove_created(&created);
            bail_user!("{}", output_directory_error(&step));
        }
    }
    if let Err(error) = check(roots, path, operation) {
        remove_created(&created);
        return Err(error);
    }
    Ok(created)
}

/// Removes folders `prepare` created, innermost first, as long as they are still empty.
pub(crate) fn remove_created(created: &[PathBuf]) {
    for folder in created.iter().rev() {
        let _ = std::fs::remove_dir(folder);
    }
}

/// Checks an open file against its path: same inode, a regular file with one link, owned by this user, and (on
/// Linux) the descriptor's real location still passes the path checks.
fn check_open(roots: &[PathBuf], file: &File, path: &Path, operation: &str) -> anyhow::Result<()> {
    let opened = file.metadata()?;
    let current = std::fs::symlink_metadata(path)?;
    check(roots, path, operation)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if !opened.is_file()
            || opened.nlink() != 1
            || current.file_type().is_symlink()
            || opened.ino() != current.ino()
            || opened.dev() != current.dev()
            || opened.uid() != uid()
        {
            bail_user!("{operation}: file changed while opening it");
        }
    }
    #[cfg(not(unix))]
    if !opened.is_file() || current.file_type().is_symlink() {
        bail_user!("{operation}: file changed while opening it");
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let real = std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))?;
        check(roots, &real, operation)?;
    }
    Ok(())
}

fn open_options(write: bool) -> std::fs::OpenOptions {
    let mut options = std::fs::OpenOptions::new();
    if write {
        options.write(true).create_new(true);
    } else {
        options.read(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    options
}

/// Reads an existing file inside the roots, at most `max` bytes.
pub(crate) fn read(roots: &[PathBuf], raw: &str, operation: &str, max: usize) -> anyhow::Result<Vec<u8>> {
    let path = absolute(roots, raw, operation)?;
    let resolved = check(roots, &path, operation)?;
    match std::fs::symlink_metadata(&resolved) {
        Ok(meta) if meta.is_file() => {}
        Ok(_) => bail_user!("{operation}: {} is not a regular file", path.display()),
        Err(_) => bail_user!("{operation}: {} does not exist", path.display()),
    }
    let file = open_options(false).open(&resolved)?;
    check_open(roots, &file, &resolved, operation)?;
    let mut bytes = Vec::new();
    file.take(max as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > max {
        bail_user!("{operation}: {} is larger than {} MiB", path.display(), max / (1024 * 1024));
    }
    Ok(bytes)
}

/// Creates a new 0600 file at `path` (its folders must exist), refusing anything already there.
pub(crate) fn create_new(roots: &[PathBuf], path: &Path, operation: &str) -> anyhow::Result<File> {
    let file = open_options(true).open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Default ACLs can widen the mode create gave it.
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    if let Err(error) = check_open(roots, &file, path, operation) {
        let _ = std::fs::remove_file(path);
        return Err(error);
    }
    Ok(file)
}

/// Writes `bytes` to `path` (from `output_path`): folders are created 0700, the data goes to a new 0600 file beside it
/// that is renamed over the target. Returns the folders it created.
pub(crate) fn write(roots: &[PathBuf], path: &Path, bytes: &[u8], operation: &str) -> anyhow::Result<Vec<PathBuf>> {
    let created = prepare(roots, path, operation)?;
    let temp = partial_path(path, "tmp");
    let result = (|| {
        let mut file = create_new(roots, &temp, operation)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        check(roots, path, operation)?;
        if std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir()) {
            bail_user!("{operation}: {} is a directory; give a file path", path.display());
        }
        std::fs::rename(&temp, path)?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temp);
        remove_created(&created);
        return Err(error);
    }
    Ok(created)
}

/// Makes a file another program wrote (ffmpeg) private: opened with O_NOFOLLOW, checked against its path, then
/// chmod 0600 through the descriptor.
pub(crate) fn secure(roots: &[PathBuf], path: &Path, operation: &str) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let file = open_options(false).open(path)?;
        let opened = file.metadata()?;
        let current = std::fs::symlink_metadata(path)?;
        if !opened.is_file() || opened.nlink() != 1 || opened.uid() != uid() || current.file_type().is_symlink() || current.ino() != opened.ino() || current.dev() != opened.dev() {
            bail_user!("{operation}: file changed while opening it");
        }
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        check_open(roots, &file, path, operation)?;
    }
    #[cfg(not(unix))]
    let _ = (roots, path, operation);
    Ok(())
}

/// Renames a finished partial file over `path` after checking `path` again.
pub(crate) fn commit(roots: &[PathBuf], partial: &Path, path: &Path, operation: &str) -> anyhow::Result<()> {
    secure(roots, partial, operation)?;
    check(roots, path, operation)?;
    std::fs::rename(partial, path)?;
    Ok(())
}

/// A sibling path for an in-progress artifact, renamed into place when it's done.
pub(crate) fn partial_path(path: &Path, extension: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().subsec_nanos();
    let name = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
    path.with_file_name(format!(".{name}.partial-{}-{nanos:x}-{}.{extension}", std::process::id(), random_suffix()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("browse-capture-files-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        std::fs::canonicalize(root).unwrap()
    }

    #[test]
    fn paths_stay_inside_roots() {
        let root = temp_root("inside");
        let roots = vec![root.clone()];
        assert_eq!(output_path(&roots, "a/b.png", "t").unwrap(), root.join("a/b.png"));
        assert!(output_path(&roots, "../escape.png", "t").is_err());
        assert!(output_path(&roots, "/etc/passwd", "t").is_err());
        assert!(output_path(&roots, &root.to_string_lossy(), "t").is_err());
        #[cfg(unix)]
        {
            let link = root.join("link");
            std::os::unix::fs::symlink("/tmp", &link).unwrap();
            assert!(output_path(&roots, "link/x.png", "t").is_err());
        }
        assert!(output_path(&[], "x.png", "t").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn writes_are_private_and_refuse_unsafe_targets() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = temp_root("private");
        let roots = vec![root.clone()];
        let path = output_path(&roots, "deep/er/x.png", "t").unwrap();
        let created = write(&roots, &path, b"one", "t").unwrap();
        assert_eq!(created, vec![root.join("deep"), root.join("deep/er")]);
        assert_eq!(std::fs::metadata(root.join("deep")).unwrap().mode() & 0o777, 0o700);
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        // An existing file is replaced by a 0600 one.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write(&roots, &path, b"two", "t").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        assert_eq!(read(&roots, "deep/er/x.png", "t", 10).unwrap(), b"two");
        // Hard links, group-writable files and folders, and symlinked files are refused.
        std::fs::hard_link(&path, root.join("deep/link.png")).unwrap();
        let error = write(&roots, &path, b"x", "t").unwrap_err().to_string();
        assert!(error.contains("no hard links"), "{error}");
        assert!(read(&roots, "deep/link.png", "t", 10).is_err());
        std::fs::remove_file(root.join("deep/link.png")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o664)).unwrap();
        let error = read(&roots, "deep/er/x.png", "t", 10).unwrap_err().to_string();
        assert!(error.contains("group/world write"), "{error}");
        std::fs::set_permissions(root.join("deep"), std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(output_path(&roots, "deep/new.png", "t").is_err());
        std::fs::set_permissions(root.join("deep"), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::os::unix::fs::symlink(&path, root.join("deep/sym.png")).unwrap();
        assert!(read(&roots, "deep/sym.png", "t", 10).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn shared_roots_get_a_private_folder_for_relative_paths() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = temp_root("shared");
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o1777)).unwrap();
        let roots = vec![root.clone()];
        let error = output_path(&roots, &root.join("x.png").to_string_lossy(), "t").unwrap_err().to_string();
        assert!(error.contains("not a shared temporary directory"), "{error}");
        let path = output_path(&roots, "x.png", "t").unwrap();
        let folder = path.parent().unwrap();
        assert!(folder.file_name().unwrap().to_string_lossy().starts_with(FILES_DIRECTORY_PREFIX), "{}", path.display());
        assert_eq!(std::fs::metadata(folder).unwrap().mode() & 0o777, 0o700);
        // Without the sticky bit a shared root is refused.
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o777)).unwrap();
        let error = output_path(&roots, "x.png", "t").unwrap_err().to_string();
        assert!(error.contains("sticky bit"), "{error}");
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        FILES_DIRECTORIES.lock().unwrap().remove(&root);
        std::fs::remove_dir_all(root).unwrap();
    }
}
