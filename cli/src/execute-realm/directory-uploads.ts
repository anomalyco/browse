import fs from "node:fs"
import path from "node:path"
import { ExecuteFileAccessError } from "./errors.ts"

/** Most entries all folder uploads in one setInputFiles/setFiles call may contain before refusal. */
export const maxDirectoryUploadEntries = 1_000

/** One entry counter for every directory path in a single setInputFiles/setFiles call. */
export type DirectoryUploadBudget = { entries: number }

/**
 * Walk a directory upload without following symlinks. Every entry goes through `check`, so the
 * existing root, ownership and browse-owned rules apply to files nested below the uploaded folder.
 */
export function checkDirectoryUpload(
  root: string,
  operation: string,
  check: (target: string, operation: string) => string,
  budget: DirectoryUploadBudget,
): void {
  let rootStat: fs.Stats
  try {
    rootStat = fs.lstatSync(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (rootStat.isSymbolicLink()) {
    throw new ExecuteFileAccessError(`${operation}: ${root} is a symlink; directory uploads cannot follow symlinks`)
  }
  if (!rootStat.isDirectory()) return
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      budget.entries += 1
      if (budget.entries > maxDirectoryUploadEntries) {
        throw new ExecuteFileAccessError(`${operation}: folder uploads are limited to ${maxDirectoryUploadEntries} files and subfolders`)
      }
      const child = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new ExecuteFileAccessError(`${operation}: ${child} is a symlink; directory uploads cannot follow symlinks`)
      }
      const resolved = check(child, operation)
      const stat = fs.lstatSync(resolved)
      if (stat.isSymbolicLink()) {
        throw new ExecuteFileAccessError(`${operation}: ${resolved} is a symlink; directory uploads cannot follow symlinks`)
      }
      if (stat.isDirectory()) pending.push(resolved)
    }
  }
}

/** Validate and rewrite the file paths in a setInputFiles/setFiles payload, walking directories. */
export function checkFileInputValue(
  value: unknown,
  method: string,
  assertPath: (target: string, operation: string) => string,
  checkEntry: (target: string, operation: string) => string,
): unknown {
  const budget: DirectoryUploadBudget = { entries: 0 }
  const check = (target: string): string => {
    const resolved = assertPath(target, method)
    checkDirectoryUpload(resolved, method, checkEntry, budget)
    return resolved
  }
  if (typeof value === "string") return check(value)
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? check(item) : item)
  return value
}
