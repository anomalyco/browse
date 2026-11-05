# Installs browse on Windows: downloads the browse binary for this computer into ~\.browse\bin, then hands over to
# `browse install`, which does the rest (PATH, your agents, pairing with your browser). Served at
# https://opencode.ai/browse/install.ps1; the PowerShell twin of ./install.
#
#   irm https://opencode.ai/browse/install.ps1 | iex
#
# `irm | iex` can't take arguments. To pass some, run the script as a script block:
#
#   & ([scriptblock]::Create((irm https://opencode.ai/browse/install.ps1))) --remote
#   & ([scriptblock]::Create((irm https://opencode.ai/browse/install.ps1))) --version 0.0.7 --agent claude
#
# or set them in the environment first: $env:VERSION = "0.0.7"; $env:BROWSE_CHANNEL = "dev"
#
# Options:
#   -h, --help              Show this help
#   -v, --version <version> Install a specific version (or $env:VERSION)
#       --channel <tag>     Install the latest version on an npm tag: latest or dev (or $env:BROWSE_CHANNEL)
#   -b, --binary <path>     Install from a local browse.exe instead of downloading
#       --no-setup          Only install the binary; don't run `browse install`
# Anything else goes to `browse install`, e.g. --remote, --agent claude or --no-modify-path.

