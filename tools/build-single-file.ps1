# Builds the entire game into ONE self-contained .html file that runs by
# double-clicking (file://) — no server, no zip, no script files, so mail
# providers won't block it. Three.js still loads from the CDN import map,
# and the AI ground texture is embedded as a base64 data URI.
# Usage: powershell -ExecutionPolicy Bypass -File tools/build-single-file.ps1
param([string]$OutName = '1776-game.html')

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# Modules concatenated in dependency order (imports/exports stripped; they
# all share one module scope, so top-level names are kept globally unique)
$moduleOrder = @(
  'src/core/assets.js',
  'src/world/terrain.js',
  'src/world/colliders.js',
  'src/world/world.js',
  'src/world/weather.js',
  'src/world/debris.js',
  'src/systems/particles.js',
  'src/systems/audio.js',
  'src/entities/ragdoll.js',
  'src/entities/player.js',
  'src/entities/tank.js',
  'src/entities/enemy.js',
  'src/systems/weapon.js',
  'src/systems/waves.js',
  'src/systems/ui.js',
  'src/core/input.js',
  'src/core/camera.js',
  'src/main.js'
)

$js = New-Object System.Text.StringBuilder
[void]$js.AppendLine("import * as THREE from 'three';")

# Embed the AI ground texture
$texPath = Join-Path $root 'assets/ground_grass.png'
if (Test-Path $texPath) {
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($texPath))
  [void]$js.AppendLine("const GROUND_B64 = 'data:image/png;base64,$b64';")
}

foreach ($rel in $moduleOrder) {
  $code = [IO.File]::ReadAllText((Join-Path $root $rel))
  $code = [regex]::Replace($code, '(?m)^\s*import\s[^;]*;\s*$', '')   # drop imports
  $code = [regex]::Replace($code, '(?m)^export\s+', '')               # drop export keywords
  [void]$js.AppendLine("// ===== $rel =====")
  [void]$js.AppendLine($code)
}

$css = [IO.File]::ReadAllText((Join-Path $root 'src/style.css'))

# Lift the HUD/overlay markup out of index.html's body
$indexHtml = [IO.File]::ReadAllText((Join-Path $root 'index.html'))
$m = [regex]::Match($indexHtml, '(?s)<body>(.*?)<script')
if (-not $m.Success) { throw 'Could not extract body markup from index.html' }
$bodyMarkup = $m.Groups[1].Value

$importmap = @'
  <script type="importmap">
    {
      "imports": {
        "three": "https://cdn.jsdelivr.net/npm/three@0.166.1/build/three.module.js"
      }
    }
  </script>
'@

$doc = New-Object System.Text.StringBuilder
[void]$doc.AppendLine('<!DOCTYPE html>')
[void]$doc.AppendLine('<html lang="en">')
[void]$doc.AppendLine('<head>')
[void]$doc.AppendLine('  <meta charset="UTF-8" />')
[void]$doc.AppendLine('  <meta name="viewport" content="width=device-width, initial-scale=1.0" />')
[void]$doc.AppendLine('  <title>1776</title>')
[void]$doc.AppendLine($importmap)
[void]$doc.AppendLine('  <style>')
[void]$doc.AppendLine($css)
[void]$doc.AppendLine('  </style>')
[void]$doc.AppendLine('</head>')
[void]$doc.AppendLine('<body>')
[void]$doc.AppendLine($bodyMarkup)
[void]$doc.AppendLine('<script type="module">')
[void]$doc.AppendLine($js.ToString())
[void]$doc.AppendLine('</script>')
[void]$doc.AppendLine('</body>')
[void]$doc.AppendLine('</html>')

$outPath = Join-Path $root $OutName
[IO.File]::WriteAllText($outPath, $doc.ToString(), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Built $outPath ($([math]::Round((Get-Item $outPath).Length / 1MB, 2)) MB)"
