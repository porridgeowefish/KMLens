param(
  [string]$Version = "0.3.0",
  [string]$UpdateSource = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$wails = Join-Path $env:USERPROFILE "go\bin\wails.exe"
if (-not (Test-Path -LiteralPath $wails)) {
  throw "未找到 Wails CLI：$wails"
}

$nsisRoot = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA "electron-builder\Cache") `
  -Recurse -Filter makensis.exe -ErrorAction SilentlyContinue |
  Where-Object { $_.Directory.Name -ne "Bin" } |
  Select-Object -First 1 -ExpandProperty DirectoryName
if ($nsisRoot) {
  $env:PATH = "$nsisRoot;$(Join-Path $nsisRoot 'Bin');$env:PATH"
}

Push-Location $projectRoot
try {
  $linkerFlags = "-X main.appVersion=$Version"
  if ($UpdateSource) {
    $linkerFlags += " -X main.defaultUpdateSource=$UpdateSource"
  }
  & $wails build -clean -trimpath -nsis -installscope user -webview2 download `
    -ldflags $linkerFlags
  if ($LASTEXITCODE -ne 0) {
    throw "Wails 构建失败，退出码：$LASTEXITCODE"
  }

  $sourceInstaller = Join-Path $projectRoot "wails-build\bin\kmlens-amd64-installer.exe"
  if (-not (Test-Path -LiteralPath $sourceInstaller)) {
    throw "未生成安装包；请确认 NSIS 的 makensis.exe 已安装或可用"
  }

  $releaseDir = Join-Path $projectRoot "release-lite"
  New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
  $installerName = "KMLens-Setup-$Version.exe"
  $installerPath = Join-Path $releaseDir $installerName
  Copy-Item -LiteralPath $sourceInstaller -Destination $installerPath -Force
  $hash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $manifest = [ordered]@{
    version = $Version
    url = $installerName
    sha256 = $hash
    notes = "KMLens $Version"
  }
  $manifestPath = Join-Path $releaseDir "latest.json"
  [System.IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json),
    [System.Text.UTF8Encoding]::new($false)
  )

  Get-Item -LiteralPath $installerPath |
    Select-Object FullName, Length, @{Name = "MB"; Expression = { [math]::Round($_.Length / 1MB, 2) }}
  Write-Host "SHA256: $hash"
} finally {
  Pop-Location
}
