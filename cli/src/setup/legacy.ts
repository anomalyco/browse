// The folders earlier browse layouts used, kept in their own light module: main.ts checks them on every start, and the
// execute file guard denies them, so neither should pull in the migration module (and its JSON/TOML/YAML parsers).
import os from "node:os"
import path from "node:path"

/** The old data root, which followed XDG_DATA_HOME on unix and LOCALAPPDATA on Windows. */
export function legacyDataRoot(home = os.homedir()): string {
  if (home !== os.homedir()) return path.join(home, ".local", "share", "opencode-browser")
  if (process.platform === "win32") {
    const configured = process.env.LOCALAPPDATA
    return path.join(configured && path.isAbsolute(configured) ? configured : path.join(home, "AppData", "Local"), "opencode-browser")
  }
  const configured = process.env.XDG_DATA_HOME
  return path.join(configured && path.isAbsolute(configured) ? configured : path.join(home, ".local", "share"), "opencode-browser")
}

/** Roots earlier layouts kept browse's files in; migration copies them into the XDG folders on the next run. */
export function legacyRoots(home = os.homedir()): readonly string[] {
  return [path.join(home, ".browse"), legacyDataRoot(home)]
}
