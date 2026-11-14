import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { dataRoot } from "../paths.ts"

/**
 * Delete the credential folders of removed features (site secrets and captured secret profiles) so no orphaned
 * values stay on disk. Idempotent, and never throws: startup must not be blocked by a folder it cannot remove.
 */
export function removeStoredSecrets(home = os.homedir()): void {
  for (const folder of ["site-secrets", "secrets"]) {
    try {
      fs.rmSync(path.join(dataRoot(home), folder), { recursive: true, force: true })
    } catch {
      // A locked or read-only file stays; the next start tries again.
    }
  }
}
