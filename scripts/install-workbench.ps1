#Requires -Version 5.1
param(
    [string] $InstallRoot = '',
    [string] $SourceRef = '',
    [switch] $DryRun,
    [switch] $NoLaunch,
    [switch] $NoShortcut
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
$nodeIndexUrl = 'https://nodejs.org/dist/index.json'
$tempRoot = Join-Path $env:TEMP ("personal-workbench-install-" + [Guid]::NewGuid().ToString('N'))
$archivePath = Join-Path $tempRoot 'workbench.zip'
$extractRoot = Join-Path $tempRoot 'source'
$runtimeRoot = Join-Path $InstallRoot '.runtime'
$runtimeNode = Join-Path $runtimeRoot 'node.exe'

function Get-NodeMajor {
    param([string] $NodePath)

    try {
        $version = (& $NodePath --version 2>$null).Trim()
    } catch {
        return -1
    }
    if ($version -notmatch '^v(\d+)') {
        return -1
    }
    return [int]$Matches[1]
}

function Get-SuitableNodePath {
    if (Test-Path -LiteralPath $runtimeNode) {
        if ((Get-NodeMajor $runtimeNode) -ge 24) {
            return $runtimeNode
        }
    }

    $systemNode = Get-Command node -ErrorAction SilentlyContinue
    if ($systemNode -and (Get-NodeMajor $systemNode.Source) -ge 24) {
        return $systemNode.Source
    }

    return $null
}

try {
    if ($env:OS -ne 'Windows_NT') {
        throw 'This installer supports Windows only.'
    }

    $nodePath = Get-SuitableNodePath

    if ($DryRun) {
        Write-Output "Source: $archiveUrl"
        Write-Output "Install: $InstallRoot"
        if ($nodePath) {
            Write-Output "Node: $nodePath (Node.js $((& $nodePath --version 2>$null).Trim()))"
        } else {
            Write-Output "Node: portable Node.js 24+ will be downloaded from $nodeIndexUrl"
        }
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
    if (-not $nodePath) {
        $architecture = [string]$env:PROCESSOR_ARCHITEW6432
        if ([string]::IsNullOrWhiteSpace($architecture)) {
            $architecture = [string]$env:PROCESSOR_ARCHITECTURE
        }
        $architecture = $architecture.ToUpperInvariant()
        switch ($architecture) {
            'AMD64' {
                $nodePlatform = 'win-x64'
                $nodePackageKey = 'win-x64-zip'
            }
            'ARM64' {
                $nodePlatform = 'win-arm64'
                $nodePackageKey = 'win-arm64-zip'
            }
            'X86' {
                $nodePlatform = 'win-x86'
                $nodePackageKey = 'win-x86-zip'
            }
            default {
                throw "Unsupported Windows processor architecture: $architecture"
            }
        }

        $nodeIndexPath = Join-Path $tempRoot 'node-index.json'
        Invoke-WebRequest -UseBasicParsing -Uri $nodeIndexUrl -OutFile $nodeIndexPath
        $releases = Get-Content -Raw -Encoding UTF8 -LiteralPath $nodeIndexPath | ConvertFrom-Json
        $release = $releases |
            Where-Object { $_.version -like 'v24.*' -and $_.files -contains $nodePackageKey } |
            Select-Object -First 1
        if (-not $release) {
            $release = $releases |
                Where-Object {
                    if ($_.version -notmatch '^v(\d+)\.') { return $false }
                    ([int]$Matches[1] -ge 24) -and ($_.files -contains $nodePackageKey)
                } |
                Select-Object -First 1
        }
        if (-not $release) {
            throw "Could not find a Node.js 24+ portable build for $nodePlatform."
        }

        $nodeArchiveName = 'node-{0}-{1}.zip' -f $release.version, $nodePlatform
        $nodeArchiveUrl = "https://nodejs.org/dist/$($release.version)/$nodeArchiveName"
        $nodeArchivePath = Join-Path $tempRoot $nodeArchiveName
        $nodeExtractRoot = Join-Path $tempRoot 'node'
        Invoke-WebRequest -UseBasicParsing -Uri $nodeArchiveUrl -OutFile $nodeArchivePath
        Expand-Archive -LiteralPath $nodeArchivePath -DestinationPath $nodeExtractRoot -Force

        $nodeSourceRoot = Get-ChildItem -LiteralPath $nodeExtractRoot -Directory -Force |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'node.exe') } |
            Select-Object -First 1
        if (-not $nodeSourceRoot) {
            throw 'The downloaded Node.js archive does not contain node.exe.'
        }

        New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
        foreach ($runtimeItem in (Get-ChildItem -LiteralPath $nodeSourceRoot.FullName -Force)) {
            $runtimeDestination = Join-Path $runtimeRoot $runtimeItem.Name
            Copy-Item -LiteralPath $runtimeItem.FullName -Destination $runtimeDestination -Recurse -Force
        }
        $nodePath = $runtimeNode
        if ((Get-NodeMajor $nodePath) -lt 24) {
            throw 'The downloaded Node.js runtime did not meet the required version.'
        }
    }

    $preservedNames = @('config.json', 'data', '.runtime')
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

    $shortcutPath = $null
    if (-not $NoShortcut) {
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
        Write-Output "Desktop shortcut: $shortcutPath"
    }

    Write-Output "Installed to $InstallRoot"

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
