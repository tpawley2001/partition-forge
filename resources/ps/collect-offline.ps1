param(
    [Parameter(Mandatory)][string]$OutFile,
    [string]$LogDest = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

# Reads back whatever the offline engine left on the EFI system partition after
# the reboot, then clears it so the same result is not reported twice.
$letter = $null
$mounted = $false
try {
    foreach ($c in [char[]]'STUVWXYZ') { if (-not (Test-Path ("{0}:" -f $c))) { $letter = [string]$c; break } }
    if (-not $letter) { throw 'No free drive letter is available to mount the EFI system partition.' }

    & mountvol ("{0}:" -f $letter) /S 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Result -OutFile $OutFile -Data @{ found = $false }; return }
    $mounted = $true

    $dir        = "{0}:\EFI\PartitionForge" -f $letter
    $resultPath = Join-Path $dir 'result.json'
    $jobPath    = Join-Path $dir 'job.json'
    $logPath    = Join-Path $dir 'engine.log'

    if (-not (Test-Path $resultPath)) {
        # A job still sitting there means the engine never ran: the firmware
        # ignored the one-time entry, or the user cancelled the reboot.
        Write-Result -OutFile $OutFile -Data @{
            found       = $false
            jobPending  = (Test-Path $jobPath)
        }
        return
    }

    $payload = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8
    if ($LogDest -and (Test-Path $logPath)) {
        Copy-Item -LiteralPath $logPath -Destination $LogDest -Force -ErrorAction SilentlyContinue
    }

    Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $logPath    -Force -ErrorAction SilentlyContinue

    Write-Result -OutFile $OutFile -Data @{ found = $true; payload = $payload }
} catch {
    Write-Result -OutFile $OutFile -ErrorMessage $_.Exception.Message
} finally {
    if ($mounted) { & mountvol ("{0}:" -f $letter) /D 2>&1 | Out-Null }
}
