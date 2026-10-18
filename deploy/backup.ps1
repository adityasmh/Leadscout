# backup.ps1 - timestamped SQLite backup of the Leadscout database.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File products\leadscout\deploy\backup.ps1
#       [-DbPath <path>] [-BackupDir <dir>] [-Keep 14]
#
# Behaviour:
#   - DbPath default: env LEADSCOUT_DB, else products\leadscout\data\leadscout.db.
#   - BackupDir default: products\leadscout\backups (also overridable via
#     env LEADSCOUT_BACKUP_DIR).
#   - The copy is made with SQLite "VACUUM INTO" executed through node:sqlite
#     (no sqlite3 CLI, no dependencies).
#   - Target file is timestamped with millisecond precision (plus a race counter),
#     so the target never pre-exists; the target is only ever created in the
#     backup directory.
#   - Retention: keeps the newest 14 backup files that match this script's own
#     naming pattern (leadscout-<timestamp>.db); only those files are ever
#     removed. The live database is never deleted or overwritten.
#   - Exits non-zero on any error. Echoes no secrets.

param(
  [string]$DbPath = "",
  [string]$BackupDir = "",
  [int]$Keep = 14
)

$ErrorActionPreference = "Stop"

try {
  $root = Split-Path -Parent $PSScriptRoot  # .../products/leadscout

  if ([string]::IsNullOrWhiteSpace($DbPath)) {
    $DbPath = [Environment]::GetEnvironmentVariable("LEADSCOUT_DB")
  }
  if ([string]::IsNullOrWhiteSpace($DbPath)) {
    $DbPath = Join-Path $root "data\leadscout.db"
  }
  if ([string]::IsNullOrWhiteSpace($BackupDir)) {
    $BackupDir = [Environment]::GetEnvironmentVariable("LEADSCOUT_BACKUP_DIR")
  }
  if ([string]::IsNullOrWhiteSpace($BackupDir)) {
    $BackupDir = Join-Path $root "backups"
  }
  $DbPath = [System.IO.Path]::GetFullPath($DbPath)
  $BackupDir = [System.IO.Path]::GetFullPath($BackupDir)

  if (-not (Test-Path -LiteralPath $DbPath -PathType Leaf)) {
    throw "source database not found: $DbPath"
  }
  if ([IO.Path]::GetFullPath($DbPath) -ieq [IO.Path]::GetFullPath((Join-Path $BackupDir "ignored"))) {
    throw "backup dir must not contain the live database"
  }
  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

  # Timestamp with millisecond precision so the VACUUM INTO target never
  # pre-exists; the counter loop closes any remaining same-millisecond race.
  $stamp = Get-Date -Format "yyyyMMdd-HHmmssfff"
  $target = ""
  $attempt = 0
  while ($true) {
    $suffix = if ($attempt -eq 0) { "" } else { "-$attempt" }
    $candidate = Join-Path $BackupDir ("leadscout-{0}{1}.db" -f $stamp, $suffix)
    if (Test-Path -LiteralPath $candidate) { $attempt++ } else { $target = $candidate; break }
  }

  # VACUUM_SQL_LINE: single-line SQL, placeholder {0} = the ''-escaped target path
  # (kept on exactly one line so deploy/deploy-check.ts can extract and reuse the
  # same statement against a temp database).
  $vacuumSql = "VACUUM INTO '{0}'"
  $sql = $vacuumSql.Replace("{0}", $target.Replace("'", "''"))
  if (-not $sql.StartsWith("VACUUM INTO ")) {
    throw "internal: extracted vacuum statement does not look like VACUUM INTO"
  }

  # Run VACUUM INTO through node:sqlite. The source database is opened
  # read-only; the SQL statement travels via an environment variable, never as
  # a shell-interpolated argument, and the live DB is never written to.
  $nodeScript = "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.env.LEADSCOUT_BACKUP_SOURCE, { readOnly: true }); try { db.exec(process.env.LEADSCOUT_BACKUP_SQL); } finally { try { db.close(); } catch {} }"
  $env:LEADSCOUT_BACKUP_SOURCE = $DbPath
  $env:LEADSCOUT_BACKUP_SQL = $sql
  try {
    & node -e $nodeScript
    if ($LASTEXITCODE -ne 0) {
      throw "node:sqlite VACUUM INTO failed (exit code $LASTEXITCODE)"
    }
  } finally {
    Remove-Item Env:\LEADSCOUT_BACKUP_SOURCE -ErrorAction SilentlyContinue
    Remove-Item Env:\LEADSCOUT_BACKUP_SQL -ErrorAction SilentlyContinue
  }
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    throw "backup target was not created: $target"
  }

  # Retention: only files matching this script's own pattern are candidates for
  # removal; the live database filename (leadscout.db) never matches.
  $pattern = '^leadscout-\d{8}-\d{9}(-\d+)?\.db$'
  $liveResolved = [System.IO.Path]::GetFullPath($DbPath)
  $files = Get-ChildItem -LiteralPath $BackupDir -File |
    Where-Object { $_.Name -match $pattern -and $_.FullName -ine $liveResolved } |
    Sort-Object -Property Name -Descending
  $removed = 0
  for ($i = $Keep; $i -lt $files.Count; $i++) {
    Remove-Item -LiteralPath $files[$i].FullName -Force
    $removed++
  }

  $size = (Get-Item -LiteralPath $target).Length
  Write-Host ("backup OK: {0} -> {1} ({2} bytes); kept {3} newest, removed {4} old" -f $DbPath, $target, $size, [Math]::Min($Keep, $files.Count), $removed)
  exit 0
} catch {
  Write-Error ("backup FAILED: " + $_.Exception.Message)
  exit 1
}
