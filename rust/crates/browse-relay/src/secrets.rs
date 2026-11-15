//! The relay token, in the data root and readable only by this user: every HTTP API request carries it.

use std::path::Path;

use anyhow::anyhow;

use crate::paths::{self, Paths};
use crate::util::{b64url, random_bytes};

fn valid_token(value: &str) -> bool {
    value.len() == 43 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// This install's relay token, created on first use (atomically: a concurrent creator's file wins).
pub fn relay_token(paths: &Paths) -> anyhow::Result<String> {
    let file = paths.relay_token();
    let read = |file: &Path| -> Option<String> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(file)
                && meta.permissions().mode() & 0o077 != 0 {
                    let _ = std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600));
                }
        }
        std::fs::read_to_string(file).ok().map(|text| text.trim().to_string())
    };
    if let Some(existing) = read(&file).filter(|t| valid_token(t)) {
        return Ok(existing);
    }
    let token = b64url(&random_bytes::<32>());
    let temporary = file.with_extension(format!("{}.tmp", crate::util::random_hex(6)));
    paths::write_private(&temporary, format!("{token}\n").as_bytes())?;
    let linked = std::fs::hard_link(&temporary, &file);
    if linked.is_err() {
        if read(&file).is_some_and(|t| valid_token(&t)) {
            let _ = std::fs::remove_file(&temporary);
        } else {
            std::fs::rename(&temporary, &file)?;
        }
    } else {
        let _ = std::fs::remove_file(&temporary);
    }
    read(&file).filter(|t| valid_token(t)).ok_or_else(|| anyhow!("Could not create {}", file.display()))
}

/// Site secrets were removed in browse 0.0.17: delete what earlier versions stored (site secrets, secret profiles).
pub fn remove_stored_secrets(paths: &Paths) {
    for folder in ["site-secrets", "secrets"] {
        let _ = std::fs::remove_dir_all(paths.data.join(folder));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_token_is_stable() {
        let paths = Paths::rooted(std::env::temp_dir().join(format!("browse-relay-token-{}", crate::util::random_hex(6))));
        let first = relay_token(&paths).unwrap();
        assert_eq!(first, relay_token(&paths).unwrap());
        assert_eq!(first.len(), 43);
        let _ = std::fs::remove_dir_all(&paths.data);
    }

    #[test]
    fn leftover_secrets_are_deleted() {
        let paths = Paths::rooted(std::env::temp_dir().join(format!("browse-relay-old-secrets-{}", crate::util::random_hex(6))));
        std::fs::create_dir_all(paths.data.join("site-secrets")).unwrap();
        std::fs::write(paths.data.join("site-secrets/github.json"), "{}").unwrap();
        remove_stored_secrets(&paths);
        assert!(!paths.data.join("site-secrets").exists());
        let _ = std::fs::remove_dir_all(&paths.data);
    }
}
