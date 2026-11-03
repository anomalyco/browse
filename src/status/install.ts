// The one-line Browse installers (served at opencode.ai/browse/install and install.ps1). This browser's own computer
// gets the line for its system; another computer's relay is usually a Mac or Linux box, so it gets the shell one.
const SHELL = "curl -fsSL https://opencode.ai/browse/install | sh"
const POWERSHELL = "irm https://opencode.ai/browse/install.ps1 | iex"

export const windows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)

/** Installs Browse on this computer. */
export const installCommand = windows ? POWERSHELL : SHELL

/** Installs Browse on another computer and opens its relay to this one. */
export const remoteInstallCommand = `${SHELL} -s -- --remote`
