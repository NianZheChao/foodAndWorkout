# 把本仓库 skills/ 下的技能安装到 Codex 技能目录。
# 用法：powershell -ExecutionPolicy Bypass -File install-skills.ps1
$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot 'skills'
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$dest = Join-Path $codexHome 'skills'

if (-not (Test-Path -LiteralPath $source)) { throw "找不到 skills/ 目录：$source" }
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$destFull = [System.IO.Path]::GetFullPath($dest)
$count = 0

foreach ($dir in [System.IO.Directory]::GetDirectories($source)) {
    if (-not (Test-Path -LiteralPath (Join-Path $dir 'SKILL.md'))) { continue }
    $name = [System.IO.Path]::GetFileName($dir)
    $targetFull = [System.IO.Path]::GetFullPath((Join-Path $destFull $name))
    # 只在目标确实位于技能目录内时才删除，避免误删
    if (-not $targetFull.StartsWith($destFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝写入技能目录之外的路径：$targetFull"
    }
    if (Test-Path -LiteralPath $targetFull) { Remove-Item -LiteralPath $targetFull -Recurse -Force }
    Copy-Item -LiteralPath $dir -Destination $targetFull -Recurse -Force
    Write-Host "installed $name -> $targetFull"
    $count++
}
Write-Host "done. $count 个技能已安装到 $destFull"
