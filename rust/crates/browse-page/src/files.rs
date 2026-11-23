//! File paths agents may hand to the page (uploads): absolute, inside `ToolContext::file_roots`, regular files with
//! no symlinks on the way, owned by this user and not writable by others (cli/src/execute-realm/file-roots.ts).
//! Files that aren't on this machine can be passed inline as `{ name, data }` with base64 data instead.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use anyhow::{Result, bail};
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::{Engine, alphabet};
use serde_json::Value;

/// The most bytes one upload sends into the page when it copies files in (paths the browser can read have no limit).
pub const MAX_UPLOAD_BYTES: u64 = 50 * 1024 * 1024;

/// Inline data may be line-wrapped and may have lost its padding on the way, so decode it as such (not URL-safe).
const INLINE_BASE64: GeneralPurpose =
    GeneralPurpose::new(&alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent));

/// One entry of the upload tool's `files`: a path this machine can read, or bytes passed inline.
#[derive(Clone, Debug)]
pub enum UploadFile {
    Path(String),
    Inline(InlineFile),
}

/// A file an agent passed as `{ name, data }` (base64) when its bytes aren't on this machine.
#[derive(Clone, Debug)]
pub struct InlineFile {
    pub name: String,
    pub bytes: Arc<[u8]>,
    pub mime_type: Option<String>,
    pub last_modified: Option<u64>,
}

impl UploadFile {
    /// The name the page sees for this file.
    pub fn name(&self) -> String {
        match self {
            UploadFile::Path(path) => Path::new(path).file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default(),
            UploadFile::Inline(file) => file.name.clone(),
        }
    }

    /// Checks a path again (it may have changed since the call started) and returns the files to send.
    pub fn checked(&self, roots: &[PathBuf]) -> Result<UploadFile> {
        match self {
            UploadFile::Path(path) => Ok(UploadFile::Path(check_upload(path, roots)?.display().to_string())),
            inline => Ok(inline.clone()),
        }
    }
}

/// Reads the upload tool's `files` argument: a path or inline `{ name, data }` object, or an array mixing both.
pub fn parse_upload_files(value: Option<&Value>) -> Result<Vec<UploadFile>> {
    let entries: Vec<&Value> = match value {
        Some(value @ (Value::String(_) | Value::Object(_))) => vec![value],
        Some(Value::Array(files)) => files.iter().collect(),
        _ => bail!("upload needs files: absolute paths inside the file roots, or inline files as {{ name, data }} with base64 data"),
    };
    entries.into_iter().map(parse_upload_file).collect()
}

fn parse_upload_file(value: &Value) -> Result<UploadFile> {
    if let Some(path) = value.as_str() {
        return Ok(UploadFile::Path(path.to_string()));
    }
    let Some(object) = value.as_object() else {
        bail!("upload: each file is an absolute path or an inline {{ name, data }} object");
    };
    let Some(name) = object.get("name").and_then(Value::as_str) else {
        bail!("upload: an inline file needs a name");
    };
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') || name.contains('\0') {
        bail!("upload: {name:?} is not a plain file name; inline files take a name, not a path");
    }
    let Some(data) = object.get("data").and_then(Value::as_str) else {
        bail!("upload: {name}: an inline file needs data as base64");
    };
    // Refuse a file over the cap before decoding it, from the encoded length alone.
    let encoded: Vec<u8> = data.bytes().filter(|byte| !byte.is_ascii_whitespace()).collect();
    let padding = encoded.iter().rev().take_while(|byte| **byte == b'=').count() as u64;
    let decoded = (encoded.len() as u64).saturating_sub(padding) * 3 / 4;
    if decoded > MAX_UPLOAD_BYTES {
        bail!(
            "upload: {name} is {:.1} MB; browse uploads at most {} MB per call",
            decoded as f64 / 1_048_576.0,
            MAX_UPLOAD_BYTES / 1_048_576
        );
    }
    let bytes = INLINE_BASE64.decode(&encoded).map_err(|_| anyhow::anyhow!("upload: {name}: data is not valid base64"))?;
    let mime_type = match object.get("mimeType") {
        None | Some(Value::Null) => None,
        Some(Value::String(mime)) => Some(mime.clone()),
        Some(_) => bail!("upload: {name}: mimeType must be a string"),
    };
    let last_modified = match object.get("lastModified") {
        None | Some(Value::Null) => None,
        Some(value) => match value.as_u64() {
            Some(milliseconds) => Some(milliseconds),
            None => bail!("upload: {name}: lastModified must be milliseconds as a number"),
        },
    };
    Ok(UploadFile::Inline(InlineFile { name: name.to_string(), bytes: bytes.into(), mime_type, last_modified }))
}

fn real_roots(roots: &[PathBuf]) -> Vec<PathBuf> {
    roots.iter().map(|root| std::fs::canonicalize(root).unwrap_or_else(|_| root.clone())).collect()
}

