/** A path, raw CDP parameter or refused API that execute code may not use. */
export class ExecuteFileAccessError extends Error {
  override readonly name = "ExecuteFileAccessError"
}
