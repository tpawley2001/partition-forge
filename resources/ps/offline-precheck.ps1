param(
    [Parameter(Mandatory)][string]$OutFile,
    [string]$EnginePath = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

try {
    $reasons = New-Object System.Collections.ArrayList

    # UEFI vs legacy BIOS. The offline engine is a UEFI application, so a
    # BIOS-booted machine has to use the removable-media route instead.
    $firmware = 'BIOS'
    try {
        $fw = (Get-ComputerInfo -Property BiosFirmwareType -ErrorAction Stop).BiosFirmwareType
        if ($fw) { $firmware = [string]$fw }
    } catch {
        # Fallback that works without the (slow, occasionally broken) Get-ComputerInfo.
        try { if ($env:firmware_type) { $firmware = $env:firmware_type } } catch { }
        if ($firmware -eq 'BIOS' -and (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot')) { $firmware = 'Uefi' }
    }
    $isUefi = $firmware -match 'Uefi'
    if (-not $isUefi) {
        [void]$reasons.Add('This machine booted in legacy BIOS mode. The offline engine is a UEFI application and cannot be launched from the Windows boot menu here; use the bootable USB option instead.')
    }

    # An unsigned engine will be rejected by firmware while Secure Boot is on.
    $secureBoot = $false
    try { $secureBoot = [bool](Confirm-SecureBootUEFI -ErrorAction Stop) } catch { $secureBoot = $false }
    if ($secureBoot) {
        [void]$reasons.Add('Secure Boot is enabled. PartitionForge''s offline engine is not signed by a Microsoft-trusted key, so the firmware will refuse to start it. Turn Secure Boot off in your firmware settings, apply the changes, then turn it back on.')
    }

    # Room on the EFI system partition for the engine image.
    $espFree = 0; $espSize = 0; $espLetter = $null; $espFound = $false
    $jobPending = $false
    $sysPart = Get-Partition | Where-Object { $_.GptType -eq '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}' } | Select-Object -First 1
    if ($sysPart) {
        $espFound = $true
        $espSize = [int64]$sysPart.Size
        # The ESP has no drive letter; mountvol assigns one temporarily.
        $letter = $null
        foreach ($c in [char[]]'STUVWXYZ') {
            if (-not (Test-Path ("{0}:" -f $c))) { $letter = $c; break }
        }
        if ($letter) {
            $mounted = $false
            try {
                & mountvol ("{0}:" -f $letter) /S 2>&1 | Out-Null
                if ($LASTEXITCODE -eq 0) {
                    $mounted = $true
                    $espLetter = [string]$letter
                    $jobPending = Test-Path ("{0}:\EFI\PartitionForge\job.json" -f $letter)
                    if ($jobPending) { [void]$reasons.Add('An offline job is already staged. Finish it before applying another queue.') }
                    $d = Get-PSDrive -Name $letter -ErrorAction SilentlyContinue
                    if ($d) {
                        $espFree = [int64]$d.Free
                    } else {
                        # Get-PSDrive occasionally reports nothing for a freshly
                        # mounted ESP; ask the filesystem directly.
                        $freeOut = & fsutil volume diskfree ("{0}:" -f $letter) 2>&1 | Out-String
                        if ($freeOut -match '(\d[\d,]*)\s+bytes') { $espFree = [int64]($Matches[1] -replace ',', '') }
                    }
                }
            } catch {
            } finally {
                if ($mounted) { & mountvol ("{0}:" -f $letter) /D 2>&1 | Out-Null }
            }
        }
    } else {
        [void]$reasons.Add('No EFI system partition was found on this machine.')
    }

    $engineBytes = 0
    if ($EnginePath -and (Test-Path $EnginePath)) { $engineBytes = (Get-Item $EnginePath).Length }
    if ($engineBytes -le 0) { [void]$reasons.Add('The offline engine image is missing or empty. Build or install pfengine.efi before staging work.') }
    if ($espFound -and $espFree -le 0) { [void]$reasons.Add('Could not verify free space on the EFI system partition. Run as administrator and check the partition.') }

    $needed = $engineBytes + 4MB   # engine + job/result/log headroom
    if ($espFound -and $espFree -gt 0 -and $espFree -lt $needed) {
        [void]$reasons.Add(("The EFI system partition has {0:N0} MB free but the offline engine needs about {1:N0} MB. Free some space on it, or use the bootable USB option." -f ($espFree/1MB), ($needed/1MB)))
    }

    Write-Result -OutFile $OutFile -Data @{
        firmware    = $firmware
        isUefi      = $isUefi
        secureBoot  = $secureBoot
        espFound    = $espFound
        espSize     = $espSize
        espFree     = $espFree
        espLetter   = $espLetter
        engineBytes = $engineBytes
        canStage    = ($reasons.Count -eq 0)
        jobPending  = $jobPending
        reasons     = @($reasons.ToArray())
    }
} catch {
    Write-Result -OutFile $OutFile -ErrorMessage $_.Exception.Message
}