/// The way out for an agent whose files are on another machine.
const INLINE_HINT: &str = "files not on this machine can be passed inline as { name, data } with base64 data";

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
        bail!("upload: use an absolute path inside the file roots {} ({INLINE_HINT})", describe_roots(roots));
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
        bail!("upload: {path} is outside the file roots {} ({INLINE_HINT})", describe_roots(&roots));
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
    use serde_json::json;

    #[test]
    fn inline_uploads_parse_alone_and_mixed_with_paths() {
        let files = parse_upload_files(Some(&json!("/tmp/a.txt"))).unwrap();
        assert!(matches!(&files[0], UploadFile::Path(path) if path == "/tmp/a.txt"));

        let files = parse_upload_files(Some(&json!([
            "/tmp/a.txt",
            { "name": "notes.txt", "data": "aGVsbG8=", "mimeType": "text/plain", "lastModified": 1_700_000_000_000u64 },
        ])))
        .unwrap();
        assert_eq!(files.len(), 2);
        assert!(matches!(&files[0], UploadFile::Path(path) if path == "/tmp/a.txt"));
        let UploadFile::Inline(inline) = &files[1] else { panic!("expected an inline file") };
        assert_eq!(inline.name, "notes.txt");
        assert_eq!(&*inline.bytes, b"hello");
        assert_eq!(inline.mime_type.as_deref(), Some("text/plain"));
        assert_eq!(inline.last_modified, Some(1_700_000_000_000));
        assert_eq!(files[1].name(), "notes.txt");

        // mimeType and lastModified are optional.
        let files = parse_upload_files(Some(&json!([{ "name": "blob.bin", "data": "AAEC" }]))).unwrap();
        let UploadFile::Inline(inline) = &files[0] else { panic!("expected an inline file") };
        assert_eq!(&*inline.bytes, &[0, 1, 2]);
        assert_eq!(inline.mime_type, None);
        assert_eq!(inline.last_modified, None);

        // A single object is one file, like a single path (the schema allows files: { name, data }).
        let files = parse_upload_files(Some(&json!({ "name": "only.txt", "data": "aGVsbG8=" }))).unwrap();
        assert_eq!(files.len(), 1);
        let UploadFile::Inline(inline) = &files[0] else { panic!("expected an inline file") };
        assert_eq!(&*inline.bytes, b"hello");

        // Line-wrapped data and base64 that lost its padding both decode.
        let files = parse_upload_files(Some(&json!({ "name": "wrapped.txt", "data": "aGVs\nbG8" }))).unwrap();
        let UploadFile::Inline(inline) = &files[0] else { panic!("expected an inline file") };
        assert_eq!(&*inline.bytes, b"hello");

        // An empty file is a file too.
        let files = parse_upload_files(Some(&json!([{ "name": "empty.txt", "data": "" }]))).unwrap();
        let UploadFile::Inline(inline) = &files[0] else { panic!("expected an inline file") };
        assert!(inline.bytes.is_empty());
    }

    #[test]
    fn inline_uploads_reject_bad_names_data_and_options() {
        for name in ["", ".", "..", "a/b.txt", "..\\b.txt"] {
            let error = parse_upload_files(Some(&json!([{ "name": name, "data": "aGVsbG8=" }]))).unwrap_err().to_string();
            assert!(error.contains("plain file name"), "{name:?}: {error}");
        }
        for data in ["not base64!", "aGVsbG8==="] {
            let error = parse_upload_files(Some(&json!([{ "name": "a.txt", "data": data }]))).unwrap_err().to_string();
            assert!(error.contains("valid base64"), "{data:?}: {error}");
        }
        // Refused from the encoded length alone, before decoding.
        let oversized = "A".repeat((MAX_UPLOAD_BYTES as usize / 3 + 1) * 4);
        let error = parse_upload_files(Some(&json!([{ "name": "big.bin", "data": oversized }]))).unwrap_err().to_string();
        assert!(error.contains("uploads at most 50 MB per call"), "{error}");
        let error = parse_upload_files(Some(&json!([{ "name": "a.txt" }]))).unwrap_err().to_string();
        assert!(error.contains("needs data as base64"), "{error}");
        let error = parse_upload_files(Some(&json!([{ "data": "aGVsbG8=" }]))).unwrap_err().to_string();
        assert!(error.contains("needs a name"), "{error}");
        let error = parse_upload_files(Some(&json!([{ "name": "a.txt", "data": "aGVsbG8=", "mimeType": 1 }]))).unwrap_err().to_string();
        assert!(error.contains("mimeType must be a string"), "{error}");
        let error = parse_upload_files(Some(&json!([{ "name": "a.txt", "data": "aGVsbG8=", "lastModified": "now" }]))).unwrap_err().to_string();
        assert!(error.contains("lastModified must be milliseconds"), "{error}");
        assert!(parse_upload_files(Some(&json!(42))).is_err());
        assert!(parse_upload_files(Some(&json!([42]))).is_err());
        assert!(parse_upload_files(None).is_err());
    }

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
        let error = check_upload("relative.txt", &roots).unwrap_err().to_string();
        assert!(error.contains("inline as { name, data }"), "{error}");
        // An existing path outside the roots gets the same way out.
        let outside = std::fs::canonicalize(env!("CARGO_MANIFEST_DIR")).unwrap();
        let error = check_upload(outside.to_str().unwrap(), &roots).unwrap_err().to_string();
        assert!(error.contains("inline as { name, data }"), "{error}");
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
