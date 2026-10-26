param(
    [Parameter(Mandatory)][string]$OutFile,
    [Parameter(Mandatory)][string]$EnginePath,
    [Parameter(Mandatory)][string]$JobPath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

$letter = $null
$mounted = $false

try {
    foreach ($c in [char[]]'STUVWXYZ') { if (-not (Test-Path ("{0}:" -f $c))) { $letter = [string]$c; break } }
    if (-not $letter) { throw 'No free drive letter is available to mount the EFI system partition.' }

    Write-Progress-Line 10 'Mounting the EFI system partition'
    & mountvol ("{0}:" -f $letter) /S 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "mountvol could not mount the EFI system partition (exit $LASTEXITCODE). PartitionForge must run as administrator." }
    $mounted = $true

    $dir = "{0}:\EFI\PartitionForge" -f $letter
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    if (Test-Path (Join-Path $dir 'job.json')) { throw 'An offline job is already staged. Finish that job before staging another.' }

    Write-Progress-Line 30 'Copying the offline engine'
    Copy-Item -LiteralPath $EnginePath -Destination (Join-Path $dir 'pfengine.efi') -Force

    # Any stale result from a previous run would be read back as this run's.
    Remove-Item -LiteralPath (Join-Path $dir 'result.json') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $dir 'engine.log')   -Force -ErrorAction SilentlyContinue

    Write-Progress-Line 50 'Writing the operation list'
    Copy-Item -LiteralPath $JobPath -Destination (Join-Path $dir 'job.json') -Force

    Write-Progress-Line 70 'Registering the boot entry'

    # A previous staging may have left an entry behind; reuse rather than
    # accumulate, so the boot menu does not fill up with duplicates.
    $existing = $null
    $enumOut = & bcdedit /enum FIRMWARE 2>&1 | Out-String
    $blocks = $enumOut -split "(?m)^\s*$"
    foreach ($b in $blocks) {
        if ($b -match 'PartitionForge Offline Engine') {
            if ($b -match '(?m)^identifier\s+(\{[0-9a-fA-F\-]+\})') { $existing = $Matches[1]; break }
        }
    }

    if ($existing) {
        $guid = $existing
    } else {
        $created = & bcdedit /create /d "PartitionForge Offline Engine" /application bootsector 2>&1 | Out-String
        if ($created -notmatch '(\{[0-9a-fA-F\-]+\})') {
            throw "bcdedit did not return an identifier for the new boot entry. Output: $created"
        }
        $guid = $Matches[1]
    }

    & bcdedit /set $guid device ("partition={0}:" -f $letter) 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "bcdedit could not set the boot device for $guid." }
    & bcdedit /set $guid path '\EFI\PartitionForge\pfengine.efi' 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "bcdedit could not set the boot path for $guid." }

    # Publishing it under {fwbootmgr} is what makes the firmware create a real
    # UEFI Boot#### variable for it.
    & bcdedit /set '{fwbootmgr}' displayorder $guid /addlast 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not register the firmware boot entry.' }

    Write-Progress-Line 85 'Arming a one-time boot'
    # bootsequence is the firmware's BootNext: consumed after a single boot, so
    # a failed run cannot leave the machine stuck in the engine.
    & bcdedit /set '{fwbootmgr}' bootsequence $guid 2>&1 | Out-Null
    $armed = ($LASTEXITCODE -eq 0)
    if (-not $armed) {
        throw 'The one-time boot entry could not be armed. Your firmware may not accept boot entries from Windows; use the bootable USB option instead.'
    }

    Write-Progress-Line 100 'Staged'
    Write-Result -OutFile $OutFile -Data @{
        bootEntry = $guid
        espLetter = $letter
        armed     = $armed
    }
} catch {
    Write-Result -OutFile $OutFile -ErrorMessage $_.Exception.Message
} finally {
    if ($mounted) { & mountvol ("{0}:" -f $letter) /D 2>&1 | Out-Null }
}
