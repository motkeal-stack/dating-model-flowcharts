param(
    [string]$FlowId
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$port = 3210

function Test-StudioServer {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Resolve-ChromePath {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    ) | Where-Object { $_ -and (Test-Path $_) }

    return $candidates | Select-Object -First 1
}

function Ensure-Build {
    if ((Test-Path (Join-Path $root "dist\server\index.js")) -and (Test-Path (Join-Path $root "dist\web\flow-studio.js"))) {
        return
    }

    Write-Host "Building Flow Studio..."
    Push-Location $root
    try {
        npm run build
    } finally {
        Pop-Location
    }
}

if (-not (Test-StudioServer)) {
    Ensure-Build

    Write-Host "Starting Flow Studio server on port $port..."
    Start-Process -FilePath node -ArgumentList "dist/server/index.js" -WorkingDirectory $root -WindowStyle Minimized | Out-Null

    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        Start-Sleep -Seconds 1
        if (Test-StudioServer) {
            break
        }
    }

    if (-not (Test-StudioServer)) {
        Write-Host "Flow Studio did not start on port $port."
        exit 1
    }
}

$url = "http://127.0.0.1:$port/"
if (-not [string]::IsNullOrWhiteSpace($FlowId)) {
    $url = "$url?flowId=$([Uri]::EscapeDataString($FlowId))"
}

$chromePath = Resolve-ChromePath
if ($chromePath) {
    Start-Process -FilePath $chromePath -ArgumentList $url | Out-Null
} else {
    Start-Process $url | Out-Null
}

Write-Host "Flow Studio URL: $url"
Write-Host "Tip: run open_studio.bat דייטינג to open a specific flow immediately."
