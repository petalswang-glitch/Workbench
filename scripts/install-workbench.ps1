#Requires -Version 5.1
param(
    [string] $InstallRoot = '',
    [string] $SourceRef = '',
    [switch] $DryRun,
    [switch] $NoLaunch
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Join-Path $env:LOCALAPPDATA 'PersonalWorkbench'
}
if ([string]::IsNullOrWhiteSpace($SourceRef)) {
    $SourceRef = 'main'
}

$repoOwner = 'petalswang-glitch'
$repoName = 'Workbench'
$archiveUrl = "https://github.com/$repoOwner/$repoName/archive/refs/heads/$SourceRef.zip"
$tempRoot = Join-Path $env:TEMP ("personal-workbench-install-" + [Guid]::NewGuid().ToString('N'))
$archivePath = Join-Path $tempRoot 'workbench.zip'
$extractRoot = Join-Path $tempRoot 'source'

try {
    if ($env:OS -ne 'Windows_NT') {
        throw 'This installer supports Windows only.'
    }

    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
        throw 'Node.js 24 or later is required. Install it from https://nodejs.org/ and run this installer again.'
    }

    $nodeVersion = (& $nodeCommand.Source --version 2>$null).Trim()
    if ($nodeVersion -notmatch '^v(\d+)') {
        throw 'Could not determine the installed Node.js version.'
    }
    $nodeMajor = [int]$Matches[1]
    if ($nodeMajor -lt 24) {
        throw "Node.js 24 or later is required. Found $nodeVersion."
    }

    if ($DryRun) {
        Write-Output "Source: $archiveUrl"
        Write-Output "Install: $InstallRoot"
        Write-Output 'Dry run complete. No files were changed.'
        return
    }

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    } catch {
        # Windows PowerShell versions with a fixed TLS policy can continue here.
    }

    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    Invoke-WebRequest -UseBasicParsing -Uri $archiveUrl -OutFile $archivePath
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force

    $sourceRoot = Get-ChildItem -LiteralPath $extractRoot -Directory -Force |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') } |
        Select-Object -First 1
    if (-not $sourceRoot) {
        throw 'The downloaded archive does not contain a valid Workbench source tree.'
    }

    $launcher = Get-ChildItem -LiteralPath $sourceRoot.FullName -Filter '*.vbs' -File -Force |
        Select-Object -First 1
    if (-not $launcher) {
        throw 'The downloaded archive does not contain a startup script.'
    }

    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    $preservedNames = @('config.json', 'data')
    foreach ($item in (Get-ChildItem -LiteralPath $sourceRoot.FullName -Force)) {
        if ($preservedNames -contains $item.Name) {
            continue
        }
        $destination = Join-Path $InstallRoot $item.Name
        Copy-Item -LiteralPath $item.FullName -Destination $destination -Recurse -Force
    }

    $installedLauncher = Join-Path $InstallRoot $launcher.Name
    $wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
    if (-not (Test-Path -LiteralPath $wscript)) {
        throw 'Windows Script Host was not found.'
    }

    $desktop = [Environment]::GetFolderPath('Desktop')
    $shortcutPath = Join-Path $desktop 'Personal Workbench.lnk'
    $icon = Get-ChildItem -LiteralPath $InstallRoot -Filter '*.ico' -File -Force |
        Select-Object -First 1

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $wscript
    $shortcut.Arguments = '"' + $installedLauncher + '"'
    $shortcut.WorkingDirectory = $InstallRoot
    $shortcut.Description = 'Personal Workbench'
    if ($icon) {
        $shortcut.IconLocation = $icon.FullName + ',0'
    }
    $shortcut.Save()

    Write-Output "Installed to $InstallRoot"
    Write-Output "Desktop shortcut: $shortcutPath"

    if (-not $NoLaunch) {
        Start-Process -FilePath $wscript -ArgumentList ('"' + $installedLauncher + '"') -WorkingDirectory $InstallRoot
    }
} catch {
    throw ("Personal Workbench installation failed: " + $_.Exception.Message)
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
