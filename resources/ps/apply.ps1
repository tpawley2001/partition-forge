param(
    [Parameter(Mandatory)][string]$OutFile,
    [Parameter(Mandatory)][string]$JobFile
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

function Invoke-Op {
    param($Op)

    $t = $Op.target
    $p = $Op.params

    switch ($Op.kind) {

        'resize' {
            $part = Get-Partition -DiskNumber $t.diskNumber -PartitionNumber $t.partitionNumber -ErrorAction Stop
            $newSize = [int64]$p.newSize
            if ($newSize -lt [int64]$part.Size) {
                # Shrink the filesystem first, then the partition around it.
                Resize-Partition -InputObject $part -Size $newSize -ErrorAction Stop
            } else {
                # Grow the partition into the free space first; the volume
                # cannot extend past the partition boundary, so a single call
                # with the final size would fail.
                Resize-Partition -InputObject $part -Size $newSize -ErrorAction Stop
            }
        }

        'create' {
            $args = @{
                DiskNumber  = [int]$t.diskNumber
                Offset      = [int64]$p.offset
                Size        = [int64]$p.size
                ErrorAction = 'Stop'
            }
            if ($p.gptType) { $args['GptType'] = [string]$p.gptType }
            if ($null -ne $p.mbrType -and [int]$p.mbrType -gt 0) { $args['MbrType'] = [int]$p.mbrType }
            $newPart = New-Partition @args

            if ($p.fileSystem -and $p.fileSystem -ne 'unformatted') {
                Write-Progress-Line 60 "Formatting new partition as $($p.fileSystem)"
                $fmt = @{
                    Partition           = $newPart
                    FileSystem          = [string]$p.fileSystem
                    Confirm             = $false
                    Force               = $true
                    ErrorAction         = 'Stop'
                }
                if ($p.label) { $fmt['NewFileSystemLabel'] = [string]$p.label }
                Format-Volume @fmt | Out-Null
            }
            # Assign the letter last: Format-Volume can transiently lock the volume.
            if ($p.driveLetter) {
                Set-Partition -InputObject $newPart -NewDriveLetter ([string]$p.driveLetter) -ErrorAction Stop
            }
        }

        'delete' {
            Remove-Partition -DiskNumber $t.diskNumber -PartitionNumber $t.partitionNumber `
                             -Confirm:$false -ErrorAction Stop
        }

        'format' {
            $part = Get-Partition -DiskNumber $t.diskNumber -PartitionNumber $t.partitionNumber -ErrorAction Stop
            $fmt = @{
                Partition   = $part
                FileSystem  = [string]$p.fileSystem
                Confirm     = $false
                Force       = $true
                ErrorAction = 'Stop'
            }
            if ($p.label) { $fmt['NewFileSystemLabel'] = [string]$p.label }
            if ($null -ne $p.allocationUnit -and [int]$p.allocationUnit -gt 0) {
                $fmt['AllocationUnitSize'] = [int]$p.allocationUnit
            }
            # A full format zeroes the volume; quick only rewrites metadata.
            if (-not $p.quick) { $fmt['Full'] = $true }
            Format-Volume @fmt | Out-Null
        }

        'label' {
            $part = Get-Partition -DiskNumber $t.diskNumber -PartitionNumber $t.partitionNumber -ErrorAction Stop
            $vol  = $part | Get-Volume -ErrorAction Stop
            Set-Volume -InputObject $vol -NewFileSystemLabel ([string]$p.label) -ErrorAction Stop
        }

        'letter' {
            $part = Get-Partition -DiskNumber $t.diskNumber -PartitionNumber $t.partitionNumber -ErrorAction Stop
            $current = Get-LetterOrNull $part.DriveLetter
            if ($p.driveLetter) {
                Set-Partition -InputObject $part -NewDriveLetter ([string]$p.driveLetter) -ErrorAction Stop
            } elseif ($current) {
                Remove-PartitionAccessPath -DiskNumber $t.diskNumber -PartitionNumber $t.partitionNumber `
                                           -AccessPath ("{0}:\" -f $current) -ErrorAction Stop
            }
        }

        'setActive' {
            Set-Partition -DiskNumber $t.diskNumber -PartitionNumber $t.partitionNumber `
                          -IsActive $true -ErrorAction Stop
        }

        'convertTable' {
            # Online conversion is only legal on a disk with no partitions;
            # anything else is routed to the offline engine by the planner.
            $existing = @(Get-Partition -DiskNumber $t.diskNumber -ErrorAction SilentlyContinue)
            if ($existing.Count -gt 0) {
                throw "Disk $($t.diskNumber) still has $($existing.Count) partition(s); online conversion requires an empty disk."
            }
            $disk = Get-Disk -Number $t.diskNumber -ErrorAction Stop
            if ($disk.PartitionStyle -eq 'RAW') {
                Initialize-Disk -Number $t.diskNumber -PartitionStyle ([string]$p.to) -ErrorAction Stop | Out-Null
            } else {
                Set-Disk -Number $t.diskNumber -PartitionStyle ([string]$p.to) -ErrorAction Stop
            }
        }

        default { throw "Operation '$($Op.kind)' is not executable by the online engine." }
    }
}

try {
    $raw = [System.IO.File]::ReadAllText($JobFile)
    $job = $raw | ConvertFrom-Json
    $ops = @($job.operations)

    $results = New-Object System.Collections.ArrayList
    $i = 0
    $failed = $false

    foreach ($op in $ops) {
        $i++
        $pct = [int](($i - 1) * 100 / [Math]::Max($ops.Count, 1))
        # The "n/total:" prefix lets the host attribute progress to a queue entry.
        Write-Progress-Line $pct ("{0}/{1}: {2}" -f $i, $ops.Count, $op.description)

        if ($failed) {
            [void]$results.Add(@{ id = $op.id; status = 'pending'; error = 'Skipped: an earlier operation failed.' })
            continue
        }

        try {
            Invoke-Op -Op $op
            # Force the partition cache to catch up before the next operation
            # computes offsets against it.
            try { Update-Disk -Number $op.target.diskNumber -ErrorAction SilentlyContinue } catch { }
            [void]$results.Add(@{ id = $op.id; status = 'done'; error = $null })
        } catch {
            $failed = $true
            [void]$results.Add(@{ id = $op.id; status = 'failed'; error = $_.Exception.Message })
        }
    }

    Write-Progress-Line 100 'Finished'
    Write-Result -OutFile $OutFile -Data @{ results = @($results.ToArray()); aborted = $failed }
} catch {
    Write-Result -OutFile $OutFile -ErrorMessage $_.Exception.Message
}
