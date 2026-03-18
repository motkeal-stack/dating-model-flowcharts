param(
    [string]$Path
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$port = 8080

function Test-ViewerServer {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$port/viewer.html" -TimeoutSec 2
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Get-PythonCommand {
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) {
        return @{
            FilePath = $python.Source
            Arguments = @("-m", "http.server", "$port")
        }
    }

    $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($pyLauncher) {
        return @{
            FilePath = $pyLauncher.Source
            Arguments = @("-3", "-m", "http.server", "$port")
        }
    }

    return $null
}

function Resolve-TargetFile([string]$InputPath) {
    if ([string]::IsNullOrWhiteSpace($InputPath)) {
        $defaultDiagram = Get-ChildItem -LiteralPath $root -Filter *.mmd -File | Sort-Object Name | Select-Object -First 1
        if ($defaultDiagram) {
            return $defaultDiagram.Name
        }

        return "diagram.mmd"
    }

    $fullPath = $InputPath
    if (-not [IO.Path]::IsPathRooted($fullPath)) {
        $fullPath = Join-Path $root $fullPath
    }

    try {
        $fullPath = [IO.Path]::GetFullPath($fullPath)
    } catch {
        return [IO.Path]::GetFileName($InputPath)
    }

    $normalizedRoot = [IO.Path]::GetFullPath($root)
    if ($fullPath.StartsWith($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        $relative = $fullPath.Substring($normalizedRoot.Length).TrimStart("\")
        if (-not [string]::IsNullOrWhiteSpace($relative)) {
            return ($relative -replace "\\", "/")
        }
    }

    return [IO.Path]::GetFileName($fullPath)
}

function Resolve-ChromePath {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    ) | Where-Object { $_ -and (Test-Path $_) }

    return $candidates | Select-Object -First 1
}

if (-not (Test-ViewerServer)) {
    $pythonCommand = Get-PythonCommand
    if (-not $pythonCommand) {
        Write-Host "Could not find Python on PATH."
        exit 1
    }

    Write-Host "Starting local HTTP server on port $port..."
    Start-Process -FilePath $pythonCommand.FilePath -ArgumentList $pythonCommand.Arguments -WorkingDirectory $root -WindowStyle Minimized | Out-Null

    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        Start-Sleep -Seconds 1
        if (Test-ViewerServer) {
            break
        }
    }

    if (-not (Test-ViewerServer)) {
        Write-Host "Could not start the local viewer server on port $port."
        exit 1
    }
}

$targetFile = Resolve-TargetFile $Path
$viewerUrl = "http://localhost:$port/viewer.html?file=$([Uri]::EscapeDataString($targetFile))"
$chromePath = Resolve-ChromePath

if ($chromePath) {
    Write-Host "Opening $targetFile in Chrome..."
    Start-Process -FilePath $chromePath -ArgumentList $viewerUrl | Out-Null
} else {
    Write-Host "Chrome was not found automatically. Opening in the default browser instead..."
    Start-Process $viewerUrl | Out-Null
}

Write-Host "Viewer URL: $viewerUrl"
Write-Host "Tip: You can drag any .mmd file onto open_viewer.bat to open it directly."
