# clones the data layer and reference repos next to this project. idempotent.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$repos = [ordered]@{
  'ManifestHub3'     = 'https://github.com/steamtools-games/ManifestHub3'
  'ManifestHub'      = 'https://github.com/trionine/ManifestHub'
  'BetterSteamTools' = 'https://github.com/madoiscool/BetterSteamTools'
  # OpenSteam001/OpenSteamTool is a contract reference, not something the app reads at runtime, so
  # it is not cloned here. Fetch the pinned commit when you need it:
  #   git clone https://github.com/OpenSteam001/OpenSteamTool && git -C OpenSteamTool checkout 2a08b0b
  'luatools'         = 'https://github.com/Juanloaiza25/luatools'
  'Fluent-Steam-Lua' = 'https://github.com/huanyuejue/Fluent-Steam-Lua'
  'Millennium'       = 'https://github.com/reindex-ot/Millennium'
}

Write-Host "bootstrap  $root"
foreach ($name in $repos.Keys) {
  $target = Join-Path $root $name
  $url = $repos[$name]
  if (Test-Path (Join-Path $target '.git')) {
    Write-Host ("  skip    {0,-18} already cloned" -f $name)
    continue
  }
  if (Test-Path $target) {
    Write-Host ("  skip    {0,-18} path exists, not a git repo" -f $name)
    continue
  }
  try {
    git clone --depth 1 $url $target 2>&1 | Out-Null
    $head = git -C $target rev-parse --short HEAD
    Write-Host ("  cloned  {0,-18} {1}" -f $name, $head)
  } catch {
    Write-Host ("  FAILED  {0,-18} {1}" -f $name, $_.Exception.Message)
  }
}

Write-Host ''
Write-Host 'next: npm run drift     # pin DLL hashes and repo heads'
