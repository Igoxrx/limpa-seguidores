# Gera dist/limpa-seguidores-v<versão>.zip a partir da pasta da extensão.
# A versão vem do manifest.json. Os caminhos usam "/" para o .zip abrir certo também no Mac.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$src = Join-Path $PSScriptRoot 'limpa-seguidores'
$version = (Get-Content (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json).version
$dist = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$zipPath = Join-Path $dist "limpa-seguidores-v$version.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath }

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  foreach ($f in Get-ChildItem $src -File) {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, "limpa-seguidores/$($f.Name)") | Out-Null
  }
} finally {
  $zip.Dispose()
}
Write-Output $zipPath