function Install-browse {
    param([string[]]$Arguments)
    # Everything runs in this function so a failure stops it without closing the window `irm | iex` runs in.
    $ErrorActionPreference = "Stop"
    $ProgressPreference = "SilentlyContinue"

    $requested = $env:VERSION
    $channel = if ($env:BROWSE_CHANNEL) { $env:BROWSE_CHANNEL } else { "latest" }
    $binary = $null
    $noSetup = $false
    $setupArgs = @()

    for ($i = 0; $i -lt $Arguments.Count; $i++) {
        $arg = [string]$Arguments[$i]
        switch -Regex ($arg) {
            "^(-h|--help|-Help)$" {
                Write-Host @"
browse installer

Usage:
  irm https://opencode.ai/browse/install.ps1 | iex
  & ([scriptblock]::Create((irm https://opencode.ai/browse/install.ps1))) [options] [browse install options]

Options:
  -h, --help              Show this help
  -v, --version <version> Install a specific version (e.g., 0.0.7), or set `$env:VERSION
      --channel <tag>     Install the latest version on an npm tag (latest or dev), or set `$env:BROWSE_CHANNEL
  -b, --binary <path>     Install from a local browse.exe instead of downloading
      --no-setup          Only install the binary; don't run ``browse install``

Anything else goes to ``browse install``, e.g. --remote, --agent claude or --no-modify-path.
"@
                return
            }
            "^(-v|--version|-Version)$" {
                if ($i + 1 -ge $Arguments.Count) { throw "--version requires a version argument" }
                $requested = [string]$Arguments[++$i]
                continue
            }
            "^(--channel|-Channel)$" {
                if ($i + 1 -ge $Arguments.Count) { throw "--channel requires a tag" }
                $channel = [string]$Arguments[++$i]
                continue
            }
            "^(-b|--binary|-Binary)$" {
                if ($i + 1 -ge $Arguments.Count) { throw "--binary requires a path argument" }
                $binary = [string]$Arguments[++$i]
                continue
            }
            "^(--no-setup|-NoSetup)$" {
                $noSetup = $true
                continue
            }
            default { $setupArgs += $arg }
        }
    }

    # Windows PowerShell 5.1 may still default to TLS 1.0, which the npm registry refuses.
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

    $installDir = Join-Path $env:USERPROFILE ".browse\bin"
    $exe = Join-Path $installDir "browse.exe"
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null

    $tmp = Join-Path ([IO.Path]::GetTempPath()) "browse_install_$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
        if ($binary) {
            if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "Binary not found at $binary" }
            Write-Host ""
            Write-Host "Installing browse from: $binary"
            $source = (Resolve-Path -LiteralPath $binary).Path
        } else {
            $arch = $null
            try { $arch = [string][System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture } catch {}
            if (-not $arch) { $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE } }
            $target = switch -Regex ($arch) {
                "^(X64|AMD64)$" { "x64" }
                # Windows on ARM runs the x64 build under emulation; the baseline build doesn't need AVX2.
                "^(Arm64|ARM64)$" { "x64-baseline" }
                default { throw "Unsupported architecture: $arch. browse runs on 64-bit Windows." }
            }
            if ($target -eq "x64") {
                $avx2 = $false
                try {
                    $avx2 = (Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)
                } catch {}
                if (-not $avx2) { $target = "x64-baseline" }
            }

            $package = "@opencode/browse-windows-$target"
            $encoded = "@opencode%2fbrowse-windows-$target"
            if (-not $requested) {
                try { $version = (Invoke-RestMethod -UseBasicParsing "https://registry.npmjs.org/$encoded/$channel").version } catch { $version = $null }
                if (-not $version) { throw "Failed to fetch the latest browse version for windows-$target" }
            } else {
                $version = $requested -replace "^v", ""
                try { Invoke-RestMethod -UseBasicParsing "https://registry.npmjs.org/$encoded/$version" | Out-Null }
                catch {
                    $status = $null
                    try { $status = [int]$_.Exception.Response.StatusCode } catch {}
                    if ($status -eq 404) { throw "browse $version is not available for windows-$target. Available versions: https://www.npmjs.com/package/${package}?activeTab=versions" }
                    throw "Failed to fetch package information: $($_.Exception.Message)"
                }
            }

        }

        $download = {
            $filename = "browse-windows-$target-$version.tgz"
            $archive = Join-Path $tmp $filename
            Write-Host ""
            Write-Host "Installing browse version: $version"
            Invoke-WebRequest -UseBasicParsing -Uri "https://registry.npmjs.org/$package/-/$filename" -OutFile $archive

            # Windows 10 and later ship bsdtar as System32\tar.exe; another tar on PATH (Git's) can't read C:\ paths.
            $tar = Join-Path $env:SystemRoot "System32\tar.exe"
            if (-not (Test-Path -LiteralPath $tar)) { $tar = "tar.exe" }
            & $tar -xzf $archive -C $tmp
            if ($LASTEXITCODE -ne 0) { throw "Could not extract $filename" }
            $source = Join-Path $tmp "package\bin\browse.exe"
            if (-not (Test-Path -LiteralPath $source)) { throw "$filename has no package\bin\browse.exe" }
        }
        if (-not $binary) {
            foreach ($delay in 0, 15, 30, 60, 75) {
                if ($delay) {
                    Write-Warning "The $version tarball isn't available yet; retrying in ${delay}s."
                    Start-Sleep -Seconds $delay
                }
                try { . $download; break } catch {
                    $response = $_.Exception.Response
                    if ([int]$response.StatusCode -ne 404) { throw }
                    if ($delay -ne 75) { continue }
                    if ($requested -or $channel -notin 'latest', 'dev') { throw }
                    # Windows PowerShell uses HttpWebResponse; PowerShell Core uses HttpResponseMessage.
                    $uri = if ($response.ResponseUri) { $response.ResponseUri } else { $response.RequestMessage.RequestUri }
                    $versions = (Invoke-RestMethod -UseBasicParsing ([uri]::new($uri, "/$encoded"))).versions.PSObject.Properties.Name
                    $pattern = if ($channel -eq 'dev') { '^\d+\.\d+\.\d+-dev\.\d+(\.\d+)?$' } else { '^\d+\.\d+\.\d+$' }
                    $ordered = @($versions | Where-Object { $_ -match $pattern } | Sort-Object -Descending -Property { [version]($_ -split '-')[0] }, { [long]($_ -split '\.')[3] }, { [long]($_ -split '\.')[4] })
                    $index = [array]::IndexOf($ordered, $version)
                    if ($index -lt 0 -or $index + 1 -ge $ordered.Count) { throw }
                    $previous = $ordered[$index + 1]
                    Write-Warning "browse $version is still unavailable; falling back to $previous ($channel)."
                    $version = $previous
                    . $download
                }
            }
        }

        # A running browse.exe (the relay) can't be overwritten, but it can be renamed: move it aside, then put the new
        # one in its place. Copies moved aside earlier are deleted once nothing runs them.
        Get-ChildItem -LiteralPath $installDir -Filter "browse.exe.old-*" -ErrorAction SilentlyContinue | ForEach-Object {
            Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
        }
        $staged = "$exe.new"
        Copy-Item -LiteralPath $source -Destination $staged -Force
        if (Test-Path -LiteralPath $exe) {
            Move-Item -LiteralPath $exe -Destination "$exe.old-$([Guid]::NewGuid().ToString('N').Substring(0, 8))" -Force
        }
        Move-Item -LiteralPath $staged -Destination $exe -Force
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    if ($noSetup) {
        Write-Host ""
        Write-Host "Run $exe install to add browse to your agents and pair it with your browser."
        return
    }
    Write-Host ""
    & $exe install @setupArgs
}

try {
    Install-browse -Arguments $args
} catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    $global:LASTEXITCODE = 1
}
