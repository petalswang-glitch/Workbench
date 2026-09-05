$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot 'config.json'

if (-not (Test-Path -LiteralPath $configPath)) {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Choose a folder for Personal Workbench data'
    $dialog.ShowNewFolderButton = $true
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
    $config = @{ dataDir = $dialog.SelectedPath; port = 47821 } | ConvertTo-Json
    [System.IO.File]::WriteAllText($configPath, $config, (New-Object System.Text.UTF8Encoding($false)))
}

$bundledNode = Join-Path $projectRoot '.runtime\node.exe'
$nodePath = $null
if (Test-Path -LiteralPath $bundledNode) {
    try {
        $bundledVersion = (& $bundledNode --version 2>$null).Trim()
        if ($bundledVersion -match '^v(\d+)' -and [int]$Matches[1] -ge 24) {
            $nodePath = $bundledNode
        }
    } catch {}
}
if (-not $nodePath) {
    $systemNode = Get-Command node -ErrorAction SilentlyContinue
    if ($systemNode) {
        try {
            $systemVersion = (& $systemNode.Source --version 2>$null).Trim()
            if ($systemVersion -match '^v(\d+)' -and [int]$Matches[1] -ge 24) {
                $nodePath = $systemNode.Source
            }
        } catch {}
    }
}
if (-not $nodePath) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show('Node.js 24 or later was not found.', 'Personal Workbench') | Out-Null
    exit 1
}

$configValue = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$address = "http://127.0.0.1:$($configValue.port)"
$portOccupied = $false
try {
    $health = Invoke-RestMethod "$address/api/health" -TimeoutSec 1
    if ($health.ok -and $health.app -eq 'personal-workbench' -and ([System.IO.Path]::GetFullPath($health.dataDir) -eq [System.IO.Path]::GetFullPath($configValue.dataDir))) {
        Start-Process $address
        exit 0
    }
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show("Port $($configValue.port) is already used by another service or workbench.", 'Personal Workbench') | Out-Null
    exit 1
} catch {
    $tcp = New-Object System.Net.Sockets.TcpClient
    try { $tcp.Connect('127.0.0.1', [int]$configValue.port); $portOccupied = $true } catch {} finally { $tcp.Dispose() }
}
if ($portOccupied) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show("Port $($configValue.port) is already in use. Close that program and try again.", 'Personal Workbench') | Out-Null
    exit 1
}

Set-Location -LiteralPath $projectRoot
& $nodePath (Join-Path $projectRoot 'src\server.js')
if ($LASTEXITCODE -ne 0) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show('Personal Workbench could not start. Check the launcher window for details.', 'Personal Workbench') | Out-Null
}
