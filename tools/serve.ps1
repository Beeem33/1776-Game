# Minimal static file server (no Node/Python needed).
# Serves the game folder (parent of this script) over HTTP for ES modules.
# Uses HttpListener: http.sys buffers complete requests, so browser
# preconnect sockets can't stall the loop.
# Usage: powershell -ExecutionPolicy Bypass -File tools/serve.ps1 -Port 7761
param([int]$Port = 7761)

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Write-Host "Serving $root at http://localhost:$Port/"

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.gif'  = 'image/gif'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.mp3'  = 'audio/mpeg'
  '.wav'  = 'audio/wav'
  '.ogg'  = 'audio/ogg'
  '.glb'  = 'model/gltf-binary'
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
# Also answer on the loopback IP so http://127.0.0.1:PORT links work
try { $listener.Prefixes.Add("http://127.0.0.1:$Port/") } catch { }
try {
  $listener.Start()
} catch {
  # If the extra prefix is refused by http.sys, fall back to localhost only
  $listener = [System.Net.HttpListener]::new()
  $listener.Prefixes.Add("http://localhost:$Port/")
  $listener.Start()
}
Write-Host "Ready."

while ($listener.IsListening) {
  try {
    $context = $listener.GetContext()
    $req = $context.Request
    $res = $context.Response

    $path = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($path -eq '/') { $path = '/index.html' }

    $fsPath = [System.IO.Path]::GetFullPath((Join-Path $root ($path -replace '/', '\').TrimStart('\')))

    if (-not $fsPath.StartsWith($root)) {
      $res.StatusCode = 403
      $body = [System.Text.Encoding]::UTF8.GetBytes('Forbidden')
      $res.ContentType = 'text/plain'
    }
    elseif (Test-Path $fsPath -PathType Leaf) {
      $res.StatusCode = 200
      $body = [System.IO.File]::ReadAllBytes($fsPath)
      $ext = [System.IO.Path]::GetExtension($fsPath).ToLower()
      $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
    }
    else {
      $res.StatusCode = 404
      $body = [System.Text.Encoding]::UTF8.GetBytes("404: $path")
      $res.ContentType = 'text/plain'
    }

    $res.Headers.Add('Cache-Control', 'no-cache')
    $res.ContentLength64 = $body.Length
    $res.OutputStream.Write($body, 0, $body.Length)
    $res.OutputStream.Close()
  }
  catch {
    Write-Host "Request error: $_"
  }
}
