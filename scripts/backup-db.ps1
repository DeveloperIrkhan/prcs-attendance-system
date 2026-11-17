# Dumps the database named in .env to backups/attendance-<timestamp>.dump
# Usage: npm run backup    (or: powershell -File scripts/backup-db.ps1)
# Requires pg_dump (PostgreSQL client tools) on PATH.

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env"

if (-not (Test-Path $envFile)) { throw ".env not found at $envFile" }

$line = Get-Content $envFile |
    Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } |
    Select-Object -First 1

if (-not $line) { throw "DATABASE_URL is missing from .env" }

$url = ($line -split "=", 2)[1].Trim().Trim('"').Trim("'")
$outDir = Join-Path $root "backups"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $outDir "attendance-$stamp.dump"

& pg_dump --format=custom --no-owner --dbname $url --file $out

if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }

Write-Host "Backup written to $out"
