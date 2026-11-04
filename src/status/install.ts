// The one-line browse installers (served at opencode.ai/browse/install and install.ps1). This browser's own computer
// gets the lines for its system; another computer's relay is usually a Mac or Linux box, so it gets the shell ones.
const SHELL = "curl -fsSL https://opencode.ai/browse/install | bash"
const POWERSHELL = "irm https://opencode.ai/browse/install.ps1 | iex"
const NPM = "npx @opencode/browse install"

const windows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)

/** One way to install browse: the word in the picker, the line to run, and what step 1 says while it's picked. */
export type InstallMethod = {
  id: string
  label: string
  command: string
  title: string
}

const TERMINAL = "Run this in your terminal"

const curl: InstallMethod = { id: "curl", label: "curl", command: SHELL, title: TERMINAL }
const powershell: InstallMethod = { id: "powershell", label: "PowerShell", command: POWERSHELL, title: "Run this in PowerShell" }
const npm: InstallMethod = { id: "npm", label: "npm", command: NPM, title: TERMINAL }
const remoteCurl: InstallMethod = { ...curl, command: `${SHELL} -s -- --remote` }
const remoteNpm: InstallMethod = { ...npm, command: `${NPM} --remote` }

/** Installs browse on this computer, the method that suits this system first. */
export const installMethods = windows ? [powershell, npm] : [curl, npm]

/** Installs browse on another computer and opens its relay to this one. */
export const remoteInstallMethods = [remoteCurl, remoteNpm]

export const installMethod = installMethods[0]!
export const remoteInstallMethod = remoteInstallMethods[0]!

/** Installs browse on this computer. */
export const installCommand = installMethod.command
