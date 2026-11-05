# Opt-in Windows integration test. HKCU is shared even under a temporary HOME. Run on a test machine:
#   powershell -File test/windows-user-path.ps1 -AllowUserPathEdit -Bun C:\path\to\bun.exe
param([switch]$AllowUserPathEdit, [string]$Bun = 'bun.exe')
$ErrorActionPreference = 'Stop'
if (!$AllowUserPathEdit) { throw 'This test temporarily changes the real user PATH; pass -AllowUserPathEdit to opt in.' }
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
function ReadRaw { $key.GetValue('Path', $null, 'DoNotExpandEnvironmentNames') }
$before = ReadRaw
$kind = if ($null -ne $before) { $key.GetValueKind('Path') }
$backup = Join-Path $env:TEMP 'browse-user-path-backup.xml'
if (Test-Path $backup) { throw "An earlier backup exists at $backup; check it before testing." }
@{ Value = $before; Kind = $kind } | Export-Clixml $backup
$work = Join-Path $env:TEMP ([Guid]::NewGuid().ToString('N'))
Push-Location (Join-Path $PSScriptRoot '..')
try {
  $raw = "$before;%USERPROFILE%\browse-fixture;;"
  $env:GITHUB_ACTIONS = 'false'
  foreach ($name in 'plain', "Jane O'Neil") {
    $key.SetValue('Path', $raw, 'ExpandString')
    $dir = (New-Item -ItemType Directory -Force (Join-Path $work $name)).FullName
    $env:BROWSE_TEST_EXE = Join-Path $dir 'browse.exe'
    $setup = "import { addToPath, removeBinaryInstall } from './src/setup/binary.ts'; Object.defineProperty(process,'execPath',{value:process.env.BROWSE_TEST_EXE});"
    & $Bun -e "$setup addToPath()"
    if ($LASTEXITCODE -or (ReadRaw) -cne "$raw;$dir" -or $key.GetValueKind('Path') -ne 'ExpandString') { throw "Adding $name changed the raw entries/type or missed the directory" }
    & $Bun -e "$setup removeBinaryInstall(process.execPath)"
    if ($LASTEXITCODE -or (ReadRaw) -cne $raw -or $key.GetValueKind('Path') -ne 'ExpandString') { throw "Removing $name did not round-trip the raw PATH" }
  }
} finally {
  Pop-Location
  if ($null -eq $before) { $key.DeleteValue('Path', $false) } else { $key.SetValue('Path', $before, $kind) }
  if ((ReadRaw) -cne $before -or ($null -ne $before -and $key.GetValueKind('Path') -ne $kind)) { throw "Restore failed; backup: $backup" }
  Add-Type -Namespace BrowseTest -Name Env -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, UIntPtr w, string l, uint flags, uint ms, out UIntPtr result);'
  $result = [UIntPtr]::Zero
  [void][BrowseTest.Env]::SendMessageTimeout([IntPtr]65535, 26, [UIntPtr]::Zero, 'Environment', 2, 500, [ref]$result)
  $key.Close()
  Remove-Item -LiteralPath $backup
  if (Test-Path $work) { Remove-Item -LiteralPath $work -Recurse -Force }
  'Verified restoration of the original user PATH (raw value and kind).'
}
